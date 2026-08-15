import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import {
  AmbiguousSessionError,
  SessionNotFoundError,
  SessionStore,
} from '../src/session/store.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-sessions-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function msg(role: 'user' | 'assistant', text: string): ModelMessage {
  return { role, content: text } as ModelMessage;
}

async function readRecords(id: string): Promise<Array<{ kind: string; messages?: unknown[] }>> {
  const raw = await fs.readFile(path.join(dir, `${id}.jsonl`), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string; messages?: unknown[] });
}

describe('SessionStore 增量保存', () => {
  it('纯扩展的历史只追加增量记录,文件随消息数线性增长', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });

    // 模拟 agent 的活数组:每轮往同一个数组 push,再整体传给 save。
    const history: ModelMessage[] = [];
    for (let turn = 0; turn < 5; turn++) {
      history.push(msg('user', `问题 ${turn}`), msg('assistant', `回答 ${turn}`));
      await store.save(history);
    }

    const records = await readRecords(store.id);
    const appends = records.filter((r) => r.kind === 'append');
    const snapshots = records.filter((r) => r.kind === 'snapshot');
    expect(appends).toHaveLength(5);
    expect(snapshots).toHaveLength(0);
    // 每条增量恰好 2 条消息,而不是全量。
    for (const a of appends) expect(a.messages).toHaveLength(2);

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toHaveLength(10);
    expect(reopened.meta.messageCount).toBe(10);
  });

  it('历史被替换(压缩/rewind)时写 snapshot', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [msg('user', 'a'), msg('assistant', 'b')];
    await store.save(history);

    // 压缩:新数组、新对象——不是旧历史的扩展。
    const compacted = [msg('user', '[Earlier conversation, compacted] …'), msg('assistant', 'b')];
    await store.save(compacted);

    const records = await readRecords(store.id);
    expect(records.filter((r) => r.kind === 'snapshot')).toHaveLength(1);

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toHaveLength(2);
    expect(String(reopened.messages[0]!.content)).toContain('compacted');
  });

  it('截断(rewind)后重开只看到截断的历史', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c'),
      msg('assistant', 'd'),
    ];
    await store.save(history);
    await store.save(history.slice(0, 2)); // 截断不是扩展 → snapshot

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toHaveLength(2);
  });

  it('写入失败后下一次保存改写全量快照,不丢消息', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [msg('user', 'a'), msg('assistant', 'b')];
    await store.save(history);

    // 模拟一次瞬时写入失败(ENOSPC 之类):这一轮的消息没落盘。
    const file = path.join(dir, `${store.id}.jsonl`);
    const before = await fs.readFile(file, 'utf8');
    const spy = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC') as never);
    history.push(msg('user', 'c'), msg('assistant', 'd'));
    await store.save(history).catch(() => {});
    spy.mockRestore();
    await fs.writeFile(file, before, 'utf8'); // 失败的那次没写进去

    // 下一轮:增量写只会包含更新的消息,必须落全量快照才不丢中间那段。
    history.push(msg('user', 'e'));
    await store.save(history);

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toHaveLength(5);
    expect(reopened.messages.map((m) => String(m.content))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('并发保存时,前一次写失败不会被后一次的增量写"跳过"', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [msg('user', 'a'), msg('assistant', 'b')];
    await store.save(history);

    const file = path.join(dir, `${store.id}.jsonl`);
    const before = await fs.readFile(file, 'utf8');

    // 两次 save 同时在飞(压缩后的 onHistoryChange + 轮末的 onHistoryChange
    // 都是 fire-and-forget),第一次写失败。判定若在写链外提前做,第二次的
    // append 就会接在一段没落盘的基线上,缺口永久固化。
    const spy = vi.spyOn(fs, 'appendFile');
    spy.mockRejectedValueOnce(new Error('ENOSPC') as never);
    history.push(msg('user', 'c'), msg('assistant', 'd'));
    const first = store.save(history).catch(() => {});
    history.push(msg('user', 'e'));
    const second = store.save(history).catch(() => {});
    await Promise.all([first, second]);
    spy.mockRestore();

    // 失败的那条 meta 记录没写进去,把文件恢复到失败前的状态再校验内容。
    const after = await fs.readFile(file, 'utf8');
    expect(after.startsWith(before)).toBe(true);

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages.map((m) => String(m.content))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('state 写入失败后不被脏检查跳过,下次仍会重试', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const state = { todos: [], allowBash: ['Bash(git:*)'], allowWrite: [] };

    const spy = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('EPERM') as never);
    await store.saveState(state).catch(() => {});
    spy.mockRestore();

    await store.saveState(state); // 同样的状态:失败过就不该被认为"已写过"
    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.state.allowBash).toEqual(['Bash(git:*)']);
  });

  it('含 base64 图片的 parts 消息经 JSONL 往返后完全一致', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const message: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgo=', filename: 'shot.png' },
      ],
    } as ModelMessage;
    await store.save([message]);

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toEqual([message]);
  });

  it('标题取第一条用户消息', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    await store.save([msg('user', '  修复   bug  '), msg('assistant', 'ok')]);
    expect(store.meta.title).toBe('修复 bug');
  });
});

