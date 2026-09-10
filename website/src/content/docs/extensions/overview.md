---
title: 扩展
description: 一个 TypeScript 文件就是一个扩展:钩子、命令、工具、状态行。
---

mojocode 的扩展与 [pi](https://github.com/badlogic/pi-mono) 同一套形状:一个 TypeScript / JavaScript 模块,默认导出一个函数,拿到 `api` 后注册钩子、命令、工具。钩子表、API 成员表与渲染层都刻意与 Pi **同名同义**——学过 Pi 就会写这里的扩展;剩下的差异见文末的对照。扩展与 TUI 跑在同一个进程里(Pi 的形态):命令表与状态行直接进菜单与输入框上方,用户可见的提示走时间线 notice,向用户提问、挂自己的界面走 `ctx.ui`。

```ts
// ~/.mojocode/extensions/no-rm.ts
export default (api) => {
  // 每次工具执行前被调用;返回 { block: true, reason } 即否决,
  // reason 作为工具错误喂回模型(保持英文),整轮不终结。
  api.on('tool_call', ({ toolName, input }) => {
    const cmd = String((input as { command?: unknown }).command ?? '');
    if (toolName === 'bash' && /\brm\s+-rf\b/.test(cmd)) {
      return { block: true, reason: 'rm -rf is blocked by the no-rm extension' };
    }
    return undefined;
  });

  api.registerCommand('hello', {
    description: 'say hi',
    handler: async (args, ctx) => {
      // 向用户提问:TUI 弹提示框,headless 下立即按缺省兑现(undefined / false)。
      const ok = await ctx.ui.confirm('hello', `say hi to ${args}?`);
      if (ok) api.notify('info', `hi ${args}`);
    },
  });
};
```

类型从 `mojocode/extension` 拿:`import type { ExtensionAPI, ExtensionComponent } from 'mojocode/extension'`。同一个入口还导出两个现成组件工厂 `selectList` / `textInput`(见下文)与 `ExtensionEvents`。

也接受 `export default { id, setup(api) {…} }`;id 缺省从文件名推(`foo.ts` → `foo`,`foo/index.ts` → `foo`,包里的再冠以 `<包名>/`)。`setup` 可以是 async。

## 装载顺序

三层来源加命令行,按这个顺序装;后装的同名命令 / 工具覆盖先装的,内置的一方扩展永远最先:

| 来源 | 位置 | 说明 |
|---|---|---|
| 扩展包 | `mojocode install …` 记在配置 `packages` 里 | 见[包管理](/extensions/packages/) |
| 全局目录 | `~/.mojocode/extensions/` | `*.ts` / `*.js` / `*.mjs`,或 `<name>/index.ts` |
| 项目目录 | `<项目>/.mojocode/extensions/` | 可随仓库提交 |
| 配置 | `extensions: ["路径", …]`(全局或项目配置) | 与 `-e` 同义但可持久化;相对路径按工作区根解析;两层取并集 |
| 命令行 | `mojocode -e <文件或目录>`,可重复 | 临时试一个扩展 |

扩展声明的命令行 flag(`api.registerFlag`)用 `mojocode -X name` / `-X name=value` 传(可重复),`api.getFlag(name)` 按声明的类型读。

TypeScript 直接放就行:单二进制(Bun)原生认 `.ts`,npm 安装的 Node 版本经 [jiti](https://github.com/unjs/jiti) 转译。装不上的扩展(语法错、setup 抛错、id 撞车)在启动时给一条提示然后跳过,不影响会话。`mojocode extensions` 列出本工作区会加载的全部扩展与来源。改了扩展文件之后在 TUI 里敲 `/reload`:磁盘扩展逐个卸载(钩子、命令、工具、快捷键、界面区域全部撤掉)再重新装载,内置扩展不动。

## 钩子

钩子异步、按注册顺序串行、返回值有意义。每个处理器收两个参数:输入,以及与 Pi 同形的 `ctx`(见下节)。每个输入都带 `subagent` 标记:子 agent(task 工具、fork 技能)与主 agent 共享同一份钩子表,要不要区别对待由扩展自己决定。

| 钩子 | 时机 | 返回值 | 失败策略 |
|---|---|---|---|
| `session_start` | 会话就位之后(`reason`:`startup` / `new` / `resume` / `fork`),历史与状态已换好 | 无 | 只上报 |
| `session_shutdown` | 会话关闭 | 无 | 只上报 |
| `input` | 用户输入进入对话之前,`{ text, images, source: 'turn' \| 'guidance' }`;扩展与技能发起的消息不经它 | `{ action: 'transform', text }` 改写;`{ action: 'handled' }` 吞掉(这一轮不开) | 保留原值 |
| `agent_start` | 一次 run 的链条开始,`{ userText }` | 无 | 只上报 |
| `before_agent_start` | 每次开流前,`{ systemPrompt, userText }` | `{ systemPrompt }` 改写发出去的系统提示词;`{ message }` 以一条 user 消息进本轮上下文(只在本轮首个流注入) | 保留原值 |
| `context` | 每次调模型之前,`{ messages }` 是这次要发出去的副本 | `{ messages }` 改写这一次请求,持久历史不动 | 保留原值 |
| `before_provider_request` | 发给 provider 之前(AI SDK 中间件),`{ params, type }`——prompt / tools / providerOptions / headers 全在 `params` 里 | `{ params }` 替换 | 保留原值 |
| `tool_call` | 工具执行前,`{ callId, toolName, input }` | `{ block: true, reason }` 否决 | **失败即否决** |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | 工具真正开始 / 流式增量(`chunk`)/ 执行完毕(原始 `output`、`durationMs`) | 无 | 只上报 |
| `tool_result` | 工具执行后、结果喂回模型前,`{ output, isError }` | `{ output }` 改写 | 保留原值 |
| `message_end` | 每条定稿的 assistant / tool 消息并入历史之前,`{ message }` | `{ message }` 替换 | 保留原值 |
| `session_before_compact` | 压缩之前,`{ reason: 'manual' \| 'auto' \| 'in-turn', messages }` | `{ cancel: true }` 跳过这次 | 视同不取消 |
| `session_compact` | 压缩完成,`{ reason, removedMessages, summaryChars }` | 无 | 只上报 |
| `model_select` / `thinking_level_select` | 模型 / 思考档位切换 | 无 | 只上报 |
| `turn_start` | 一轮开始,`{ userText }` | 无 | 只上报 |
| `turn_end` | 一轮完全收尾(历史已落盘),`{ outcome, usage, error }` | 无;在这里 `followUp` 排下一轮 | 只上报 |
| `agent_end` | 一次 run 的整个链条结束,`{ aborted, followUpsDropped }` | 无 | 只上报 |
| `agent_settled` | `agent_end` 之后确认空闲(没有扩展在 `agent_end` 里又开了链条) | 无 | 只上报 |
| `after_provider_response` | provider 应答之后(AI SDK 中间件),`{ type, params, response }` | 无 | 只上报 |
| `session_before_switch` / `session_before_fork` | 即将 `/resume` / `/fork`(含扩展的 `switchSession` / `fork`),`{ id }` / 无 | `{ cancel: true }` 取消,调用方收到错误 | 视同不取消 |
| `resources_discover` | 启动时(扩展装完之后)收集资源目录 | `{ skillPaths: [...] }`,相对工作区根 | 跳过 |

`tool_call` 失败即否决是刻意的:没有权限系统之后它是拦截扩展唯一的卡口,一个抛错的处理器若被当成放行,等于扩展一有 bug 工具就全部裸跑。所有钩子失败都变成时间线上的一条提示,绝不冒泡进 agent 循环。

## ctx:处理器的第二个参数

钩子与命令处理器都收 `ctx`(`api.ctx` 也是它),与 Pi 的 `ctx` 同形:`cwd`、`hasUI`、`mode`(`'tui' | 'print'`)、`isIdle()`、`abort()`、`waitForIdle()`、`newSession()`、`fork()`、`switchSession(id)`、`model(id?)`、`config`,以及与界面打交道的 `ui`。`isIdle()` 与 `waitForIdle()` 是同一个判据:链条与压缩都不在跑才算空闲——压缩期间往历史里塞消息会被整体替换的历史吞掉。**`ctx` 是每个扩展自己的一份**,`ctx.ui.setWidget` 之类记在这个扩展名下,`/reload` 才撤得干净:

| 成员 | 说明 |
|---|---|
| `ui.select(title, items)` | 列表选一项;esc 为 `undefined` |
| `ui.confirm(title, message)` | 是 / 否;esc 为 `false` |
| `ui.input(title, placeholder?)` | 一行文本;esc 为 `undefined` |
| `ui.custom((host, done) => component)` | 挂一个自己画、自己处理按键的组件(Pi 的 `ctx.ui.custom`):它顶掉输入框、独占键盘,`done(value)` 收尾并把 value 交回 |
| `ui.setWidget(key, lines \| factory)` | 输入框上方的一块小部件;`undefined` 清除 |
| `ui.setHeader(…)` / `ui.setFooter(…)` | 屏幕顶部的一块;替换底栏 |
| `ui.setTitle(title)` | 终端窗口标题 |
| `ui.getEditorText()` / `ui.setEditorText(text)` | 读 / 写输入框草稿 |
| `ui.notify(message, level?)` | 与 `api.notify` 同一条路 |

两个现成的组件工厂免得每个扩展重写光标与退格:`selectList({ items, onSelect, onCancel?, title?, window? })` 与 `textInput({ placeholder?, initial?, onSubmit, onCancel? })`,都返回可直接交给 `ui.custom` / `setWidget` 的工厂(在 `ui.custom` 里把 `done` 接到 `onSelect` / `onSubmit` 上)。

组件的形状是 Pi 的 `Component`:`render(width): string[]`(行里可带 ANSI 颜色,`host.theme.fg('accent', …)` 之类给你上色),可选 `handleInput(data, key)`——`data` 是 Pi 风格的原始序列(可打印字符原样、esc 为 `\x1b`、回车 `\r`、方向键为 CSI 序列),`key` 是解析结果,二选一用。`host.requestRender()` 要求重画。widget / header / footer 只画不收键;`custom` 收。工具定义的 `renderCall(input, theme)` / `renderResult(output, options, theme)` 返回字符串行,替换时间线里那个工具项的缺省画法;返回 `undefined` 或抛错都退回缺省。

**没有前端在看**(`mojocode -p`)时提问类立即按缺省兑现(`select` / `input` / `custom` 给 `undefined`、`confirm` 给 `false`)——与用户按 esc 是同一个结局,扩展不必分辨两种来路;区域类的设置被忽略。`hasUI` 只是给想提前绕开提问的扩展用的。

## ExtensionAPI

| 成员 | 作用 |
|---|---|
| `id` / `root` | 扩展 id;工作区根目录 |
| `on(hook, handler)` | 注册钩子,返回注销函数 |
| `onEvent(handler)` | 只读订阅事件总线(text-delta、tool-end、step-end 等) |
| `events` | 扩展之间的事件总线(`on(type, handler)` / `emit(type, data)`),与上面那条无关 |
| `ctx` / `ui` / `hasUI` | 处理器收到的那个 ctx(见上节);`ui` 与 `hasUI` 是它的两个成员 |
| `registerCommand(name, { description, argumentHint?, selectorTitle?, options?, handler })` / `getCommands()` | 斜杠命令。`options(path)` 给了就先进选择器,支持多级(`expands`)与预填(`prefill`);`handler(args, ctx)` **不要在里面 await 一整轮** |
| `registerShortcut(key, { description, handler })` | 全局快捷键,`key` 形如 `ctrl+g` / `meta+shift+k`,必须带 ctrl 或 meta;TUI 自己占着的 ctrl+c / ctrl+t / ctrl+o / ctrl+r **注册即报错**;覆盖层打开时不派发。返回注销函数 |
| `sendMessage({ customType, content, display? }, { triggerTurn? })` | 放一条带类型的消息进对话(Pi 的 sendMessage):`triggerTurn` 作为新一轮开跑;否则运行中注入为引导、空闲时并入历史不开轮。历史里是 `[extension message: <type>]` 信封,回放认得 |
| `registerMessageRenderer(customType, (message, theme) => lines)` | 自定义消息在时间线里的画法;没注册就画 `[type]` 标签加正文 |
| `mode` / `waitForIdle()` / `newSession()` / `fork()` / `switchSession(id)` | 同 ctx 的同名成员 |
| `registerTool(name, (scope) => Tool \| undefined, { promptSnippet?, promptGuidelines?, renderCall?, renderResult? }?)` / `unregisterTool(name)` | 模型可调用的工具。传工厂而不是工具本身,按 `scope.subagent` / `scope.mode`(`general` / `explore`)自己决定给不给。内置工具名不可覆盖。带自述的工具由宿主汇成系统提示词的「Extension tools」一节,与实际注册的工具永远一致 |
| `registerTool({ name, description, parameters, execute, promptSnippet?, promptGuidelines?, renderCall?, renderResult?, scope? })` | Pi 形状的工具定义:`parameters` 是 JSON Schema(TypeBox 的 schema 直接可用),`execute(toolCallId, params, signal, onUpdate, ctx)` 同签名,返回 Pi 的 `{ content: [{ type: 'text', text }] }` 会拼成文本喂回模型;`renderCall` / `renderResult` 返回字符串行 |
| `getAllTools()` / `getActiveTools()` / `setActiveTools(names \| undefined)` | 主工具集里的全部工具名;当前交给模型的;只把这些交给模型(主 agent 与子 agent 都按此过滤),其余仍注册着 |
| `registerFlag(name, { description, type, default? })` / `getFlag(name)` | 命令行 flag(`-X name[=value]`) |
| `setStatus(text, { since? })` | 输入框上方的一行状态,`undefined` 清除;带 `since` 的条目客户端自己走秒 |
| `setState(key, value)` | 结构化状态交给 TUI,TUI 按 key 渲染(todo 清单就是这样);值要可 JSON |
| `notify(level, message)` | 时间线上的一条提示,`info` / `warn` |
| `publishRuntime(key, get)` | 把运行时快照挂给宿主,目前只有 `/doctor` 读 |
| `run(text, { display?, images? })` | 发起一轮;运行中退化为轮内引导。扩展发起的消息不再经 `input` 钩子 |
| `followUp(text, options?)` | 当前链条收尾后作为新一轮开跑,空闲时立即开跑 |
| `isRunning()` / `abort()` | 忙碌状态;中断 |
| `history()` | 模型历史(压缩后是摘要加尾巴) |
| `compact()` / `getContextUsage()` | 手动压缩(与 `/compact` 同一条路);上下文占用 `{ used, window, percent }` |
| `appendEntry(type, data)` / `entries(type)` | 会话记录里的自定义记录:随会话分叉、随 `/resume` 读回。`session_start` 里从这里恢复自己的状态 |
| `getSessionName()` / `setSessionName(name)` | 会话标题(会话列表里那一行) |
| `config` | 会话配置,按引用 |
| `model(modelId?)` | 当前服务商的模型;传 id 换同一服务商的另一个模型(评估器、便宜模型) |
| `getModel()` / `setModel({ provider?, model? })` | 当前 provider 与模型 id;切换(与 `/models` 同一条路,触发 `model_select`) |
| `getThinkingLevel()` / `setThinkingLevel(level)` | 思考档位(与 `/think` 同一条路,触发 `thinking_level_select`) |
| `exec(command, args, { cwd?, timeoutMs?, signal?, env? })` | 跑一个外部命令,不经 shell,非零退出码不抛(看 `exitCode`) |

三个「对外说话」的成员分工别混:`setStatus` 是一行给人看的文字,`setState` 是数据,`publishRuntime` 只给 `/doctor`。

## 命令处理器的纪律

处理器里 await 几秒的 git 会让 `/` 菜单卡在提交上。要发起一轮就 `followUp`,要做长活就放到后台,处理器同步返回。忙不忙由扩展按参数自己判,TUI 不替扩展拦(`/goal clear` 正是循环跑着的时候才要用的)。

## 一方扩展

`goal` / `review` / `todo` / `web` / `mcp` / `lsp` 六个内置扩展与磁盘扩展用的是同一份 API,它们的源码(`src/extensions/`)就是最完整的示例,见[内置扩展](/extensions/builtin/)。

## 与 Pi 的差异

装载、钩子、API 成员与渲染层都与 Pi 同构;刻意没有的是下面这一族:

| Pi 有、这里没有 | 这里的对应 |
|---|---|
| `registerEntryRenderer` / `registerMarkdownTransformer` | 自定义消息用 `registerMessageRenderer`,工具项用 `renderCall` / `renderResult`,其余用 `setWidget` / `setState` |
| 会话树:`fork(entryId)`、`navigateTree`、`setLabel`、`session_before_tree` | 会话是线性 JSONL,`/fork` 整体复制 |
| `registerProvider`、`models.json` | provider 由配置层定义(`providers.<id>`),请求级改写用 `before_provider_request` |
| `project_trust` | 没有权限系统(用户拍板,与 Pi 一致) |
| 裸 `--my-flag` | `-X my-flag`(commander 对未声明选项只能整体放行,见 `src/extensions/flags.ts`) |
| pi-tui 的组件类(`Container`、`Text`、`SelectList`…) | 组件只需 `render(width)` + `handleInput`,自己拼行;`host.theme` 给颜色 |

Pi 生态的扩展**不能**原样拿来跑:它们从 `@mariozechner/pi-coding-agent` 导入类型、用 pi-tui 的类拼界面。形状一致,改 import、把 pi-tui 的组件换成自己拼行即可。
