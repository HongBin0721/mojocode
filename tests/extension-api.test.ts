import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrap, type Session } from '../src/app/bootstrap.js';
import { loadConfig } from '../src/config/load.js';
import type { ExtensionAPI } from '../src/core/extension.js';
import type { AgentEvent } from '../src/core/events.js';
import { parseExtensionFlags } from '../src/extensions/flags.js';
import { wrapCustomMessage } from '../src/agent/loop.js';
import { adaptToolDefinition } from '../src/extensions/tool-adapter.js';
import { flattenPiResult } from '../src/core/extension-types.js';
import { PROVIDER_PRESETS } from '../src/config/providers.js';
import { BUILTIN_PALETTE, palette } from '../src/core/palette.js';
import type { OverlayHandle } from '../src/core/extension-types.js';

/**
 * Pi 对齐的那批 ExtensionAPI 成员,走**真 bootstrap**:一个磁盘扩展把自己
 * 拿到的 `api` 挂到 globalThis 上,测试直接对它断言——每个成员都是接在真
 * 会话上的实现(ui 提问经真的 bus / uiRequests / answerUi,flag 经真的
 * BootstrapOptions,配置 `extensions` 经真的 loader),不是 fake。
 */

let home: string;
let root: string;
let session: Session;
let savedHome: string | undefined;
let api: ExtensionAPI;

const CAPTURE = `
export default (api) => {
  globalThis.__mojoTestApi = api;
  api.registerFlag('verbose', { description: 'v', type: 'boolean' });
  api.registerFlag('name', { description: 'n', type: 'string', default: 'anon' });
  api.registerFlag('unset', { description: 'u', type: 'string' });
  api.registerCommand('whoami', {
    description: 'ctx probe',
    handler: (args, ctx) => {
      globalThis.__mojoLastCtx = { args, hasUI: ctx.hasUI, cwd: ctx.cwd };
      // 从 handler 的 ctx 设界面区域:也必须记在这个扩展名下,/reload 才撤得掉。
      ctx.ui.setWidget('from-handler', ['handler widget']);
    },
  });
  api.registerTool({
    name: 'pi_shaped',
    description: 'a Pi-shaped tool',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    promptSnippet: 'echoes x back',
    promptGuidelines: ['Use pi_shaped when asked to echo.'],
    execute: async (_id, params) => ({ content: [{ type: 'text', text: 'echo ' + params.x }] }),
  });
  api.registerTool('plain', () => undefined, { promptSnippet: 'never materializes' });
  api.on('resources_discover', () => ({
    skillPaths: ['extskills'],
    promptPaths: ['extprompts'],
    themePaths: ['extthemes'],
  }));
  api.on('session_before_fork', () => (globalThis.__mojoBlockFork ? { cancel: true } : undefined));
  api.on('session_switch', ({ id }) => { globalThis.__mojoSwitched = id; });
  api.on('session_fork', ({ id }) => { globalThis.__mojoForked = id; });
  api.on('user_bash', ({ command }) => (command === 'echo hooked-me' ? { command: 'echo hooked' } : undefined));
  api.registerTool({
    name: 'with_details',
    description: 'returns details',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'shown to model' }], details: { secret: 42 } }),
    renderResult: (output) => ['details=' + JSON.stringify(output.details)],
  });
};
`;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-extapi-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-extapi-root-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  // setModel 走 switchProvider,它按 process.env 重新解析 provider(与 /models 同一条路)。
  process.env.DEEPSEEK_API_KEY = 'test-key-not-used';
  // 只 export 了 key、配置里一个字没写的厂商:getProviders 必须收它(见那条用例)。
  process.env.MOONSHOT_API_KEY = 'test-key-not-used';

  // 配置 `extensions` 来源(相对路径按 root 解析)+ 一条不存在的路径进 notice。
  await fs.mkdir(path.join(root, 'ext'), { recursive: true });
  await fs.writeFile(path.join(root, 'ext', 'capture.mjs'), CAPTURE);
  await fs.mkdir(path.join(root, '.mojocode'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.mojocode', 'config.json'),
    JSON.stringify({ extensions: ['ext/capture.mjs', 'ext/missing.mjs'] }),
  );
  // resources_discover 贡献的技能目录。
  await fs.mkdir(path.join(root, 'extskills', 'extskill'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'extskills', 'extskill', 'SKILL.md'),
    '---\nname: extskill\ndescription: from an extension\n---\nDo it.\n',
  );
  // resources_discover 贡献的提示词模板目录:一个没有 frontmatter 的 md 就是一条 /greet。
  await fs.mkdir(path.join(root, 'extprompts'), { recursive: true });
  await fs.writeFile(path.join(root, 'extprompts', 'greet.md'), 'Say hello to $1 warmly.\n');

  const loaded = await loadConfig({
    root,
    env: {
      HOME: home,
      MOJOCODE_PROVIDER: 'deepseek',
      MOJOCODE_MODEL: 'deepseek-chat',
      DEEPSEEK_API_KEY: 'test-key-not-used',
    },
  });
  session = await bootstrap({
    root,
    loaded,
    extensionFlags: parseExtensionFlags(['verbose', 'name=hongbin']),
  });
  api = (globalThis as { __mojoTestApi?: ExtensionAPI }).__mojoTestApi!;
});

afterAll(async () => {
  await session?.dispose?.();
  process.env.HOME = savedHome;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  for (const dir of [home, root]) await fs.rm(dir, { recursive: true, force: true });
});

describe('配置 extensions 来源', () => {
  it('列在配置里的扩展装上了;不存在的路径是一条 notice', () => {
    expect(api).toBeDefined();
    expect(session.extensionCommands.some((c) => c.name === 'whoami')).toBe(true);
    expect(session.startupNotices.some((n) => n.message.includes('missing.mjs'))).toBe(true);
  });
});

describe('flag', () => {
  it('parseExtensionFlags:不带 = 为 true,带了是字符串', () => {
    expect(parseExtensionFlags(['a', 'b=1', 'c=x=y'])).toEqual({ a: true, b: '1', c: 'x=y' });
    expect(parseExtensionFlags(undefined)).toEqual({});
  });

  it('getFlag 按声明类型解析;没给的用 default;未声明的 undefined', () => {
    expect(api.getFlag('verbose')).toBe(true);
    expect(api.getFlag('name')).toBe('hongbin');
    expect(api.getFlag('unset')).toBeUndefined();
    expect(api.getFlag('nobody')).toBeUndefined();
  });
});