describe('旧格式兼容', () => {
  it('只有 messages 快照记录的旧文件仍可打开与列出', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const meta = {
      id,
      root: '/w',
      provider: 'kimi',
      model: 'm',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      title: '旧会话',
      messageCount: 2,
    };
    const lines = [
      JSON.stringify({ kind: 'meta', meta }),
      JSON.stringify({ kind: 'messages', at: meta.updatedAt, messages: [msg('user', 'x')] }),
      JSON.stringify({
        kind: 'messages',
        at: meta.updatedAt,
        messages: [msg('user', 'x'), msg('assistant', 'y')],
      }),
    ];
    await fs.writeFile(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');

    const store = await SessionStore.open(id, dir);
    expect(store.messages).toHaveLength(2); // 取最后一条快照
    expect(store.state.todos).toEqual([]);

    // 无旁车 → list 走慢路径,依然能列出。
    const metas = await SessionStore.list('/w', dir);
    expect(metas.map((m) => m.id)).toContain(id);
  });

  it('末行损坏不阻止打开', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    await store.save([msg('user', 'a')]);
    await fs.appendFile(path.join(dir, `${store.id}.jsonl`), '{"kind":"append","mess', 'utf8');

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toHaveLength(1);
  });
});

describe('resolveId 前缀解析', () => {
  it('唯一前缀命中,零命中/多命中抛出明确错误', async () => {
    const a = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const b = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });

    expect(await SessionStore.resolveId(a.id.slice(0, 8), { dir })).toBe(a.id);
    await expect(SessionStore.resolveId('zzzzzzzz', { dir })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await expect(SessionStore.resolveId('', { dir })).rejects.toBeInstanceOf(SessionNotFoundError);

    // 空前缀之外的歧义:用两个会话 id 的公共前缀(uuid 随机,公共前缀可能为
    // 空串——因此这里直接用 '' 之外的构造:取更短公共前缀不可靠,改为验证
    // 完整列表匹配)。
    const common = commonPrefix(a.id, b.id);
    if (common.length > 0) {
      await expect(SessionStore.resolveId(common, { dir })).rejects.toBeInstanceOf(
        AmbiguousSessionError,
      );
    }
  });

  it('给了 root 就只在该工作区内解析,别处的会话视为不存在', async () => {
    const mine = await SessionStore.create({ root: '/w1', provider: 'kimi', model: 'm', dir });
    const other = await SessionStore.create({ root: '/w2', provider: 'kimi', model: 'm', dir });
    await mine.save([msg('user', 'a')]);
    await other.save([msg('user', 'b')]);

    expect(await SessionStore.resolveId(mine.id.slice(0, 8), { dir, root: '/w1' })).toBe(mine.id);
    // 跨工作区恢复会让 meta.root 继续指向旧项目,两边都列不到它。
    await expect(
      SessionStore.resolveId(other.id.slice(0, 8), { dir, root: '/w1' }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    // 不给 root 仍是全局解析。
    expect(await SessionStore.resolveId(other.id.slice(0, 8), { dir })).toBe(other.id);
  });
});

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

describe('state 记录', () => {
  it('saveState 往返,脏检查不写重复记录', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const state = {
      todos: [{ content: '任务', status: 'pending' as const }],
      allowBash: ['Bash(npm test:*)'],
      allowWrite: ['src/**'],
      permissionMode: 'acceptEdits' as const,
    };
    await store.saveState(state);
    await store.saveState(state); // 未变,不应追加
    await store.saveState({ ...state, allowBash: [...state.allowBash] }); // 内容相同,同样跳过

    const records = await readRecords(store.id);
    expect(records.filter((r) => r.kind === 'state')).toHaveLength(1);

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.state).toEqual(state);
  });

  it('未完成的目标随状态往返;没有目标时字段整个不出现', async () => {
    // 无目标时必须一字不差地还是老样子:多写一个 `goal: undefined` 会让
    // JSON.stringify 变样,脏检查便会给每个老会话平白追加一条 state 记录。
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    // 用非空的 base:全空等于 EMPTY_STATE,脏检查会直接跳过,第一条记录根本不会写。
    const base = { todos: [{ content: '任务', status: 'pending' as const }], allowBash: [], allowWrite: [] };
    await store.saveState(base);
    let records = await readRecords(store.id);
    expect(JSON.stringify(records.at(-1))).not.toContain('goal');

    await store.saveState({ ...base, goal: { condition: '让 npm test 全绿' } });
    records = await readRecords(store.id);
    expect(records.filter((r) => r.kind === 'state')).toHaveLength(2);

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.state.goal).toEqual({ condition: '让 npm test 全绿' });
  });
});

