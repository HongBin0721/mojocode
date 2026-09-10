import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import type { ToolScope } from '../src/core/extension.js';
import type { SessionCustomRecord } from '../src/session/store.js';
import { todoExtension, TODO_ENTRY, TODO_STATE_KEY } from '../src/extensions/todo/index.js';
import { parseTodos, type TodoItem } from '../src/ui/timeline-data.js';
import { recordingExtensionApi } from './support/extension-api.js';

/**
 * todo 扩展:清单同时是**模型的工具**与**用户的进度面板**,所以它既要
 * setState 推给客户端、又要 appendEntry 落盘。这组测试锁住三件搬家时最容易
 * 接错的事:发布与落盘同步、恢复不回写、子 agent 拿不到这个工具。
 */

const MAIN: ToolScope = { subagent: false };

function makeHost(seed: SessionCustomRecord[] = []) {
  const host = recordingExtensionApi({ id: 'todo' }, { entries: [...seed] });
  // 预置的那些是"恢复出来的",不算这次会话新落盘的——恢复不回写正是下面
  // 要锁的事,所以 appended 从预置之后数起。
  const seeded = seed.length;
  todoExtension.setup(host.api);

  const call = async (todos: TodoItem[]) => {
    const tool = host.tools.get('todo')!(MAIN) as Tool & {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };
    return tool.execute({ todos }, { toolCallId: 'c1' });
  };
  return {
    ...host,
    call,
    published: () => host.state.get(TODO_STATE_KEY),
    get appended() {
      return host.entries.slice(seeded).map(({ type, data }) => ({ type, data }));
    },
  };
}

const LIST: TodoItem[] = [
  { content: '写测试', status: 'completed' },
  { content: '跑测试', status: 'in_progress' },
];

beforeEach(() => vi.clearAllMocks());

describe('todo 扩展', () => {
  it('调用工具:清单同时发布给客户端与落盘,结果里报完成数', async () => {
    const host = makeHost();
    const out = await host.call(LIST);

    expect(out).toEqual({ ok: true, total: 2, completed: 1 });
    expect(host.published()).toEqual(LIST);
    expect(host.appended).toEqual([{ type: TODO_ENTRY, data: LIST }]);
  });

  it('空清单照样发布:/new 之后面板要立刻空掉,而不是留着上一段的进度', async () => {
    const host = makeHost();
    await host.call(LIST);
    await host.call([]);
    expect(host.published()).toEqual([]);
  });

  it('session_start 从会话记录恢复最后一份清单,且不把它再写回去', async () => {
    const host = makeHost([
      { type: TODO_ENTRY, data: [{ content: '旧的', status: 'pending' }], at: 'x' },
      { type: TODO_ENTRY, data: LIST, at: 'y' },
    ]);
    await host.hooks.sessionStart({ reason: 'resume' });

    expect(host.published()).toEqual(LIST);
    // 恢复出来的东西属于这个会话的记录本身,再 append 一遍只是把它抄两份。
    expect(host.appended).toEqual([]);
  });

  it('没有记录(新会话)时发布空清单,面板不残留', async () => {
    const host = makeHost();
    await host.hooks.sessionStart({ reason: 'new' });
    expect(host.published()).toEqual([]);
  });

  it('记录形状不对(旧格式、别的实现)当作没有,不炸', async () => {
    const host = makeHost([{ type: TODO_ENTRY, data: { nope: 1 }, at: 'x' }]);
    await host.hooks.sessionStart({ reason: 'startup' });
    expect(host.published()).toEqual([]);
  });

  it('子 agent 拿不到 todo 工具:清单是主对话的进度面板', () => {
    const host = makeHost();
    const factory = host.tools.get('todo')!;
    expect(factory(MAIN)).toBeDefined();
    expect(factory({ subagent: true, mode: 'general' })).toBeUndefined();
    expect(factory({ subagent: true, mode: 'explore' })).toBeUndefined();
  });
});

describe('parseTodos(客户端读快照的边界)', () => {
  it('认得出合法清单', () => {
    expect(parseTodos(LIST)).toEqual(LIST);
    expect(parseTodos([])).toEqual([]);
  });

  it('形状不对一律 undefined——扩展没装、换了实现时面板各自消失即可', () => {
    expect(parseTodos(undefined)).toBeUndefined();
    expect(parseTodos({ todos: LIST })).toBeUndefined();
    expect(parseTodos([{ content: 'x', status: 'bogus' }])).toBeUndefined();
    expect(parseTodos([{ content: 1, status: 'pending' }])).toBeUndefined();
    // 一项坏掉就整份不认:半份清单比没有更误导。
    expect(parseTodos([LIST[0]!, { content: 'x' }])).toBeUndefined();
  });
});
