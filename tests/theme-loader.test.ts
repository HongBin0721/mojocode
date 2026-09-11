import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyTheme,
  BUILTIN_THEME_NAME,
  listThemes,
  loadTheme,
  parseThemeColors,
  themeLocations,
  watchThemeFile,
} from '../src/ui/theme-loader.js';
import { theme } from '../src/ui/theme.js';
import { phaseColor } from '../src/ui/StatusLine.js';
import { extensionTheme } from '../src/core/extension-types.js';
import { sgrForeground } from '../src/core/palette.js';

/**
 * 主题文件(Pi 的 themes):按名字在项目 > 全局 > 贡献目录里找 `<name>.json`,
 * 只收已知色键;找不到 / 坏文件不抛,回落内置配色。theme 对象就地换色。
 */
let home: string;
let root: string;
const original = { ...theme };

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-theme-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-theme-root-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(async () => {
  applyTheme(original);
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

describe('主题文件', () => {
  it('parseThemeColors 只收已知键的非空字符串', () => {
    expect(parseThemeColors({ colors: { accent: ' #123456 ', bogus: 'x', dim: 7, tool: '' } })).toEqual({
      accent: '#123456',
    });
    expect(parseThemeColors({})).toBeUndefined();
    expect(parseThemeColors('nope')).toBeUndefined();
  });

  it('查找顺序:项目 > 全局 > 贡献目录;找不到 not-found,坏 JSON invalid', async () => {
    const extra = path.join(root, 'pkg-themes');
    const [project, global] = themeLocations(root, [extra]);
    for (const dir of [project!, global!, extra]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(global!, 'dusk.json'), JSON.stringify({ colors: { accent: 'global' } }));
    await fs.writeFile(path.join(extra, 'dusk.json'), JSON.stringify({ colors: { accent: 'pkg' } }));
    await fs.writeFile(path.join(extra, 'only-pkg.json'), JSON.stringify({ colors: { accent: 'pkg2' } }));
    await fs.writeFile(path.join(project!, 'broken.json'), '{ not json');
    await fs.writeFile(path.join(project!, 'nocolors.json'), '{"name":"x"}');

    const dirs = themeLocations(root, [extra]);
    expect(await loadTheme('dusk', dirs)).toMatchObject({ ok: true, theme: { name: 'dusk', colors: { accent: 'global' } } });
    expect(await loadTheme('only-pkg', dirs)).toMatchObject({ ok: true, theme: { colors: { accent: 'pkg2' } } });
    expect(await loadTheme('nope', dirs)).toEqual({ ok: false, reason: 'not-found' });
    expect(await loadTheme('broken', dirs)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await loadTheme('nocolors', dirs)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('applyTheme 就地换色:给了的键取主题值,没给的键回到内置配色,返回改动数', () => {
    expect(applyTheme({ accent: '#abcdef', dim: theme.dim })).toBe(1);
    expect(theme.accent).toBe('#abcdef');
    expect(theme.user).toBe(original.user);
    // 换到一个不设 accent 的主题:上一个主题的 accent 不能漏过来(运行期
    // /theme 反复切换就靠这一条),空对象则整张表回到内置配色。
    expect(applyTheme({ tool: '#9ece6a' })).toBe(2);
    expect(theme.accent).toBe(original.accent);
    expect(theme.tool).toBe('#9ece6a');
    expect(applyTheme({})).toBe(1);
    expect(theme).toEqual(original);
  });

  it('listThemes:按目录优先级去重、不解析文件、不列保留名 default', async () => {
    const extra = path.join(root, 'pkg-themes');
    const [project, global] = themeLocations(root, [extra]);
    for (const dir of [project!, global!, extra]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(project!, 'dusk.json'), '{ not json');
    await fs.writeFile(path.join(global!, 'dusk.json'), JSON.stringify({ colors: {} }));
    await fs.writeFile(path.join(global!, `${BUILTIN_THEME_NAME}.json`), JSON.stringify({ colors: {} }));
    await fs.writeFile(path.join(global!, 'notes.txt'), '');
    await fs.writeFile(path.join(extra, 'dawn.json'), JSON.stringify({ colors: {} }));

    expect(await listThemes(themeLocations(root, [extra, path.join(root, 'missing')]))).toEqual([
      { name: 'dusk', file: path.join(project!, 'dusk.json') },
      { name: 'dawn', file: path.join(extra, 'dawn.json') },
    ]);
  });

  it('watchThemeFile:文件改了回调,目录不存在静默放弃', async () => {
    // 真 fs.watch + 真时钟:内核事件不受假定时器驱动,只能等真实回调。
    // macOS 的 FSEvents 流是异步建起来的,紧跟 watch() 的第一笔写可能落在
    // 流注册之前而没有事件——把写放进重试里,直到有回调为止。
    const dir = path.join(root, 'themes');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'dusk.json');
    await fs.writeFile(file, '{}');
    let calls = 0;
    const stop = watchThemeFile(file, () => {
      calls += 1;
    });
    await vi.waitFor(
      async () => {
        await fs.writeFile(file, `{"colors":{"accent":"${calls}"}}`);
        expect(calls).toBeGreaterThan(0);
      },
      { timeout: 3000, interval: 150 },
    );
    stop();

    expect(() => watchThemeFile(path.join(root, 'missing', 'x.json'), () => {})()).not.toThrow();
  });

  it('sgrForeground:命名色查表,#rgb / #rrggbb 走真彩色,不认识的退回默认前景', () => {
    expect(sgrForeground('cyan')).toBe('36');
    expect(sgrForeground(' Gray ')).toBe('90');
    expect(sgrForeground('#1e4023')).toBe('38;2;30;64;35');
    expect(sgrForeground('#abc')).toBe('38;2;170;187;204');
    expect(sgrForeground('chartreuse')).toBe('39');
  });

  it('换色也打到扩展拿到的 ExtensionTheme 上——配色表只有一张', () => {
    // 回归:两张表时,换了主题只有 TUI 自己的边框与文字变色,扩展画的行、
    // 工具的 renderResult、整段回滚转储全是内置色。
    expect(extensionTheme.fg('accent', 'x')).toBe('\x1b[36mx\x1b[39m');
    applyTheme({ accent: '#7aa2f7' });
    expect(extensionTheme.fg('accent', 'x')).toBe('\x1b[38;2;122;162;247mx\x1b[39m');
    // text 没有对应的配色键,照旧是终端默认前景。
    expect(extensionTheme.fg('text', 'x')).toBe('\x1b[39mx\x1b[39m');
  });

  it('换色打得到状态线的阶段色上——phaseColor 现读 theme,不是模块级快照', () => {
    // 这一条是回归:StatusLine 曾把 `{ responding: theme.accent }` 做成模块级
    // 常量表,而本模块在 applyTheme 跑之前就被 import 了,于是换了主题满屏
    // 变色、只有工作状态线还是内置的 cyan。
    expect(phaseColor('responding')).toBe(original.accent);
    applyTheme({ accent: '#7aa2f7', tool: '#9ece6a' });
    expect(phaseColor('responding')).toBe('#7aa2f7');
    expect(phaseColor('compacting')).toBe('#7aa2f7');
    expect(phaseColor('tool')).toBe('#9ece6a');
    // magenta 不在可换色键里,照旧是字面量。
    expect(phaseColor('thinking')).toBe('magenta');
  });
});