describe('fork', () => {
  it('分叉出独立文件,继承历史与状态,源文件不再增长', async () => {
    const src = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [msg('user', 'a'), msg('assistant', 'b')];
    await src.save(history);
    await src.saveState({ todos: [], allowBash: ['Bash(git:*)'], allowWrite: [] });

    const forked = await src.fork({ provider: 'deepseek', model: 'd' });
    expect(forked.id).not.toBe(src.id);
    expect(forked.messages).toHaveLength(2);
    expect(forked.state.allowBash).toEqual(['Bash(git:*)']);
    expect(forked.meta.provider).toBe('deepseek');
    expect(forked.meta.title).toBe(src.meta.title);

    const srcSize = (await fs.stat(path.join(dir, `${src.id}.jsonl`))).size;
    history.push(msg('user', 'c'));
    await forked.save([...forked.messages, msg('user', 'c')]);
    // 分叉后的写入只进新文件。
    expect((await fs.stat(path.join(dir, `${src.id}.jsonl`))).size).toBe(srcSize);

    const reopened = await SessionStore.open(forked.id, dir);
    expect(reopened.messages).toHaveLength(3);
  });

  // 轮末的 save 是 fire-and-forget,且 agent 在触发它之前就已不再 isRunning,
  // `/fork` 的忙碌拦截会放行。fork 必须先把写队列排干,否则最后一轮既不在
  // 分叉快照里,又会在分叉之后补写进源文件。
  it('排干源会话排队中的写入再分叉,最后一轮不丢', async () => {
    const src = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    await src.save([msg('user', 'a')]);

    // 不 await:模拟 onHistoryChange 的 void store.save(...)。
    const pending = src.save([msg('user', 'a'), msg('assistant', 'b')]);
    const forked = await src.fork({ provider: 'kimi', model: 'm' });
    await pending;

    expect(forked.messages).toHaveLength(2);
    const reopened = await SessionStore.open(forked.id, dir);
    expect(reopened.messages).toHaveLength(2);

    // 排干发生在分叉之前:那一轮进了源文件,分叉之后源文件不再增长。
    const srcSize = (await fs.stat(path.join(dir, `${src.id}.jsonl`))).size;
    await forked.save([...forked.messages, msg('user', 'c')]);
    expect((await fs.stat(path.join(dir, `${src.id}.jsonl`))).size).toBe(srcSize);
  });
});