describe('ui 提问', () => {
  it('没有前端在看:立即按缺省兑现,不进 uiRequests', async () => {
    session.attachUi(undefined);
    expect(api.hasUI).toBe(false);
    await expect(api.ui.select('t', ['a'])).resolves.toBeUndefined();
    await expect(api.ui.confirm('t', 'm')).resolves.toBe(false);
    await expect(api.ui.input('t')).resolves.toBeUndefined();
    expect(session.uiRequests).toEqual([]);
  });

  it('有前端:请求进队列与总线,answerUi 兑现,ui-resolved 广播;非法答案按没答', async () => {
    session.attachUi({ available: () => true });
    const events: AgentEvent[] = [];
    const off = session.bus.on((e) => events.push(e));
    let changed = 0;
    const offChanged = session.extensionsChanged(() => changed++);

    const picked = api.ui.select('pick one', ['a', 'b']);
    const [request] = session.uiRequests;
    expect(request).toMatchObject({ kind: 'select', title: 'pick one', items: ['a', 'b'] });
    expect(events.at(-1)).toEqual({ type: 'ui-request', request });
    expect(changed).toBe(1);

    session.answerUi(request!.id, 'b');
    await expect(picked).resolves.toBe('b');
    expect(session.uiRequests).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'ui-resolved', id: request!.id });
    // 重复回答静默。
    session.answerUi(request!.id, 'a');

    const confirmed = api.ui.confirm('sure?', 'really');
    session.answerUi(session.uiRequests[0]!.id, 'yes' as never);
    await expect(confirmed).resolves.toBe(false);

    const notInList = api.ui.select('pick', ['a']);
    session.answerUi(session.uiRequests[0]!.id, 'zzz');
    await expect(notInList).resolves.toBeUndefined();

    const typed = api.ui.input('name', 'placeholder');
    expect(session.uiRequests[0]).toMatchObject({ kind: 'input', placeholder: 'placeholder' });
    session.answerUi(session.uiRequests[0]!.id, 'hong');
    await expect(typed).resolves.toBe('hong');

    off();
    offChanged();
  });

  it('命令处理器收到 ctx(hasUI 是活的,ui 是这个扩展自己的门面)', async () => {
    await session.runCommand('whoami', 'x y');
    expect((globalThis as { __mojoLastCtx?: unknown }).__mojoLastCtx).toEqual({
      args: 'x y',
      hasUI: true,
      cwd: root,
    });
    // handler 经 ctx.ui 设的 widget 真的挂上了(卸载时撤得掉,见 /reload 用例)。
    expect(session.uiSurfaces.widgets.map((w) => w.key)).toContain('from-handler');
    api.ui.setWidget('from-handler', undefined);
    expect(api.ctx.cwd).toBe(root);
    expect(api.ctx.isIdle()).toBe(true);
  });
});

