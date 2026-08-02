import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { render } from 'ink-testing-library';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/ui/App.js';
import { stubGoal } from './support/goal.js';
import { EventBus } from '../src/core/events.js';
import type { Session } from '../src/app/bootstrap.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * 提交链路的 @文件引用展开:发给模型的是附上文件内容的展开版,时间线与
 * display 保留原文;运行中提交走 inject;失效引用只提示不阻塞。
 */
let root: string;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-app-attach-'));
  await fs.writeFile(path.join(root, 'hello.ts'), 'export const hi = 1;\n');
  await fs.writeFile(path.join(root, 'img.png'), PNG_BYTES);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function setup(options?: { isRunning?: boolean }) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const runCalls: [string, { display?: string; images?: unknown[] } | undefined][] = [];
  const injected: [string, unknown[] | undefined][] = [];
  // App 的提交路径经 goal.run,目标未激活时它原样透传到 agent.run——桩里
  // 两处共用同一个实现,断言 runCalls 与真实链路一致。
  const run = async (text: string, runOptions?: { display?: string; images?: unknown[] }) => {
    runCalls.push([text, runOptions]);
    bus.emit({ type: 'turn-start', userText: text, display: runOptions?.display });
  };
  const session = {
    root,
    config: {
      sandbox: 'workspace-write',
      approval: 'untrusted',
      plan: false,
      statusBar: [],
      permissions: { denyPath: [] },
    },
    provider,
    agent: {
      isRunning: options?.isRunning ?? false,
      inject: (text: string, images?: unknown[]) => {
        if (!options?.isRunning) return false;
        injected.push([text, images]);
        return true;
      },
      run,
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(run),
    mcpStatuses: [],
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;

  const view = render(<App session={session} />);
  return { bus, runCalls, injected, ...view };
}

describe('提交时展开 @文件引用', () => {
  it('run 收到展开文本与原文 display,时间线不出现文件内容', async () => {
    const { runCalls, stdin, frames, unmount } = setup();
    await tick();

    // 尾部空格让文件菜单关闭,回车才是提交而不是插入候选。
    stdin.write('看 @hello.ts ');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(runCalls).toHaveLength(1);
    const [text, options] = runCalls[0]!;
    expect(text).toContain('<file path="hello.ts">');
    expect(text).toContain('export const hi = 1;');
    expect(options).toEqual({ display: '看 @hello.ts' });
    // 时间线(turn-start 渲染的 user 条目)只显示原文。
    expect(frames.join('\n')).not.toContain('export const hi');
    unmount();
  });

  it('无 @ 引用时按原文提交,不带 display', async () => {
    const { runCalls, stdin, unmount } = setup();
    await tick();

    stdin.write('普通消息');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(runCalls).toEqual([['普通消息', undefined]]);
    unmount();
  });

  it('运行中提交 → 展开后注入,时间线显示原文', async () => {
    const { runCalls, injected, stdin, frames, unmount } = setup({ isRunning: true });
    await tick();

    stdin.write('补充 @hello.ts ');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(runCalls).toHaveLength(0);
    expect(injected).toHaveLength(1);
    expect(injected[0]![0]).toContain('<file path="hello.ts">');
    const output = frames.join('\n');
    expect(output).toContain('补充 @hello.ts');
    expect(output).not.toContain('export const hi');
    unmount();
  });

  it('@图片引用:文本原样、图片进 options.images', async () => {
    const { runCalls, stdin, unmount } = setup();
    await tick();

    stdin.write('看图 @img.png ');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(runCalls).toHaveLength(1);
    const [text, options] = runCalls[0]!;
    expect(text).toBe('看图 @img.png');
    expect(options?.display).toBeUndefined();
    expect(options?.images).toEqual([
      { mediaType: 'image/png', data: PNG_BYTES.toString('base64'), filename: 'img.png' },
    ]);
    unmount();
  });

  it('运行中提交 @图片 → 注入时携带图片', async () => {
    const { injected, stdin, unmount } = setup({ isRunning: true });
    await tick();

    stdin.write('看 @img.png ');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(injected).toHaveLength(1);
    expect(injected[0]![0]).toBe('看 @img.png');
    expect(injected[0]![1]).toHaveLength(1);
    unmount();
  });

  // 孤立的 not found 多半是 `@types/node`、`@某人` 这类普通行文,不报警;
  // 但只要这条消息里确有引用成功解析,打错的路径就值得提示。
  it('无任何引用解析成功时,失效引用静默按原文发送', async () => {
    const { runCalls, stdin, frames, unmount } = setup();
    await tick();

    stdin.write('看 @missing.ts ');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(runCalls).toEqual([['看 @missing.ts', undefined]]);
    expect(frames.join('\n')).not.toContain('not found');
    unmount();
  });

  it('有引用解析成功时,同一条里打错的路径会提示', async () => {
    const { runCalls, stdin, frames, unmount } = setup();
    await tick();

    stdin.write('看 @hello.ts 和 @missing.ts ');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(runCalls).toHaveLength(1);
    expect(frames.join('\n')).toContain('@missing.ts (not found)');
    unmount();
  });
});