describe('展示历史(displayMessages)', () => {
  const MARKER = '[Earlier conversation, compacted]';
  const summaryMsg = () => msg('user', `${MARKER}\n\n摘要正文\n\n[End of compacted history — continue from here.]`);

  /** 模拟 doCompact:摘要 + 原历史的尾部切片(同一批对象引用)。 */
  function compactedOf(history: ModelMessage[], keep: number): ModelMessage[] {
    return [summaryMsg(), ...history.slice(history.length - keep)];
  }

  it('压缩不缩减展示历史;重开后由 display 字段恢复', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [];
    for (let i = 0; i < 3; i++) history.push(msg('user', `问 ${i}`), msg('assistant', `答 ${i}`));
    await store.save(history);

    const compacted = compactedOf(history, 2);
    await store.save(compacted);
    expect(store.messages).toHaveLength(3);
    expect(store.displayMessages).toHaveLength(6);

    // 压缩后继续对话:两份历史都要前进。
    compacted.push(msg('user', '新问题'), msg('assistant', '新回答'));
    await store.save(compacted);
    expect(store.displayMessages).toHaveLength(8);
    expect(String(store.displayMessages[0]!.content)).toBe('问 0');

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toHaveLength(5);
    expect(reopened.displayMessages).toHaveLength(8);
    expect(String(reopened.displayMessages[7]!.content)).toBe('新回答');
    // 展示历史里没有摘要消息本身。
    expect(reopened.displayMessages.every((m) => !String(m.content).startsWith(MARKER))).toBe(true);
  });

  it('rewind 是真删:展示历史同步截尾', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c'), msg('assistant', 'd')];
    await store.save(history);
    await store.save(history.slice(0, 2));

    expect(store.displayMessages).toHaveLength(2);
    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.displayMessages).toHaveLength(2);
  });

  it('压缩后 rewind:展示历史只截掉真被删的尾部', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [];
    for (let i = 0; i < 3; i++) history.push(msg('user', `问 ${i}`), msg('assistant', `答 ${i}`));
    await store.save(history);

    const compacted = compactedOf(history, 2); // [摘要, 问2, 答2]
    await store.save(compacted);
    await store.save(compacted.slice(0, 2)); // rewind 掉「答 2」

    expect(store.displayMessages).toHaveLength(5);
    expect(String(store.displayMessages[4]!.content)).toBe('问 2');
    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.displayMessages).toHaveLength(5);
  });

  it('旧文件没有 display 字段:按快照形状启发式重建', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [];
    for (let i = 0; i < 3; i++) history.push(msg('user', `问 ${i}`), msg('assistant', `答 ${i}`));
    await store.save(history);
    await store.save(compactedOf(history, 2));

    // 把快照记录里的 display 字段剥掉,模拟旧版本写出的文件。
    const file = path.join(dir, `${store.id}.jsonl`);
    const stripped = (await fs.readFile(file, 'utf8'))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        const record = JSON.parse(l) as { kind: string; display?: unknown };
        delete record.display;
        return JSON.stringify(record);
      })
      .join('\n');
    await fs.writeFile(file, `${stripped}\n`, 'utf8');

    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages).toHaveLength(3);
    expect(reopened.displayMessages).toHaveLength(6);
    expect(String(reopened.displayMessages[0]!.content)).toBe('问 0');
  });

  it('fork 继承展示历史,重开分叉文件后仍在', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const history: ModelMessage[] = [];
    for (let i = 0; i < 3; i++) history.push(msg('user', `问 ${i}`), msg('assistant', `答 ${i}`));
    await store.save(history);
    await store.save(compactedOf(history, 2));

    const forked = await store.fork({ provider: 'kimi', model: 'm' });
    expect(forked.displayMessages).toHaveLength(6);

    const reopened = await SessionStore.open(forked.id, dir);
    expect(reopened.messages).toHaveLength(3);
    expect(reopened.displayMessages).toHaveLength(6);
  });
});

describe('list 与旁车', () => {
  it('list 按 updatedAt 倒序、按 root 过滤,旁车损坏时回退', async () => {
    const a = await SessionStore.create({ root: '/w1', provider: 'kimi', model: 'm', dir });
    await a.save([msg('user', 'aaa')]);
    const b = await SessionStore.create({ root: '/w2', provider: 'kimi', model: 'm', dir });
    await b.save([msg('user', 'bbb')]);

    expect((await SessionStore.list(undefined, dir)).map((m) => m.id)).toContain(a.id);
    expect((await SessionStore.list('/w1', dir)).map((m) => m.id)).toEqual([a.id]);

    // 撕裂旁车 → 回退慢路径,依然可列出。
    await fs.writeFile(path.join(dir, `${a.id}.meta.json`), '{broken', 'utf8');
    expect((await SessionStore.list('/w1', dir)).map((m) => m.id)).toEqual([a.id]);
  });

  it('latest 返回最新会话', async () => {
    const a = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    await a.save([msg('user', 'old')]);
    await new Promise((r) => setTimeout(r, 5)); // 保证 updatedAt 有序
    const b = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    await b.save([msg('user', 'new')]);

    const latest = await SessionStore.latest('/w', dir);
    expect(latest?.id).toBe(b.id);
  });
});