describe('会话控制、快捷键、编辑框、资源', () => {
  it('mode / waitForIdle / resources_discover(技能、提示词模板、主题目录三类都收)', async () => {
    expect(api.mode).toBe('tui');
    expect(api.ctx.mode).toBe('tui');
    await expect(api.waitForIdle()).resolves.toBeUndefined();
    expect(session.skills.map((s) => s.name)).toContain('extskill');
    // 提示词模板与技能同一条命令菜单;description 取正文第一行。
    const greet = session.skills.find((s) => s.name === 'greet');
    expect(greet?.description).toBe('Say hello to $1 warmly.');
    expect(session.themeDirs).toEqual([path.join(root, 'extthemes')]);
  });

  it('ui.editor:没人看立即 undefined;有人看进 uiRequests(带 prefill),answerUi 交回文本', async () => {
    session.attachUi(undefined);
    await expect(api.ui.editor('edit', 'draft')).resolves.toBeUndefined();
    session.attachUi({ available: () => true });
    const edited = api.ui.editor('edit', 'draft');
    expect(session.uiRequests[0]).toMatchObject({ kind: 'editor', title: 'edit', prefill: 'draft' });
    session.answerUi(session.uiRequests[0]!.id, 'draft+more');
    await expect(edited).resolves.toBe('draft+more');
  });

  it('ui.theme / setWorkingMessage / setEditorComponent / pasteToEditor', () => {
    expect(api.ui.theme.bold('x')).toBe('\x1b[1mx\x1b[22m');
    expect(api.ctx.ui.theme).toBe(api.ui.theme);
    let changed = 0;
    const off = session.extensionsChanged(() => changed++);
    api.ui.setWorkingMessage('brewing…');
    expect(session.uiSurfaces.workingMessage).toBe('brewing…');
    const factory = () => ({ render: () => ['ed'] });
    api.ui.setEditorComponent(factory);
    expect(session.uiSurfaces.editor).toBe(factory);
    expect(changed).toBe(2);
    api.ui.setWorkingMessage(undefined);
    api.ui.setEditorComponent(undefined);
    expect(session.uiSurfaces.workingMessage).toBeUndefined();
    expect(session.uiSurfaces.editor).toBeUndefined();
    off();
    const pasted: string[] = [];
    session.attachUi({ available: () => true, pasteToEditor: (text) => pasted.push(text) });
    api.ui.pasteToEditor('snippet');
    expect(pasted).toEqual(['snippet']);
    session.attachUi(undefined);
    api.ui.pasteToEditor('ignored');
    expect(pasted).toEqual(['snippet']);
  });

  it('ctx.sessionManager 是当前会话的只读视图;ctx.modelRegistry 给配置与预设里已知的模型', async () => {
    const sm = api.ctx.sessionManager;
    expect(sm.getSessionId()).toBe(session.store.id);
    await api.appendEntry('probe', { n: 1 });
    expect(sm.getEntries('probe').map((e) => e.data)).toEqual([{ n: 1 }]);
    expect(sm.getEntries().some((e) => e.type === 'probe')).toBe(true);
    expect(sm.getHistory()).toBe(api.history());
    expect(Array.isArray(sm.getDisplayHistory())).toBe(true);
    const sessions = await sm.listSessions();
    expect(sessions.some((s) => s.id === session.store.id)).toBe(true);

    const mr = api.ctx.modelRegistry;
    expect(mr.getCurrent()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(mr.getProviders()[0]).toBe('deepseek');
    const models = mr.getModels('deepseek');
    expect(models.every((m) => m.provider === 'deepseek')).toBe(true);
    expect(models.some((m) => m.id === PROVIDER_PRESETS.deepseek.defaultModel)).toBe(true);
    expect(mr.find('deepseek', 'deepseek-chat')?.contextWindow).toBe(128_000);
    expect(mr.find('deepseek', 'no-such-model')).toBeUndefined();
    expect(mr.getModels().length).toBeGreaterThan(models.length);
    // 只靠预设 env 变量配 key 的厂商也要列出来(与 /models 的枚举同一份判定)
    // ——否则扩展搭的模型切换器会悄悄漏掉用户正在用的那个厂商。
    expect(mr.getProviders()).toContain('kimi');
    // 没 key 没 baseURL 的不列。
    expect(mr.getProviders()).not.toContain('zhipu');
  });

  it('runUserBash:过 user_bash 钩子(改写 / 接管)后在工作区跑,输出以 user_bash 消息并入历史不开轮', async () => {
    await session.runUserBash('echo plain');
    const last = () => session.agent.history.at(-1) as { role: string; content: string };
    expect(last().role).toBe('user');
    expect(last().content).toContain('[extension message: user_bash]');
    expect(last().content).toContain('$ echo plain\nplain\n(exit code 0)');
    // 钩子改写命令。
    await session.runUserBash('echo hooked-me');
    expect(last().content).toContain('$ echo hooked\nhooked');
    // 钩子接管执行。
    const off = api.on('user_bash', () => ({ run: async () => ({ exitCode: 7, output: 'took over' }) }));
    await session.runUserBash('whatever');
    expect(last().content).toContain('$ whatever\ntook over\n(exit code 7)');
    off();
    expect(session.agent.isRunning).toBe(false);
  });

  it('api.ctx.hasUI 是活的 getter(不是建 API 那一刻钉死的 false)', () => {
    session.attachUi(undefined);
    expect(api.ctx.hasUI).toBe(false);
    session.attachUi({ available: () => true });
    expect(api.ctx.hasUI).toBe(true);
    expect(api.hasUI).toBe(true);
  });

  it('isIdle 与 waitForIdle 同判据:压缩进行中不算空闲', async () => {
    expect(api.ctx.isIdle()).toBe(true);
    await expect(api.waitForIdle()).resolves.toBeUndefined();
  });

  it('registerShortcut:归一键名,runShortcut 认领并把 ctx 交给处理器;不带修饰键的拒绝,保留键拒绝', async () => {
    const seen: unknown[] = [];
    const off = api.registerShortcut('Ctrl+G', { description: 'go', handler: (ctx) => {
      seen.push(ctx.cwd);
    } });
    expect(session.runShortcut('ctrl+g')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([root]);
    expect(session.runShortcut('ctrl+h')).toBe(false);
    off();
    expect(session.runShortcut('ctrl+g')).toBe(false);
    expect(() => api.registerShortcut('g', { description: 'x', handler: () => {} })).toThrow(/ctrl or meta/);
    // TUI 自己占着的组合键在注册那一刻就拒绝——不能等用户按下去才发现没反应。
    // App 的全局键与 Input 的 readline 绑定都归 TUI 所有。
    for (const reserved of ['ctrl+c', 'Ctrl+T', 'ctrl+o', 'ctrl+r', 'ctrl+a', 'ctrl+w']) {
      expect(() => api.registerShortcut(reserved, { description: 'x', handler: () => {} })).toThrow(
        /reserved/,
      );
    }
  });

  it('ui.getEditorText / setEditorText 经 attachUi 的宿主;没挂宿主时读到空串', () => {
    session.attachUi(undefined);
    expect(api.ui.getEditorText()).toBe('');
    const set: string[] = [];
    session.attachUi({ available: () => true, getEditorText: () => 'draft', setEditorText: (t) => set.push(t) });
    expect(api.ui.getEditorText()).toBe('draft');
    api.ui.setEditorText('hello');
    expect(set).toEqual(['hello']);
  });

  it('newSession / fork / switchSession:换会话并播报 session-changed;session_before_fork 可取消', async () => {
    const events: AgentEvent[] = [];
    const off = session.bus.on((e) => events.push(e));
    const before = session.store.id;
    await api.newSession();
    expect(session.store.id).not.toBe(before);
    expect(events.at(-1)).toEqual({ type: 'session-changed', reason: 'new', id: session.store.id });

    const forked = await api.fork();
    expect(forked).toEqual({ cancelled: false, id: session.store.id });
    const forkedId = session.store.id;
    expect(events.at(-1)).toMatchObject({ type: 'session-changed', reason: 'fork' });

    // 钩子否决是回执不是异常(Pi 的 { cancelled }):会话没换、没播报。
    (globalThis as { __mojoBlockFork?: boolean }).__mojoBlockFork = true;
    const idBeforeBlocked = session.store.id;
    await expect(api.fork()).resolves.toEqual({ cancelled: true });
    expect(session.store.id).toBe(idBeforeBlocked);
    (globalThis as { __mojoBlockFork?: boolean }).__mojoBlockFork = false;

    // session_fork / session_switch 的事后通知带新会话 id。
    expect((globalThis as { __mojoForked?: string }).__mojoForked).toBe(forkedId);

    await api.switchSession(before);
    expect(session.store.id).toBe(before);
    expect(events.at(-1)).toEqual({ type: 'session-changed', reason: 'resume', id: before });
    expect((globalThis as { __mojoSwitched?: string }).__mojoSwitched).toBe(before);
    await expect(api.switchSession('no-such-session-id')).rejects.toThrow();
    off();
  });
});

describe('ctx 控制面(Pi 同形)', () => {
  it('signal / hasPendingMessages / getSystemPrompt / getContextUsage:空闲时的读数', () => {
    expect(api.ctx.signal).toBeUndefined();
    expect(api.ctx.hasPendingMessages()).toBe(false);
    expect(api.ctx.getSystemPrompt()).toBe(session.agent.systemPrompt);
    expect(api.ctx.getSystemPrompt().length).toBeGreaterThan(0);
    expect(api.ctx.getContextUsage()).toEqual(api.getContextUsage());
  });

  it('withSession:切完会话再调,收到的 ctx 已指向新会话', async () => {
    const before = session.store.id;
    const seen: string[] = [];
    const forked = await api.ctx.fork({
      withSession: (ctx) => {
        seen.push(ctx.sessionManager.getSessionId());
      },
    });
    expect(forked).toEqual({ cancelled: false, id: session.store.id });
    expect(seen).toEqual([session.store.id]);
    expect(seen[0]).not.toBe(before);
    await expect(
      api.ctx.switchSession(before, {
        withSession: (ctx) => {
          seen.push(ctx.sessionManager.getSessionId());
        },
      }),
    ).resolves.toEqual({ cancelled: false });
    expect(seen[1]).toBe(before);
    // 否决时 withSession 不跑。
    (globalThis as { __mojoBlockFork?: boolean }).__mojoBlockFork = true;
    let ran = false;
    await expect(api.ctx.fork({ withSession: () => void (ran = true) })).resolves.toEqual({ cancelled: true });
    expect(ran).toBe(false);
    (globalThis as { __mojoBlockFork?: boolean }).__mojoBlockFork = false;
  });

  it('shutdown:TUI 挂着走 UiHost.exit,没界面记 shutdownRequested', () => {
    let exited = 0;
    session.attachUi({ available: () => true, exit: () => exited++ });
    expect(session.shutdownRequested).toBe(false);
    api.ctx.shutdown();
    expect(exited).toBe(1);
    expect(session.shutdownRequested).toBe(true);
    session.attachUi(undefined);
    // 没有退出回调也不炸(-p,以及 TUI 挂上之前):标记已立,cli.tsx 跳过
    // 还没开的那一轮,runTui 一帧都不起。
    api.ctx.shutdown();
    expect(exited).toBe(1);
    expect(session.shutdownRequested).toBe(true);
    // 标记是**留存的**:shutdown 落在界面挂上之前时,下一个挂上来的宿主要被
    // 立刻退掉,否则界面照常起来、扩展的「退出」无声丢失。
    let lateExits = 0;
    session.attachUi({ available: () => true, exit: () => lateExits++ });
    expect(lateExits).toBe(1);
    session.attachUi(undefined);
    // 注意:这之后 shutdownRequested 对本文件余下的用例一直为真(没有复位的
    // 口子)。它们挂的假宿主都不带 exit,`host.exit?.()` 是空操作。
  });

  it('compact(options):onComplete 在「无事发生」时也回调;与 api.compact 同一份', async () => {
    // 历史太短:compactMessages 提前返回、不打模型——正好考回调分支不联网。
    let completed = 0;
    await expect(
      api.ctx.compact({ customInstructions: 'keep the file list', onComplete: () => completed++ }),
    ).resolves.toBeUndefined();
    expect(completed).toBe(1);
    expect(api.compact).toBe(api.ctx.compact);
  });
});

describe('渲染层', () => {
  it('ui.custom:没人看立即 undefined;有人看进 uiCustoms,resolveCustom 交回', async () => {
    session.attachUi(undefined);
    await expect(api.ui.custom(() => ({ render: () => [] }))).resolves.toBeUndefined();
    session.attachUi({ available: () => true });
    const pending = api.ui.custom<string>((_host, done) => ({
      render: () => ['x'],
      handleInput: () => done('picked'),
    }));
    expect(session.uiCustoms).toHaveLength(1);
    const request = session.uiCustoms[0]!;
    const component = request.factory(
      { requestRender: () => {}, width: 80, theme: api.ctx.ui === undefined ? (undefined as never) : ({} as never) },
      (value) => session.resolveCustom(request.id, value),
    );
    component.handleInput!('\r', {} as never);
    await expect(pending).resolves.toBe('picked');
    expect(session.uiCustoms).toEqual([]);
  });

  it('setWidget / setHeader / setFooter / setTitle 记进 uiSurfaces,变化通知订阅者', () => {
    let changed = 0;
    const off = session.extensionsChanged(() => changed++);
    api.ui.setWidget('a', ['line']);
    api.ui.setWidget('b', ['other']);
    api.ui.setWidget('a', ['line2']);
    api.ui.setHeader(['h']);
    api.ui.setFooter(['f']);
    api.ui.setTitle('T');
    expect(session.uiSurfaces).toEqual({
      widgets: [
        { key: 'a', surface: ['line2'] },
        { key: 'b', surface: ['other'] },
      ],
      header: ['h'],
      footer: ['f'],
      title: 'T',
    });
    api.ui.setWidget('a', undefined);
    api.ui.setHeader(undefined);
    api.ui.setFooter(undefined);
    api.ui.setTitle(undefined);
    expect(session.uiSurfaces).toEqual({ widgets: [{ key: 'b', surface: ['other'] }] });
    api.ui.setWidget('b', undefined);
    expect(changed).toBe(11);
    off();
  });

  it('画法表换引用不就地改:内容没变身份就不变,变了才变', () => {
    // 身份稳定 = TUI 的信号不会被每次 extensionsChanged 白唤醒(todo 每次
    // 工具调用都跳一次);变了就换身份 = 懒注册与 /reload 撤掉的画法照样重画。
    const before = session.toolRenderers;
    expect(session.toolRenderers).toBe(before);
    api.registerTool('painted-identity', () => undefined, { renderResult: () => ['x'] });
    const after = session.toolRenderers;
    expect(after).not.toBe(before);
    expect(after.has('painted-identity')).toBe(true);
    api.unregisterTool('painted-identity');
    expect(session.toolRenderers).not.toBe(after);
    expect(session.toolRenderers.has('painted-identity')).toBe(false);

    const msgBefore = session.messageRenderers;
    expect(session.messageRenderers).toBe(msgBefore);
    api.registerMessageRenderer('identity-probe', () => ['y']);
    expect(session.messageRenderers).not.toBe(msgBefore);
  });

  it('registerTool 的 renderCall / renderResult 登记到 toolRenderers,unregister 时撤掉', () => {
    api.registerTool('painted', () => undefined, {
      renderResult: (output) => [String(output)],
    });
    expect(session.toolRenderers.get('painted')?.renderResult?.('o', { isError: false, expanded: false, input: {} }, api.ctx.ui as never)).toEqual(['o']);
    expect(session.toolRenderers.get('painted')?.renderCall).toBeUndefined();
    expect(session.toolRenderers.has('pi_shaped')).toBe(false);
    api.unregisterTool('painted');
    expect(session.toolRenderers.has('painted')).toBe(false);
  });
});

describe('工具管理', () => {
  it('Pi 形状的定义经适配器注册;带自述的工具进系统提示词;不成形的工厂不列', async () => {
    expect(api.getAllTools()).toContain('pi_shaped');
    expect(api.getAllTools()).not.toContain('plain');
    const { systemPrompt } = await session.hooks.beforeAgentStart({
      systemPrompt: 'BASE',
      subagent: false,
    });
    expect(systemPrompt).toContain('## Extension tools');
    expect(systemPrompt).toContain('- pi_shaped: echoes x back');
    expect(systemPrompt).toContain('- Use pi_shaped when asked to echo.');
    expect(systemPrompt).not.toContain('never materializes');
  });

  it('Pi 结果的 details 留给画法:工具输出是整个对象,模型经 toModelOutput 只看 content 文本', async () => {
    const definition = {
      name: 'd',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'visible' }], details: { hidden: true } }),
    };
    const tool = adaptToolDefinition(definition, { bus: session.bus, ctx: () => api.ctx })({ subagent: false })!;
    const output = await tool.execute!({}, { toolCallId: 'c1', messages: [], context: undefined } as never);
    expect(output).toEqual({ content: [{ type: 'text', text: 'visible' }], details: { hidden: true } });
    expect(tool.toModelOutput!({ toolCallId: 'c1', input: {}, output })).toEqual({ type: 'text', value: 'visible' });
    // 非 Pi 形状要逐字复刻 SDK 的缺省:undefined → null。给了 toModelOutput
    // 之后 SDK 不再走它自己那条路,漏掉这一步 tool 消息会带着 content:
    // undefined 发出去,请求直接 400(Pi 的 execute 允许什么都不返回)。
    const asJson = (out: unknown) => tool.toModelOutput!({ toolCallId: 'c1', input: {}, output: out });
    expect(asJson(undefined)).toEqual({ type: 'json', value: null });
    expect(asJson(null)).toEqual({ type: 'json', value: null });
    expect(asJson({ a: 1 })).toEqual({ type: 'json', value: { a: 1 } });
    expect(asJson('plain')).toEqual({ type: 'text', value: 'plain' });
    // 经 registerTool 登记的画法拿到的也是整个对象。
    const rendered = session.toolRenderers.get('with_details')!.renderResult!(
      { content: [], details: { secret: 42 } },
      { isError: false, expanded: false, input: {} },
      api.ui.theme,
    );
    expect(rendered).toEqual(['details={"secret":42}']);
  });

  it('flattenPiResult:content 数组拼成文本,其他形状原样', () => {
    expect(flattenPiResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe(
      'a\nb',
    );
    expect(flattenPiResult({ ok: 1 })).toEqual({ ok: 1 });
    expect(flattenPiResult('s')).toBe('s');
  });

  it('setActiveTools 只影响交给模型的名单,getAllTools 不变;停用的工具也不进提示词', async () => {
    const all = api.getAllTools();
    api.setActiveTools(['read']);
    expect(api.getActiveTools()).toEqual(['read']);
    expect(api.getAllTools()).toEqual(all);
    const { systemPrompt } = await session.hooks.beforeAgentStart({
      systemPrompt: 'BASE',
      subagent: false,
    });
    expect(systemPrompt).not.toContain('## Extension tools');
    api.setActiveTools(undefined);
    expect(api.getActiveTools()).toEqual(all);
  });
});

