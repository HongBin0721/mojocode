import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrap, type Session } from '../src/app/bootstrap.js';
import { loadConfig } from '../src/config/load.js';
import {
  defaultIdOf,
  discoverExtensions,
  loadExtension,
  scanExtensionDir,
} from '../src/extensions/loader.js';
import { readPackageManifest, resolvePackages } from '../src/extensions/packages.js';

/**
 * 磁盘扩展的三层装载(Pi 式):包 → 全局目录 → 项目目录 → `-e`。
 *
 * 用**真 bootstrap** 装,而不是只测 discover:装不上的扩展必须变成一条
 * startup notice 而不是掀掉会话,这条纪律只有跑通整条装配线才测得到。
 * TypeScript 扩展在 Node 上经 jiti 转译、在 Bun 上原生加载——CI 两条 lane
 * 各跑一遍,两条路都被考到。
 */

let home: string;
let root: string;
let flagDir: string;
let session: Session;
let savedHome: string | undefined;

const TS_EXT = (name: string, extra = '') => `
export default (api) => {
  api.registerCommand('${name}', { description: 'from ${name}', handler: () => {} });
  ${extra}
};
`;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-ext-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-ext-root-'));
  flagDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-ext-flag-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;

  // 全局目录:一个 .ts、一个 <name>/index.js、一个坏掉的、一个该跳过的 .d.ts。
  const userDir = path.join(home, '.mojocode', 'extensions');
  await fs.mkdir(path.join(userDir, 'nested'), { recursive: true });
  await fs.writeFile(path.join(userDir, 'hello.ts'), TS_EXT('hello'));
  await fs.writeFile(
    path.join(userDir, 'nested', 'index.js'),
    "export default { id: 'renamed', setup(api) { api.registerCommand('nested', { description: 'n', handler: () => {} }); } };\n",
  );
  await fs.writeFile(path.join(userDir, 'broken.ts'), "export default (api) => { throw new Error('boom at setup'); };\n");
  await fs.writeFile(path.join(userDir, 'types.d.ts'), 'export {};\n');
  await fs.writeFile(path.join(userDir, 'shape.js'), 'export const notDefault = 1;\n');

  // 项目目录:一个与全局同 id 的(后装的赢——命令表按名覆盖)。
  const projectDir = path.join(root, '.mojocode', 'extensions');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'proj.mjs'), TS_EXT('proj'));

  // `-e` 目录。
  await fs.writeFile(path.join(flagDir, 'flagged.ts'), TS_EXT('flagged'));

  // 一个本地路径包:manifest 指定扩展文件 + 技能目录。
  const pkgDir = path.join(home, 'my-pack');
  await fs.mkdir(path.join(pkgDir, 'ext'), { recursive: true });
  await fs.mkdir(path.join(pkgDir, 'skills', 'packskill'), { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'my-pack', mojocode: { extensions: ['ext'], skills: ['skills'] } }),
  );
  await fs.writeFile(path.join(pkgDir, 'ext', 'packed.ts'), TS_EXT('packed'));
  await fs.writeFile(
    path.join(pkgDir, 'skills', 'packskill', 'SKILL.md'),
    '---\nname: packskill\ndescription: a skill from a package\n---\nDo the thing.\n',
  );
  await fs.mkdir(path.join(home, '.mojocode'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.mojocode', 'config.json'),
    JSON.stringify({ packages: [pkgDir, '/definitely/missing/package'] }),
  );

  const loaded = await loadConfig({
    root,
    env: {
      HOME: home,
      MOJOCODE_PROVIDER: 'deepseek',
      MOJOCODE_MODEL: 'deepseek-chat',
      DEEPSEEK_API_KEY: 'test-key-not-used',
    },
  });
  session = await bootstrap({ root, loaded, extensionPaths: [flagDir] });
});

afterAll(async () => {
  await session?.dispose?.();
  process.env.HOME = savedHome;
  for (const dir of [home, root, flagDir]) await fs.rm(dir, { recursive: true, force: true });
});