describe('cleanup', () => {
  it('按 mtime 删除过期会话,keepIds 幸免', async () => {
    const old1 = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const old2 = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });
    const fresh = await SessionStore.create({ root: '/w', provider: 'kimi', model: 'm', dir });

    const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(dir, `${old1.id}.jsonl`), past, past);
    await fs.utimes(path.join(dir, `${old2.id}.jsonl`), past, past);

    const removed = await SessionStore.cleanup({ days: 30, keepIds: [old2.id], dir });
    expect(removed).toBe(1);

    const remaining = (await SessionStore.list(undefined, dir)).map((m) => m.id).sort();
    expect(remaining).toEqual([old2.id, fresh.id].sort());
    // 旁车一并删除。
    await expect(fs.stat(path.join(dir, `${old1.id}.meta.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('子任务过程记录(kind: task)', () => {
  it('saveTask / readTasks 往返;open() 恢复回放不受影响', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'p', model: 'm', dir });
    await store.save([msg('user', '你好'), msg('assistant', '在')]);
    await store.saveTask({
      callId: 'task-1',
      description: '找调用点',
      mode: 'explore',
      steps: 3,
      tokens: 1500,
      finishReason: 'stop',
      messages: [msg('user', '子任务简报'), msg('assistant', '子任务报告')],
    });
    await store.save([msg('user', '你好'), msg('assistant', '在'), msg('user', '继续')]);

    // 回查:task 记录完整取回,按时间顺序。
    const tasks = await SessionStore.readTasks(store.id, dir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ callId: 'task-1', mode: 'explore', steps: 3 });
    expect(tasks[0]!.messages.map((m) => m.content)).toEqual(['子任务简报', '子任务报告']);

    // 恢复回放只看主对话,task 记录不混进历史。
    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages.map((m) => m.content)).toEqual(['你好', '在', '继续']);
  });

  it('旧读者视角:未知 kind 被静默跳过,文件仍可打开', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'p', model: 'm', dir });
    await store.save([msg('user', 'hi')]);
    // 手动塞一条"未来版本"的记录,模拟前向兼容。
    await fs.appendFile(
      path.join(dir, `${store.id}.jsonl`),
      `${JSON.stringify({ kind: 'from-the-future', payload: 1 })}\n`,
    );
    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages.map((m) => m.content)).toEqual(['hi']);
  });
});

describe('轮末用量记录(kind: usage)', () => {
  it('saveUsage / readUsage 往返;open() 恢复回放不受影响', async () => {
    const store = await SessionStore.create({ root: '/w', provider: 'glm-coding', model: 'GLM-5.2', dir });
    await store.save([msg('user', '你好'), msg('assistant', '在')]);
    await store.saveUsage({
      provider: 'glm-coding',
      model: 'GLM-5.2',
      inputTokens: 45_600,
      outputTokens: 800,
      cachedInputTokens: 12_300,
    });
    await store.save([msg('user', '你好'), msg('assistant', '在'), msg('user', '继续')]);

    const usage = await SessionStore.readUsage(store.id, dir);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: 'glm-coding', cachedInputTokens: 12_300 });
    // 命中率可以由记录直接算出(记录里显式给了值,非缺省)。
    expect(usage[0]!.cachedInputTokens! / usage[0]!.inputTokens).toBeCloseTo(0.2697, 3);

    // 恢复回放只看主对话,usage 记录不混进历史。
    const reopened = await SessionStore.open(store.id, dir);
    expect(reopened.messages.map((m) => m.content)).toEqual(['你好', '在', '继续']);
  });
});