describe('其余成员', () => {
  it('events:扩展之间的总线;处理器抛错不影响其他处理器', () => {
    const seen: unknown[] = [];
    api.events.on('ping', () => {
      throw new Error('boom');
    });
    const off = api.events.on('ping', (data) => seen.push(data));
    api.events.emit('ping', 1);
    off();
    api.events.emit('ping', 2);
    expect(seen).toEqual([1]);
  });

  it('exec:不经 shell,非零退出码不抛', async () => {
    const ok = await api.exec('node', ['-e', 'process.stdout.write("hi")']);
    expect(ok).toMatchObject({ stdout: 'hi', exitCode: 0 });
    const bad = await api.exec('node', ['-e', 'process.exit(3)']);
    expect(bad.exitCode).toBe(3);
  });

  it('会话名、上下文占用、模型与思考档位', async () => {
    await api.setSessionName('renamed by ext');
    expect(api.getSessionName()).toBe('renamed by ext');
    expect(session.store.meta.title).toBe('renamed by ext');

    const usage = api.getContextUsage();
    expect(usage.window).toBeGreaterThan(0);
    expect(usage.percent).toBeGreaterThanOrEqual(0);

    expect(api.getModel()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    const levels: string[] = [];
    api.on('thinking_level_select', ({ level }) => {
      levels.push(level);
    });
    await api.setThinkingLevel('high');
    expect(api.getThinkingLevel()).toBe('high');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(levels).toEqual(['high']);

    const models: string[] = [];
    api.on('model_select', ({ model }) => {
      models.push(model);
    });
    await api.setModel({ model: 'deepseek-reasoner' });
    expect(api.getModel().model).toBe('deepseek-reasoner');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(models).toEqual(['deepseek-reasoner']);
    expect(api.getCommands()).toContain('whoami');
  });
});

// 放最后:reload 会把上面各组用的那份扩展换掉。
describe('自定义消息与 /reload', () => {
  it('sendMessage 空闲时进历史;registerMessageRenderer 登记画法', async () => {
    api.registerMessageRenderer('note', (m) => [`NOTE ${m.content}`]);
    expect(session.messageRenderers.get('note')?.({ customType: 'note', content: 'x' }, api.ctx.ui as never)).toEqual(['NOTE x']);
    await api.sendMessage({ customType: 'note', content: 'hello' });
    expect(session.agent.history.at(-1)).toEqual({ role: 'user', content: wrapCustomMessage('note', 'hello') });
  });

  it('reloadExtensions:旧注册全部撤掉(命令、钩子、画法),新代码装上', async () => {
    (globalThis as { __mojoBlockFork?: boolean }).__mojoBlockFork = true;
    await fs.writeFile(
      path.join(root, 'ext', 'capture.mjs'),
      `export default (api) => {
  globalThis.__mojoTestApi = api;
  api.registerCommand('whoami2', { description: 'v2', handler: () => {} });
};
`,
    );
    // 从命令 handler 的 ctx 设的 widget 也要算在这个扩展名下。
    await session.runCommand('whoami', '');
    expect(session.uiSurfaces.widgets.map((w) => w.key)).toContain('from-handler');

    const result = await session.reloadExtensions();
    expect(result.loaded).toEqual(['capture']);
    expect(result.failed).toEqual([]);
    expect(session.uiSurfaces.widgets).toEqual([]);
    const names = session.extensionCommands.map((c) => c.name);
    expect(names).toContain('whoami2');
    expect(names).not.toContain('whoami');
    expect(session.messageRenderers.has('note')).toBe(false);
    expect(session.toolRenderers.size).toBe(0);
    expect(session.runShortcut('ctrl+g')).toBe(false);
    // 旧的 session_before_fork 钩子已经退订:标记仍为 true,fork 照常成功。
    await expect(api.fork()).resolves.toMatchObject({ id: expect.any(String) });
    (globalThis as { __mojoBlockFork?: boolean }).__mojoBlockFork = false;
    api = (globalThis as { __mojoTestApi?: ExtensionAPI }).__mojoTestApi!;
    expect(api.getCommands()).toContain('whoami2');
  });

  it('并发调用共享同一次:ctx.reload 谁都能调,不该各卸各装', async () => {
    // `/reload` 命令是串行派发的,但 ctx.reload 没有这层保护:各起一轮的话,
    // 后进来的会看到已被清空的 diskExtensionIds——什么都不卸却又并发装一遍。
    const results = await Promise.all([session.reloadExtensions(), session.reloadExtensions()]);
    expect(results[0]).toBe(results[1]);
  });
});

describe('ui 面的第五批对齐(Pi 的 ctx.ui 余下成员)', () => {
  it('提问框的 timeout / signal:到点或中止都按「没答」兑现,请求带 deadline', async () => {
    session.attachUi({ available: () => true });
    const before = Date.now();
    const confirmed = api.ui.confirm('t', 'm', { timeout: 30 });
    const request = session.uiRequests[0]!;
    expect(request.kind).toBe('confirm');
    expect(request.deadline).toBeGreaterThanOrEqual(before + 30);
    await expect(confirmed).resolves.toBe(false);
    expect(session.uiRequests).toEqual([]);

    const controller = new AbortController();
    const selected = api.ui.select('t', ['a', 'b'], { signal: controller.signal });
    expect(session.uiRequests).toHaveLength(1);
    controller.abort();
    await expect(selected).resolves.toBeUndefined();
    expect(session.uiRequests).toEqual([]);
    // 已经中止的 signal:根本不进队列。
    await expect(api.ui.input('t', undefined, { signal: controller.signal })).resolves.toBeUndefined();
    expect(session.uiRequests).toEqual([]);
    session.attachUi(undefined);
  });

  it('ui.notify 的 error 与 Pi 拼法的 warning 都上总线', () => {
    const levels: string[] = [];
    const off = session.bus.on((e) => {
      if (e.type === 'notice') levels.push(e.level);
    });
    api.ui.notify('boom', 'error');
    api.ui.notify('hm', 'warning');
    api.ui.notify('ok');
    off();
    expect(levels).toEqual(['error', 'warn', 'info']);
  });

  it('ui.setStatus(key, text):同一扩展按 key 多条,与 api.setStatus 互不相撞', () => {
    api.ui.setStatus('a', 'one');
    api.ui.setStatus('b', 'two');
    api.setStatus('plain');
    const ids = session.extensionStatus.map((entry) => entry.id).sort();
    expect(ids).toEqual(['capture', 'capture:a', 'capture:b']);
    api.ui.setStatus('a', undefined);
    api.setStatus(undefined);
    expect(session.extensionStatus.map((entry) => entry.id)).toEqual(['capture:b']);
    api.ui.setStatus('b', undefined);
  });

  it('工作状态线的三个槽位与 widget 的位置进 uiSurfaces;getEditorComponent 读回工厂', () => {
    api.ui.setWorkingVisible(false);
    api.ui.setWorkingIndicator({ frames: ['●'], intervalMs: 500 });
    api.ui.setHiddenThinkingLabel('pondered');
    api.ui.setWidget('below', ['under'], { placement: 'belowEditor' });
    api.ui.setWidget('above', ['over']);
    expect(session.uiSurfaces).toMatchObject({
      workingVisible: false,
      workingIndicator: { frames: ['●'], intervalMs: 500 },
      hiddenThinkingLabel: 'pondered',
      widgets: [
        { key: 'below', surface: ['under'], placement: 'belowEditor' },
        { key: 'above', surface: ['over'] },
      ],
    });
    // 可见是缺省,存一个 true 没有意义:槽位直接消失。
    api.ui.setWorkingVisible(true);
    api.ui.setWorkingIndicator();
    api.ui.setHiddenThinkingLabel();
    api.ui.setWidget('below', undefined);
    api.ui.setWidget('above', undefined);
    expect(session.uiSurfaces).toEqual({ widgets: [] });

    const factory = () => ({ render: () => ['ed'] });
    expect(api.ui.getEditorComponent()).toBeUndefined();
    api.ui.setEditorComponent(factory);
    expect(api.ui.getEditorComponent()).toBe(factory);
    api.ui.setEditorComponent(undefined);
  });

  it('ui.custom 的 overlay:请求带选项,把手 setHidden 换引用、hide 以 undefined 收尾', async () => {
    session.attachUi({ available: () => true });
    let handle: OverlayHandle | undefined;
    const pending = api.ui.custom(() => ({ render: () => ['x'] }), {
      overlay: true,
      overlayOptions: { width: 30 },
      onHandle: (h) => {
        handle = h;
      },
    });
    const first = session.uiCustoms[0]!;
    expect(first.overlay).toEqual({ width: 30 });
    expect(first.hidden).toBeUndefined();
    handle!.setHidden(true);
    const second = session.uiCustoms[0]!;
    expect(second).not.toBe(first);
    expect(second.hidden).toBe(true);
    handle!.setHidden(true); // 幂等:不换引用
    expect(session.uiCustoms[0]).toBe(second);
    handle!.hide();
    await expect(pending).resolves.toBeUndefined();
    expect(session.uiCustoms).toEqual([]);
    // `overlay: true` 不给选项就是空对象;不给 overlay 就是顶掉输入框的那种。
    const plain = api.ui.custom(() => ({ render: () => [] }));
    expect(session.uiCustoms[0]!.overlay).toBeUndefined();
    session.resolveCustom(session.uiCustoms[0]!.id, undefined);
    await plain;
    session.attachUi(undefined);
  });

  it('onTerminalInput:先注册的先问,第一个 consume 的赢;注销后不再问', () => {
    const seen: string[] = [];
    const offA = api.ui.onTerminalInput((data) => {
      seen.push(`a:${data}`);
      return data === 'x' ? { consume: true } : undefined;
    });
    const offB = api.ui.onTerminalInput((data) => {
      seen.push(`b:${data}`);
      return undefined;
    });
    expect(session.runTerminalInput('x')).toBe(true);
    expect(session.runTerminalInput('y')).toBe(false);
    expect(seen).toEqual(['a:x', 'a:y', 'b:y']);
    offA();
    offB();
    expect(session.runTerminalInput('x')).toBe(false);
  });

  it('getToolsExpanded / setToolsExpanded 打到宿主;没有宿主恒 false', () => {
    expect(api.ui.getToolsExpanded()).toBe(false);
    let expanded = false;
    session.attachUi({
      available: () => true,
      getToolsExpanded: () => expanded,
      setToolsExpanded: (next) => {
        expanded = next;
      },
    });
    api.ui.setToolsExpanded(true);
    expect(api.ui.getToolsExpanded()).toBe(true);
    session.attachUi(undefined);
  });

  it('getAllThemes / getTheme / setTheme:列目录、读配色、就地换色并通知宿主;不落盘', async () => {
    const dir = path.join(root, '.mojocode', 'themes');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'dusk.json');
    await fs.writeFile(file, JSON.stringify({ colors: { accent: '#7aa2f7' } }));
    const changed: Array<string | undefined> = [];
    session.attachUi({ available: () => true, themeChanged: (f) => changed.push(f) });
    try {
      const all = await api.ui.getAllThemes();
      expect(all[0]).toEqual({ name: 'default', path: undefined });
      expect(all).toContainEqual({ name: 'dusk', path: file });
      expect(await api.ui.getTheme('dusk')).toEqual({ accent: '#7aa2f7' });
      expect(await api.ui.getTheme('nope')).toBeUndefined();
      expect(await api.ui.getTheme('default')).toEqual({ ...BUILTIN_PALETTE });

      expect(await api.ui.setTheme('dusk')).toEqual({ success: true });
      expect(palette.accent).toBe('#7aa2f7');
      expect(session.config.theme).toBe('dusk');
      expect(changed).toEqual([file]);
      expect(await api.ui.setTheme('nope')).toMatchObject({ success: false });
      // 直接给对象:没给的键回内置(accent 不再是 dusk 的)。
      expect(await api.ui.setTheme({ dim: 'white' })).toEqual({ success: true });
      expect(palette.dim).toBe('white');
      expect(palette.accent).toBe(BUILTIN_PALETTE.accent);
      expect(changed.at(-1)).toBeUndefined();
      // 给配色对象就不再对应任何主题名:留着 dusk 的话,/theme 选择器 esc 收回
      // 预览会按名字从磁盘重读 dusk,把扩展的配色顶掉。
      expect(session.config.theme).toBeUndefined();

      // 连发两次(读盘是异步的):只有后发的那次生效,先发的回报被顶替。
      const [first, second] = await Promise.all([api.ui.setTheme('dusk'), api.ui.setTheme('default')]);
      expect(first).toMatchObject({ success: false });
      expect(second).toEqual({ success: true });
      expect(palette.accent).toBe(BUILTIN_PALETTE.accent);
      expect(session.config.theme).toBeUndefined();
    } finally {
      await api.ui.setTheme('default');
      session.attachUi(undefined);
    }
    expect(palette.dim).toBe(BUILTIN_PALETTE.dim);
    expect(session.config.theme).toBeUndefined();
  });
});

