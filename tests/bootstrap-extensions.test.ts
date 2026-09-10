import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { bootstrap, type Session } from '../src/app/bootstrap.js';
import { loadConfig } from '../src/config/load.js';
import { BUILTIN_EXTENSIONS } from '../src/extensions/index.js';

/**
 * **真的 bootstrap 一次,装上真的一方扩展。**
 *
 * 这个文件的存在是因为一次真实的线上崩溃:`exit_plan` 从内置工具搬进权限
 * 扩展之后,`BUILTIN_TOOL_NAMES` 那张「扩展不得覆盖的内置工具名」黑名单
 * 没跟着删掉它,于是权限扩展一注册就撞上自己 —— `mojocode` 一启动 server
 * 就 exit 1。全套测试当时是绿的:每个扩展的测试都拿 `fakeExtensionApi`
 * 单测,没有一处把「真 bootstrap × 真扩展表」这条装配线跑通过,而
 * `--version` 那种冒烟根本不建会话。
 *
 * 所以这里不测任何扩展的行为(那是各自的测试文件的事),只测**装配本身
 * 不炸**,外加几条公开可观察的接线事实。新增一方扩展时它自动覆盖。
 *
 * 覆盖边界要说清楚:`Agent` 没有公开的工具集读口(`tools` 在它的私有
 * options 里,与扩展就地共享同一个引用),所以"扩展工具真的挂上了"这件事
 * 这里断言不到——它由 `beforeAll` 里 bootstrap **没有抛异常**兜住,而那正是
 * 上面那次崩溃的形态(registerTool 撞黑名单直接 throw)。不为了这一条测试
 * 去开一个新的公开面。
 */

let home: string;
let root: string;
let session: Session;
let savedHome: string | undefined;

beforeAll(async () => {
  // 独立 HOME:会话写在 ~/.mojocode/sessions/ 下,绝不能碰开发者的真配置。
  // **必须改 process.env.HOME**,不能只给 loadConfig 传 env——后者只管配置
  // 分层,而 SessionStore.create / imagesDir 走的是 paths.ts 的 homeDir(),
  // 它读的就是 process.env.HOME。少了这一行,每跑一次测试就往开发者(和 CI)
  // 的真实 ~/.mojocode/sessions/ 里追加一个会话 JSONL + meta。
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-bootstrap-home-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-bootstrap-root-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'a\n');

  const loaded = await loadConfig({
    root,
    env: {
      HOME: home,
      MOJOCODE_PROVIDER: 'deepseek',
      MOJOCODE_MODEL: 'deepseek-chat',
      DEEPSEEK_API_KEY: 'test-key-not-used',
    },
  });
  session = await bootstrap({ root, loaded });
});

afterAll(async () => {
  await session?.dispose?.();
  process.env.HOME = savedHome;
  for (const dir of [home, root]) await fs.rm(dir, { recursive: true, force: true });
});

describe('bootstrap × 一方扩展(真实装配)', () => {
  it('全部一方扩展装得上,没有一个在 setup 里抛出', () => {
    // 装不上的话 beforeAll 已经炸了;这里把「装了几个」也钉住,免得
    // BUILTIN_EXTENSIONS 被误删一项而无人察觉。
    expect(BUILTIN_EXTENSIONS.map((e) => e.id)).toEqual([
      'goal',
      'lsp',
      'mcp',
      'review',
      'todo',
      'web',
    ]);
  });

  it('扩展注册的命令与快捷键出现在命令表里', () => {
    const names = session.extensionCommands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['goal', 'mcp', 'review']));
    // /review 带取值选择器(多级),/goal 不带。
    expect(session.extensionCommands.find((c) => c.name === 'review')?.hasOptions).toBe(true);
    // 一方扩展目前没有注册快捷键(权限档位的 shift+tab 随权限系统一起去掉了)。
  });


  it('disabledExtensions 按 id 跳过加载(--no-mcp 走的就是这条路)', async () => {
    const loaded = await loadConfig({
      root,
      env: {
        HOME: home,
        MOJOCODE_PROVIDER: 'deepseek',
        MOJOCODE_MODEL: 'deepseek-chat',
        DEEPSEEK_API_KEY: 'test-key-not-used',
      },
    });
    const bare = await bootstrap({
      root,
      loaded,
      disabledExtensions: ['review', 'mcp'],
    });
    try {
      const names = bare.extensionCommands.map((c) => c.name);
      expect(names).not.toContain('review');
      expect(names).not.toContain('mcp');
      // 没被禁的照常在。
      expect(names).toEqual(expect.arrayContaining(['goal']));
    } finally {
      await bare.dispose?.();
    }
  });
});
