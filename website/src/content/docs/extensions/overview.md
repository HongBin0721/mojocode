---
title: 扩展
description: 一个 TypeScript 文件就是一个扩展:钩子、命令、工具、状态行。
---

mojocode 的扩展与 [pi](https://github.com/badlogic/pi-mono) 同一套形状:一个 TypeScript / JavaScript 模块,默认导出一个函数,拿到 `api` 后注册钩子、命令、工具。钩子名、API 成员名、钩子载荷的字段名与渲染层都刻意与 Pi **同名**——学过 Pi 就会写这里的扩展;字段与语义仍不一样的地方见文末的[对照](#与-pi-的差异)。扩展与 TUI 跑在同一个进程里(Pi 的形态):命令表与状态行直接进菜单与输入框上方,用户可见的提示走时间线 notice,向用户提问、挂自己的界面走 `ctx.ui`。

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
| `session_start` | 会话就位之后(`reason`:`startup` / `new` / `resume` / `fork` / `reload`),历史与状态已换好;换会话时带 `previousSessionFile`(上一个会话文件的绝对路径)。`reload` 只发给 `/reload` 重新装上的扩展,它们在这里从会话记录恢复自己的状态 | 无 | 只上报 |
| `session_shutdown` | `{ reason: 'quit' \| 'reload' }`:进程退出,或 `/reload` 卸载这个扩展。换会话**不**发(扩展的运行时跨会话活着) | 无 | 只上报 |
| `input` | 用户输入进入对话之前,`{ text, images, source: 'turn' \| 'guidance' }`;扩展与技能发起的消息不经它 | `{ action: 'transform', text }` 改写;`{ action: 'handled' }` 吞掉(这一轮不开) | 保留原值 |
| `agent_start` | 一次 run 的链条开始,`{ userText }` | 无 | 只上报 |
| `before_agent_start` | 每次开流前,`{ systemPrompt, prompt }` | `{ systemPrompt }` 改写发出去的系统提示词;`{ message }` 进本轮上下文(只在本轮首个流注入):字符串是一条 user 消息,Pi 的 `{ customType, content, display?, details? }` 以自定义消息进历史并上时间线(`display: false` 不上) | 保留原值 |
| `context` | 每次调模型之前,`{ messages }` 是这次要发出去的副本 | `{ messages }` 改写这一次请求,持久历史不动 | 保留原值 |
| `before_provider_request` | 发给 provider 之前(AI SDK 中间件),`{ params, type }`——prompt / tools / providerOptions / headers 全在 `params` 里 | `{ params }` 替换 | 保留原值 |
| `tool_call` | 工具执行前,`{ toolCallId, toolName, input }` | `{ block: true, reason }` 否决 | **失败即否决** |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | 工具真正开始(`args`)/ 流式增量(`partialResult`)/ 执行完毕(原始 `result`、`durationMs`)。都带 `toolCallId` 与 `toolName` | 无 | 只上报 |
| `tool_result` | 工具执行后、结果喂回模型前,`{ toolCallId, output, content, details, isError }`(`content` 是模型看到的内容部件,`details` 是 Pi 形状工具给画法的数据) | `{ output }` 整个换掉;或 Pi 的 `{ content, details, isError }`:`content` 换掉模型看到的内容,`details` 换掉给画法的数据,`isError` 把成功改判成错误或反过来 | 保留原值 |
| `message_start` / `message_update` | 一条 assistant 消息开始流出(每个 step 一条)/ 每份流式增量,`{ message }` 是累积到此刻的部分消息,`message_update` 另带 `{ delta: { type: 'text' \| 'reasoning', id, text } }`。没人监听时不组装,零开销 | 无 | 只上报 |
| `message_end` | 每条定稿的 assistant / tool 消息并入历史之前,`{ message }` | `{ message }` 替换 | 保留原值 |
| `user_bash` | 用户在输入框敲 `!<command>`,执行之前,`{ command, cwd }` | `{ command }` 改写要跑的命令;`{ run({ command, cwd, signal }) }` 接管执行(在容器里跑、走远程主机),返回 `{ exitCode, output }`。输出以 `user_bash` 类型的自定义消息并入历史,不开轮 | 当没说话 |
| `session_before_compact` | 压缩之前,`{ reason: 'manual' \| 'auto' \| 'in-turn', messages }` | `{ cancel: true }` 跳过这次 | 视同不取消 |
| `session_compact` | 压缩完成,`{ reason, removedMessages, summaryChars }` | 无 | 只上报 |
| `model_select` / `thinking_level_select` | 模型 / 思考档位切换:`{ provider, model, previousProvider, previousModel, source: 'set' }` / `{ level, previousLevel }` | 无 | 只上报 |
| `turn_start` | 一轮开始,`{ userText }` | 无 | 只上报 |
| `turn_end` | 一轮完全收尾(历史已落盘),`{ outcome, usage, error }` | 无;在这里 `followUp` 排下一轮 | 只上报 |
| `agent_end` | 一次 run 的整个链条结束,`{ aborted, followUpsDropped }` | 无 | 只上报 |
| `agent_settled` | `agent_end` 之后确认空闲(没有扩展在 `agent_end` 里又开了链条) | 无 | 只上报 |
| `after_provider_response` | provider 应答之后(AI SDK 中间件),`{ type, params, response }` | 无 | 只上报 |
| `session_before_switch` / `session_before_fork` | 即将 `/new` 或 `/resume` / `/fork`(含扩展的 `newSession` / `switchSession` / `fork`):`{ reason: 'new' \| 'resume', id?, targetSessionFile? }`(resume 时 id 已解析好前缀)/ 无 | `{ cancel: true }` 取消:命令路径提示失败,扩展的 ctx 路径拿到 `{ cancelled: true }` | 视同不取消 |
| `session_switch` / `session_fork` | 已切到 / 已分叉出新会话(`session_start` 之后),`{ id }` 是新会话 id | 无 | 只上报 |
| `resources_discover` | 收集资源目录,`{ cwd, reason: 'startup' \| 'reload' }`:启动时问全部扩展,每次 `/reload` 之后再问一遍全部,结果整体替换上一次的(被删掉的扩展贡献的目录随之撤掉) | `{ skillPaths, promptPaths, themePaths }`,相对工作区根:技能目录、提示词模板目录(每个 `*.md` 一条 `/name`)、主题目录(`<name>.json`) | 跳过 |

字段名以 Pi 的为准。这里早先的几个同义叫法——`callId`(即 `toolCallId`)、工具执行钩子里的 `input` / `output` / `chunk`(即 `args` / `result` / `partialResult`)、`before_agent_start` 的 `userText`(即 `prompt`)——**已弃用**:迁移期内仍然填着值、类型上带 `@deprecated` 删除线,之后的版本会删掉。`tool_call` / `tool_result` 的 `input` 与 `tool_result` 的 `output` 不在此列:前者 Pi 自己就这么叫,后者是工具的原始结构化返回,Pi 没有对应。

`tool_call` 失败即否决是刻意的:没有权限系统之后它是拦截扩展唯一的卡口,一个抛错的处理器若被当成放行,等于扩展一有 bug 工具就全部裸跑。所有钩子失败都变成时间线上的一条提示,绝不冒泡进 agent 循环。

## ctx:处理器的第二个参数

钩子与命令处理器都收 `ctx`(`api.ctx` 也是它),与 Pi 的 `ctx` 同形:`cwd`、`hasUI`、`mode`(`'tui' | 'print'`)、`isIdle()`、`abort()`、`signal`(正在流的这一轮的 AbortSignal,没有流在跑时 `undefined`——两轮之间也是)、`hasPendingMessages()`、`shutdown()`(优雅退出:中断当前轮,TUI 走与双 ctrl+c 同一条退出路径,`-p` 下由 CLI 正常收尾、还没开跑的那一轮不再开)、`getSystemPrompt()`(核心组装的原文;`before_agent_start` 的改写只在开流那一刻存在)、`getContextUsage()`、`compact({ customInstructions?, onComplete?, onError? })`(指令拼在缺省摘要指令之后;给了 `onError` 就不再 reject)、`waitForIdle()`、`newSession(options?)`、`fork(options?)`、`switchSession(id, options?)`、`reload()`(与 `/reload` 同一条路;在自己的处理器里调它会把自己卸掉,处理器余下的代码跑在旧闭包里。扩展装载与重载进行期间调用直接报错——那时调它等于等一个正在等自己的重载)、`model(id?)`、`config`、`sessionManager`、`modelRegistry`,以及与界面打交道的 `ui`。三个会话操作返回 `{ cancelled }`(`fork` 成功时另带 `id`):`session_before_switch` / `session_before_fork` 的否决是回执不是异常,会话不存在之类的真错误照常抛;`options.withSession(ctx)` 在新会话就位后被调,收到的仍是这个 `ctx`——它按引用读当前会话,切完就指向新的那一段。`sessionManager` 是当前会话的**只读**视图(`getSessionId` / `getSessionName` / `getEntries(type?)` / `getHistory` / `getDisplayHistory` / `listSessions`),写入走 API 上的同名成员;`modelRegistry` 是模型表(`getCurrent` / `getProviders` / `getModels(providerId?)` / `find` 同步读配置与预设里已知的模型,`capabilities(provider, model)` 查 models.dev 目录,`probe()` 在线探测,与 `/models` 同一条路)。`isIdle()` 与 `waitForIdle()` 是同一个判据:链条与压缩都不在跑才算空闲——压缩期间往历史里塞消息会被整体替换的历史吞掉。**`ctx` 是每个扩展自己的一份**,`ctx.ui.setWidget` 之类记在这个扩展名下,`/reload` 才撤得干净:

| 成员 | 说明 |
|---|---|
| `ui.select(title, items, opts?)` | 列表选一项;esc 为 `undefined`。`opts.timeout`(毫秒)到点按「没答」兑现,提示里倒数;`opts.signal` 中止同样按「没答」 |
| `ui.confirm(title, message, opts?)` | 是 / 否;esc、超时、中止都是 `false` |
| `ui.input(title, placeholder?, opts?)` | 一行文本;esc 为 `undefined` |
| `ui.editor(title, prefill?, opts?)` | 多行编辑框:回车提交,行尾 `\` + 回车换行;esc 为 `undefined` |
| `ui.custom((host, done) => component, options?)` | 挂一个自己画、自己处理按键的组件(Pi 的 `ctx.ui.custom`):缺省它顶掉输入框、独占键盘,`done(value)` 收尾并把 value 交回。`{ overlay: true }` 则浮在时间线之上、输入框留在原地(键盘仍归组件);`overlayOptions` 定位与尺寸(`width` / `height` / `min*` / `max*` 数字或百分比、`anchor` 九个位置或 `row` / `col` 绝对位置、`offsetX/Y`、`margin`、`visible(w, h)`);`onHandle(handle)` 拿到 `setHidden(bool)` / `hide()`。覆盖层**画着才拿键盘**:藏起来的(`setHidden(true)`、`visible` 说不画)把键盘还给输入框;拿着键盘时扩展的提问排在它后面,等它收尾再弹 |
| `ui.setWidget(key, lines \| factory, { placement? })` | 输入框上方(缺省)或下方(`'belowEditor'`)的一块小部件;`undefined` 清除 |
| `ui.setHeader(…)` / `ui.setFooter(…)` | 屏幕顶部的一块;替换底栏 |
| `ui.setTitle(title)` | 终端窗口标题 |
| `ui.setStatus(key, text)` | 输入框上方状态行里**这个扩展名下按 key 分的一条**;`undefined` 清除。与不带 key、带 `since` 走秒的 `api.setStatus` 并存 |
| `ui.setWorkingMessage(text)` | 工作状态线里替换「思考中 / 回复中」的文字(跑工具、压缩时不替换);`undefined` 恢复 |
| `ui.setWorkingVisible(visible)` | `false` 时整条工作状态线不画(跑着也不画),输入框顶边回到空闲的纯线 |
| `ui.setWorkingIndicator({ frames, intervalMs? })` | 换 spinner 的帧:`['●']` 静态标记,`[]` 不画 spinner,自定义帧原样画(颜色自己带);`intervalMs` 缺省 100,最低 16;不给恢复缺省动画 |
| `ui.setHiddenThinkingLabel(label?)` | 折叠的思考块那一行的标签(缺省「已思考 …」);不给恢复 |
| `ui.setEditorComponent((host, submit) => component)` / `ui.getEditorComponent()` | 顶替缺省输入框:组件自己画、自己收键,`submit(text)` 与在缺省输入框回车同一条路(斜杠命令、`!` 命令、@ 引用照常);组件可选实现 `getText` / `setText` / `insertText`,`getEditorText` / `setEditorText` / `pasteToEditor` 经它们落地(没实现 `insertText` 时粘贴退化成追加到末尾);`undefined` 恢复。`getEditorComponent` 读回当前工厂 |
| `ui.theme` | 给行上色的主题面(`fg(name, text)` / `bold` / `dim` / `italic`),与组件的 `host.theme` 同一份,headless 下也有 |
| `ui.getAllThemes()` / `ui.getTheme(name)` / `ui.setTheme(name \| colors)` | 列可选主题(内置 `default` + 各目录的 `<name>.json`)、按名读一套配色、切换配色(给名字或直接给 `colors` 对象)。与 `/theme` 不同:**不落盘、不整树重挂**,只让读过 `theme.x` 的节点重算——自动跟随系统明暗的扩展随时会调它,不该清用户的草稿。三个都是 Promise(Pi 的是同步的,它启动时预扫;这里现扫目录)。连着调 `setTheme` 时只有最后一次生效,先发的回报 `{ success: false }` |
| `ui.getToolsExpanded()` / `ui.setToolsExpanded(expanded)` | ctrl+r 的详情开关(思考正文、工具输出);headless 恒 `false` / 忽略 |
| `ui.onTerminalInput(handler)` | 监听原始终端序列(在 TUI 解析成按键**之前**):返回 `{ consume: true }` 就吞掉,任何组件都不再收到。返回注销函数。没有 Pi 的 `data` 改写 |
| `ui.getEditorText()` / `ui.setEditorText(text)` / `ui.pasteToEditor(text)` | 读 / 写输入框草稿;在光标处插入 |
| `ui.notify(message, level?)` | 与 `api.notify` 同一条路;`level` 是 `info` / `warn` / `error`(Pi 拼法的 `warning` 也认),`error` 红色 `✗` 前缀 |

挂着扩展编辑器或覆盖层式 `ui.custom` 时,**一轮正跑着的 `esc` 永远是「中断」,不转发给组件**——全交给组件的话,一个不处理 `esc` 的编辑器扩展会让用户只剩双 `ctrl+c`,而那是退出整个程序。空闲时 `esc` 照常归组件(`esc` `esc` 回退选择器因此在扩展编辑器挂着时不可用,那是「键盘归组件」这条契约的应有之义)。

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
| `sendMessage({ customType, content, display?, details? }, { triggerTurn?, deliverAs? })` | 放一条带类型的消息进对话(Pi 的 sendMessage)。`deliverAs`:`steer` 运行中作为轮内引导,`followUp` 等当前链条收尾后作为新的一轮,`nextTurn` 不打断也不开轮、等下一次**用户**提问(含斜杠技能)时紧跟在那条消息之后进历史;`triggerTurn` 管空闲时开不开轮。不给 `deliverAs` 保持原有语义(运行中 `triggerTurn` 排在链条之后,否则作为引导)。`content` 可以是 Pi 的部件数组(只取文字);`display: false` 进对话但不上时间线(标记写在历史的信封里,`/resume` 回放同样不画),字符串是替代文本;`details` 交给 `registerMessageRenderer`。替代文本与 `details` 都只在本次会话的时间线里,不进持久历史(`/resume` 回放拿不到)。运行中的 `steer` 若恰好碰上这一轮收尾,按空闲处理(`triggerTurn` 就开轮,否则并入历史),不会丢。历史里是 `[extension message: <type>]` 信封,回放认得 |
| `sendUserMessage(content, { deliverAs? })` | 以用户身份发一条消息(Pi 的 sendUserMessage):空闲时开新的一轮(不等它跑完);运行中必须给 `deliverAs: 'steer' \| 'followUp'`,否则抛错。`content` 的图片部件作为图片附件。不经 `input` 钩子。`ctx` 上也有这两个成员(Pi 的 `withSession` 回调里用的就是它们) |
| `registerMessageRenderer(customType, (message, theme) => lines)` | 自定义消息在时间线里的画法;没注册就画 `[type]` 标签加正文 |
| `mode` / `waitForIdle()` / `newSession(options?)` / `fork(options?)` / `switchSession(id, options?)` | 同 ctx 的同名成员;其余控制面(`signal` / `shutdown` / `reload` / `getSystemPrompt` / `hasPendingMessages`)只在 `ctx` 上,与 Pi 一致 |
| `registerTool(name, (scope) => Tool \| undefined, { promptSnippet?, promptGuidelines?, renderCall?, renderResult? }?)` / `unregisterTool(name)` | 模型可调用的工具。传工厂而不是工具本身,按 `scope.subagent` / `scope.mode`(`general` / `explore`)自己决定给不给。内置工具名不可覆盖。带自述的工具由宿主汇成系统提示词的「Extension tools」一节,与实际注册的工具永远一致 |
| `registerTool({ name, description, parameters, execute, promptSnippet?, promptGuidelines?, renderCall?, renderResult?, scope? })` | Pi 形状的工具定义:`parameters` 是 JSON Schema(TypeBox 的 schema 直接可用),`execute(toolCallId, params, signal, onUpdate, ctx)` 同签名,返回 Pi 的 `{ content: [{ type: 'text', text }], details? }`——模型只看 `content` 拼成的文本,**整个对象**(含 `details`)交给 `renderResult` 与 `tool_result` 钩子,`details` 不进持久历史;`renderCall` / `renderResult` 返回字符串行 |
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
| `compact(options?)` / `getContextUsage()` | 同 ctx:手动压缩(与 `/compact` 同一条路,`customInstructions` 拼在缺省摘要指令之后,并发调用共享同一次);上下文占用 `{ used, window, percent }` |
| `appendEntry(type, data)` / `entries(type)` | 会话记录里的自定义记录:随会话分叉、随 `/resume` 读回。`session_start` 里从这里恢复自己的状态 |
| `getSessionName()` / `setSessionName(name)` | 会话标题(会话列表里那一行) |
| `config` | 会话配置,按引用 |
| `model(modelId?)` | 当前服务商的模型;传 id 换同一服务商的另一个模型(评估器、便宜模型) |
| `getModel()` / `setModel({ provider?, model? })` | 当前 provider 与模型 id;切换(与 `/models` 同一条路,触发 `model_select`) |
| `getThinkingLevel()` / `setThinkingLevel(level)` | 思考档位(与 `/think` 同一条路,触发 `thinking_level_select`) |
| `exec(command, args, { cwd?, timeoutMs?, timeout?, signal?, env? })` | 跑一个外部命令,不经 shell,非零退出码不抛(看 `exitCode`)。`timeout` 是 Pi 的叫法,同 `timeoutMs` |

三个「对外说话」的成员分工别混:`setStatus` 是一行给人看的文字,`setState` 是数据,`publishRuntime` 只给 `/doctor`。

## 命令处理器的纪律

处理器里 await 几秒的 git 会让 `/` 菜单卡在提交上。要发起一轮就 `followUp`,要做长活就放到后台,处理器同步返回。忙不忙由扩展按参数自己判,TUI 不替扩展拦(`/goal clear` 正是循环跑着的时候才要用的)。

## 一方扩展

`goal` / `review` / `todo` / `web` / `mcp` / `lsp` 六个内置扩展与磁盘扩展用的是同一份 API,它们的源码(`src/extensions/`)就是最完整的示例,见[内置扩展](/extensions/builtin/)。

## 与 Pi 的差异

装载、钩子、API 成员与渲染层都与 Pi 同构;刻意没有的是下面这一族:

| Pi 有、这里没有 | 这里的对应 |
|---|---|
| 会话树:`fork(entryId, { position })`、`navigateTree`、`setLabel`、`session_before_tree` / `session_tree` | 会话是线性 JSONL:`fork()` 只能整体分叉(仍返回 Pi 形状的 `{ cancelled }`,成功另带 `id`),没有 entry 可指 |
| `registerProvider`、`models.json` | provider 由配置层定义(`providers.<id>`),请求级改写用 `before_provider_request`;`ctx.modelRegistry` 只读 |
| 裸 `--my-flag` | `-X my-flag`(commander 对未声明选项只能整体放行,见 `src/extensions/flags.ts`) |
| pi-tui 的组件类(`Container`、`Text`、`SelectList`…) | 组件只需 `render(width)` + `handleInput`,自己拼行;`host.theme` / `ui.theme` 给颜色 |
| `ui.addAutocompleteProvider` | 没有。输入框的补全(斜杠命令、@ 文件)是内置的,扩展要自己的补全就 `setEditorComponent` 整个换掉输入框 |
| `onTerminalInput` 的 `{ data }` 改写 | 只有 `{ consume }`:OpenTUI 的输入处理器只能回答「吞不吞」 |
| `getAllThemes` / `getTheme` / `setTheme` 同步 | 三个都是 Promise——现扫目录而不是启动时预扫,主题文件可以随时往目录里加 |
| `ctx.sessionManager` 的写口、`newSession({ setup(sessionManager) })` 里的可写 `SessionManager` | 只读视图;写入走 `appendEntry` / `setSessionName`,新会话就位后的初始化放进 `withSession(ctx)` |

Pi 0.73 自己已经删掉的 `registerEntryRenderer` / `registerMarkdownTransformer` / `project_trust` 不在此列——两边都没有。

### 钩子载荷与 API 形状对照

名字对上之后,还有一批**同名但字段或语义不同**的地方。照 Pi 写的扩展碰到它们时读到的是 `undefined` 而不是报错,移植时逐条看一眼:

| 位置 | Pi | 这里 |
|---|---|---|
| 「轮」的粒度:`turn_start` / `turn_end` / `agent_start` / `agent_end` | turn 是**一次模型调用 + 它的工具调用**(`turnIndex`、`timestamp`、`message`、`toolResults`);agent 是一次提问 | turn 是**一次用户提问的整轮**(可含多步),载荷是 `userText` / `outcome` / `usage` / `aborted` / `followUpsDropped`;多步之间的单次调用没有对应的钩子 |
| `input` | `source: 'interactive' \| 'rpc' \| 'extension'`,`sendUserMessage` 也经过它 | `source: 'turn' \| 'guidance'`;扩展发起的消息不经过它 |
| `context` / `message_start` / `message_update` / `message_end` | Pi 自己的 `AgentMessage`;`message_update` 带 `assistantMessageEvent` | AI SDK 的 `ModelMessage`;`message_update` 带 `delta: { type, id, text }` |
| `session_before_compact` / `session_compact` | 带 `preparation` / `branchEntries` / `signal`,可以返回自己算好的 `compaction`;`compactionEntry` | 只有 `reason` / `messages`,只能 `{ cancel }`;`{ reason, removedMessages, summaryChars }` |
| `before_provider_request` / `after_provider_response` | `{ payload }` 返回新的 payload;`{ status, headers }` | `{ params, type }` 返回 `{ params }`(AI SDK 中间件的参数);`{ type, params, response }` |
| `model_select` | `model` / `previousModel` 是模型对象 | 是 id 字符串(另有 `provider` / `previousProvider`) |
| `user_bash` | 返回 `{ operations }` / `{ result }`;`!!` 的 `excludeFromContext` | 返回 `{ command }` 改写或 `{ run }` 接管;没有 `!!` |
| `session_shutdown` | 每次换会话都发(Pi 重建整个运行时) | 只在退出与 `/reload` 时发 |
| `ctx.model` | 属性,`Model \| undefined` | 方法 `model(id?)`,返回 AI SDK 的模型 |
| `getContextUsage()` | `{ tokens, contextWindow, percent }`(可为 null) | `{ used, window, percent }` |
| `getAllTools()` / `getCommands()` | 对象数组 | 名字数组 |
| `setModel` | 收模型对象,返回 `Promise<boolean>` | 收 `{ provider?, model? }` |
| 工具的 `renderCall` / `renderResult` | 返回组件,带渲染上下文(`isPartial`、`expanded`、`state`、`invalidate()`) | 返回字符串行,只收 `theme`(`renderResult` 另收 `{ isError, expanded, input }`) |
| 工具定义 | `prepareArguments`、`executionMode`、`renderShell` | 没有 |
| 命令的补全 | `getArgumentCompletions(prefix)` | `options(path)` 多级选择器 |

Pi 生态的扩展**不能**原样拿来跑:它们从 `@mariozechner/pi-coding-agent` 导入类型、用 pi-tui 的类拼界面。形状一致,改 import、把 pi-tui 的组件换成自己拼行即可。