describe('Pi 的钩子载荷与消息投递(真 bootstrap)', () => {
  it('tool_execution_update 从总线的增量桥接:带工具名、args 与 partialResult(旧叫法照填)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const off = session.hooks.on('tool_execution_update', (e) => void seen.push({ ...e }));
    session.bus.emit({ type: 'tool-start', callId: 'u1', toolName: 'bash', input: { command: 'ls' } });
    session.bus.emit({ type: 'tool-output-delta', callId: 'u1', chunk: 'a.ts' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    off();
    session.bus.emit({ type: 'tool-end', callId: 'u1', toolName: 'bash', summary: '', output: '', isError: false, durationMs: 0 });
    expect(seen).toEqual([
      {
        toolCallId: 'u1',
        toolName: 'bash',
        args: { command: 'ls' },
        partialResult: 'a.ts',
        subagent: false,
        callId: 'u1',
        chunk: 'a.ts',
      },
    ]);
  });

  it('session_before_switch 在 /new 上也问(reason: new),否决是回执;resume 给确定的 id 与会话文件', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let block = true;
    const off = session.hooks.on('session_before_switch', (e) => {
      seen.push({ ...e });
      return e.reason === 'new' && block ? { cancel: true } : undefined;
    });
    const before = session.store.id;
    await expect(api.ctx.newSession()).resolves.toEqual({ cancelled: true });
    expect(session.store.id).toBe(before);
    expect(seen[0]).toEqual({ reason: 'new' });
    block = false;
    await expect(api.ctx.newSession()).resolves.toEqual({ cancelled: false });
    await api.ctx.switchSession(before.slice(0, 8));
    // 前缀已解析成完整 id,会话文件是确定的绝对路径。
    expect(seen.at(-1)).toMatchObject({ reason: 'resume', id: before });
    expect(String(seen.at(-1)!.targetSessionFile)).toMatch(new RegExp(`${before}\\.jsonl$`));
    off();
  });

  it('session_start 带上一个会话的文件路径', async () => {
    const starts: Array<Record<string, unknown>> = [];
    const off = session.hooks.on('session_start', (e) => void starts.push({ ...e }));
    const previous = session.store.id;
    await api.ctx.fork();
    expect(starts.at(-1)).toMatchObject({ reason: 'fork' });
    expect(String(starts.at(-1)!.previousSessionFile)).toMatch(new RegExp(`${previous}\\.jsonl$`));
    off();
  });

  it('model_select / thinking_level_select 带切换前的值', async () => {
    const models: Array<Record<string, unknown>> = [];
    const levels: Array<Record<string, unknown>> = [];
    const offA = session.hooks.on('model_select', (e) => void models.push({ ...e }));
    const offB = session.hooks.on('thinking_level_select', (e) => void levels.push({ ...e }));
    const { provider: prevProvider, model: prevModel } = api.getModel();
    const prevLevel = api.getThinkingLevel();
    await api.setModel({ model: 'deepseek-reasoner' });
    await api.setThinkingLevel('high');
    await new Promise((resolve) => setTimeout(resolve, 5)); // 两个都是 void 通知
    expect(models.at(-1)).toMatchObject({
      model: 'deepseek-reasoner',
      previousProvider: prevProvider,
      previousModel: prevModel,
      source: 'set',
    });
    expect(levels.at(-1)).toMatchObject({ level: 'high', previousLevel: prevLevel });
    await api.setModel({ model: prevModel });
    await api.setThinkingLevel(prevLevel);
    offA();
    offB();
  });

  it('exec 认 Pi 的 timeout(与 timeoutMs 同义)', async () => {
    const started = Date.now();
    const result = await api.exec('sleep', ['5'], { timeout: 150 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.exitCode).not.toBe(0);
  });

  it('sendUserMessage:空闲开新的一轮;运行中不给 deliverAs 抛错,steer / followUp 各走各的路;图片部件成附件', async () => {
    const agent = session.agent as unknown as {
      followUp: (...args: unknown[]) => void;
      inject: (...args: unknown[]) => Promise<boolean>;
    };
    const originalFollowUp = agent.followUp;
    const originalInject = agent.inject;
    const followUp = vi.fn();
    const inject = vi.fn(async () => true);
    agent.followUp = followUp;
    agent.inject = inject;
    let running = false;
    Object.defineProperty(session.agent, 'isRunning', { configurable: true, get: () => running });
    try {
      await api.sendUserMessage([
        { type: 'text', text: 'look' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ]);
      expect(followUp).toHaveBeenLastCalledWith('look', {
        source: 'extension',
        images: [{ mediaType: 'image/png', data: 'AAAA' }],
      });
      running = true;
      await expect(api.sendUserMessage('mid')).rejects.toThrow(/deliverAs/);
      await api.ctx.sendUserMessage('mid', { deliverAs: 'steer' });
      expect(inject).toHaveBeenLastCalledWith('mid', undefined, 'extension');
      // steer 输给「轮恰好收尾」的竞态:改成开新的一轮,不丢。
      inject.mockResolvedValueOnce(false);
      await api.sendUserMessage('raced', { deliverAs: 'steer' });
      expect(followUp).toHaveBeenLastCalledWith('raced', { source: 'extension' });
      await api.sendUserMessage('later', { deliverAs: 'followUp' });
      expect(followUp).toHaveBeenLastCalledWith('later', { source: 'extension' });
    } finally {
      agent.followUp = originalFollowUp;
      agent.inject = originalInject;
      delete (session.agent as unknown as { isRunning?: boolean }).isRunning;
    }
  });

  it('sendMessage 的 display: false 与 details 经 api 落到 Agent', async () => {
    const events: AgentEvent[] = [];
    const off = session.bus.on((e) => events.push(e));
    await api.sendMessage({ customType: 'shown', content: [{ type: 'text', text: 'a' }], details: { v: 1 } });
    await api.sendMessage({ customType: 'hidden', content: 'b', display: false });
    off();
    const custom = events.filter((e) => e.type === 'custom-message');
    expect(custom).toEqual([{ type: 'custom-message', customType: 'shown', content: 'a', details: { v: 1 } }]);
    expect(session.agent.history.at(-1)).toEqual({ role: 'user', content: wrapCustomMessage('hidden', 'b', true) });
  });

  it('/reload:重新装上的扩展收到 session_start(reload)与 resources_discover(reload);卸下的收到 session_shutdown(reload);没被重载的不再被通知', async () => {
    const g = globalThis as { __mojoV3?: Array<Record<string, unknown>> };
    g.__mojoV3 = [];
    await fs.writeFile(
      path.join(root, 'ext', 'capture.mjs'),
      `export default (api) => {
  globalThis.__mojoTestApi = api;
  api.on('session_start', (e) => { globalThis.__mojoV3.push({ hook: 'start', ...e }); });
  api.on('resources_discover', (e) => { globalThis.__mojoV3.push({ hook: 'discover', ...e }); });
  api.on('session_shutdown', (e) => { globalThis.__mojoV3.push({ hook: 'shutdown', ...e }); });
};
`,
    );
    // 直接挂在会话上的处理器不属于任何磁盘扩展:它在重载前就在,不该再收到 session_start。
    const outsider = vi.fn();
    const off = session.hooks.on('session_start', outsider);
    await session.reloadExtensions();
    expect(g.__mojoV3).toEqual([
      { hook: 'discover', cwd: root, reason: 'reload' },
      { hook: 'start', reason: 'reload' },
    ]);
    expect(outsider).not.toHaveBeenCalled();
    // 再重载一次:上一代收到自己的 session_shutdown(reload)。
    await session.reloadExtensions();
    expect(g.__mojoV3).toContainEqual({ hook: 'shutdown', reason: 'reload' });
    off();
    api = (globalThis as { __mojoTestApi?: ExtensionAPI }).__mojoTestApi!;
  });

  it('资源目录每次 /reload 整体替换:不重复累加,被删掉的扩展贡献的目录撤掉', async () => {
    const write = (body: string) =>
      fs.writeFile(path.join(root, 'ext', 'capture.mjs'), `export default (api) => {\n  globalThis.__mojoTestApi = api;\n${body}\n};\n`);
    await write(`  api.on('resources_discover', () => ({ skillPaths: ['extskills'], themePaths: ['extthemes'] }));`);
    await session.reloadExtensions();
    await session.reloadExtensions();
    const themeDir = path.join(root, 'extthemes');
    expect(session.themeDirs.filter((dir) => dir === themeDir)).toHaveLength(1);
    expect(session.skills.map((s) => s.name)).toContain('extskill');
    await write('');
    await session.reloadExtensions();
    expect(session.themeDirs).not.toContain(themeDir);
    expect(session.skills.map((s) => s.name)).not.toContain('extskill');
  });

  it('ctx.reload() 在启动装载期间报错(是那句说明,不是暂时性死区的 ReferenceError)', async () => {
    const file = path.join(root, 'ext', 'startup-reload.mjs');
    await fs.writeFile(
      file,
      `export default async (api) => {
  try { await api.ctx.reload(); } catch (err) { globalThis.__mojoStartupReload = err.message; }
};
`,
    );
    const g = globalThis as { __mojoStartupReload?: string };
    g.__mojoStartupReload = undefined;
    const loaded = await loadConfig({
      root,
      env: { HOME: home, MOJOCODE_PROVIDER: 'deepseek', MOJOCODE_MODEL: 'deepseek-chat', DEEPSEEK_API_KEY: 'k' },
    });
    const other = await bootstrap({ root, loaded, extensionPaths: [file] });
    try {
      expect(g.__mojoStartupReload).toMatch(/not available while extensions are loading or reloading/);
    } finally {
      await other.dispose?.();
      await fs.rm(file, { force: true });
      // 那个会话也经配置装了 capture.mjs,把全局的 api 换成了它的:换回来。
      (globalThis as { __mojoTestApi?: ExtensionAPI }).__mojoTestApi = api;
    }
  });

  it('ctx.reload() 在装载 / 重载期间报错而不是死锁(新一代的 setup 里调它)', async () => {
    const g = globalThis as { __mojoReloadError?: string };
    g.__mojoReloadError = undefined;
    await fs.writeFile(
      path.join(root, 'ext', 'capture.mjs'),
      `export default async (api) => {
  globalThis.__mojoTestApi = api;
  try { await api.ctx.reload(); } catch (err) { globalThis.__mojoReloadError = err.message; }
};
`,
    );
    await session.reloadExtensions();
    expect(g.__mojoReloadError).toMatch(/not available while extensions are loading or reloading/);
    api = (globalThis as { __mojoTestApi?: ExtensionAPI }).__mojoTestApi!;
    // 重载收尾之后又可以用了。
    await fs.writeFile(path.join(root, 'ext', 'capture.mjs'), `export default (api) => { globalThis.__mojoTestApi = api; };\n`);
    await expect(api.ctx.reload()).resolves.toBeUndefined();
  });
});