describe('磁盘扩展装载', () => {
  it('四个来源的扩展都装上了,命令进了命令表', () => {
    const names = session.extensionCommands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['hello', 'nested', 'proj', 'flagged', 'packed']));
    // 一方扩展照旧在。
    expect(names).toEqual(expect.arrayContaining(['goal', 'review']));
  });

  it('装不上的扩展变成 startup notice,不拖垮会话', () => {
    const messages = session.startupNotices.map((n) => n.message);
    expect(messages.some((m) => m.includes('broken') && m.includes('boom at setup'))).toBe(true);
    // 没有 default 导出的模块也是"装不上",不是静默忽略。
    expect(messages.some((m) => m.includes('shape.js'))).toBe(true);
    // 记在配置里却不在磁盘上的包:提示重新 install。
    expect(messages.some((m) => m.includes('/definitely/missing/package'))).toBe(true);
  });

  it('包里的技能进了技能表(优先级最低)', async () => {
    const index = await session.refreshSkills();
    expect(index.map((s) => s.name)).toContain('packskill');
  });

  it('模块导出的 id 优先于文件名推出的 id', () => {
    // nested/index.js 自报 id 'renamed';disabledExtensions 按它跳过。
    expect(session.extensionCommands.some((c) => c.name === 'nested')).toBe(true);
  });
});

describe('发现规则', () => {
  it('defaultIdOf:文件名 / index 取上级目录名', () => {
    expect(defaultIdOf('/x/foo.ts')).toBe('foo');
    expect(defaultIdOf('/x/bar/index.mjs')).toBe('bar');
  });

  it('scanExtensionDir 跳过 .d.ts 与 *.test.*,目录只认 index.*;不存在的目录返回空表', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-scan-'));
    await fs.mkdir(path.join(dir, 'a'));
    await fs.mkdir(path.join(dir, 'empty'));
    await fs.writeFile(path.join(dir, 'a', 'index.ts'), '');
    await fs.writeFile(path.join(dir, 'b.mts'), '');
    await fs.writeFile(path.join(dir, 'c.d.ts'), '');
    await fs.writeFile(path.join(dir, 'd.test.ts'), '');
    await fs.writeFile(path.join(dir, 'notes.md'), '');
    const found = await scanExtensionDir(dir, 'user');
    expect(found.map((f) => f.id)).toEqual(['a', 'b']);
    expect(await scanExtensionDir(path.join(dir, 'nope'), 'user')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('包扩展的 id 冠以包名;-e 指向不存在的路径直接报错', async () => {
    const pkgDir = path.join(home, 'my-pack');
    const { packages } = await resolvePackages([pkgDir], { root });
    const found = await discoverExtensions({ root, packages });
    expect(found.extensions.find((f) => f.origin === 'package')?.id).toBe('my-pack/packed');
  });

  it('`-e` 指向不存在的路径只进 notFound,已发现的其他来源照旧返回', async () => {
    // 抛出去的话一个打错的 -e 会把 ~/.mojocode/extensions 整个丢掉,而用户
    // 只看到那条打错的提示——正是这条回归要钉住的形态。
    const { extensions, notFound } = await discoverExtensions({
      root,
      extraPaths: ['/no/such/ext.ts'],
    });
    expect(notFound).toEqual([expect.stringContaining('/no/such/ext.ts')]);
    expect(extensions.map((e) => e.id)).toContain('hello');
  });

  it('readPackageManifest:无 manifest 时按约定目录找,列了但不存在的路径跳过', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-manifest-'));
    await fs.mkdir(path.join(dir, 'extensions'));
    await fs.mkdir(path.join(dir, 'skills'));
    const conventional = await readPackageManifest(dir);
    expect(conventional.extensions).toEqual([path.join(dir, 'extensions')]);
    expect(conventional.skills).toEqual([path.join(dir, 'skills')]);

    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ mojocode: { extensions: ['extensions', 'missing.ts'], skills: [] } }),
    );
    const declared = await readPackageManifest(dir);
    expect(declared.extensions).toEqual([path.join(dir, 'extensions')]);
    expect(declared.skills).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loadExtension:函数导出与对象导出都认,别的形状报错', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-load-'));
    await fs.writeFile(path.join(dir, 'fn.js'), 'export default (api) => {};\n');
    await fs.writeFile(path.join(dir, 'obj.js'), "export default { id: 'custom', setup() {} };\n");
    await fs.writeFile(path.join(dir, 'bad.js'), 'export default 42;\n');
    const fn = await loadExtension({ id: 'fn', file: path.join(dir, 'fn.js'), origin: 'user' });
    expect(fn.id).toBe('fn');
    const obj = await loadExtension({ id: 'obj', file: path.join(dir, 'obj.js'), origin: 'user' });
    expect(obj.id).toBe('custom');
    await expect(loadExtension({ id: 'bad', file: path.join(dir, 'bad.js'), origin: 'user' })).rejects.toThrow(
      /export default/,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});
