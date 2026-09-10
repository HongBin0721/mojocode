---
title: 扩展
description: 一个 TypeScript 文件就是一个扩展:钩子、命令、工具、状态行。
---

mojocode 的扩展与 [pi](https://github.com/badlogic/pi-mono) 同一套形状:一个 TypeScript / JavaScript 模块,默认导出一个函数,拿到 `api` 后注册钩子、命令、工具。扩展跑在会话进程里(受管的 server 子进程),命令表与状态行经状态快照过线到 TUI 与 GUI,用户可见的提示走时间线 notice。

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
    handler: (args) => api.notify('info', `hi ${args}`),
  });
};
```

npm 包目前不附带类型声明,`api` 的完整类型见仓库里的 `src/core/extension.ts`(下文的 ExtensionAPI 表就是它的投影)。

也接受 `export default { id, setup(api) {…} }`;id 缺省从文件名推(`foo.ts` → `foo`,`foo/index.ts` → `foo`,包里的再冠以 `<包名>/`)。`setup` 可以是 async。

## 装载顺序

三层来源加命令行,按这个顺序装;后装的同名命令 / 工具覆盖先装的,内置的一方扩展永远最先:

| 来源 | 位置 | 说明 |
|---|---|---|
| 扩展包 | `mojocode install …` 记在配置 `packages` 里 | 见[包管理](/extensions/packages/) |
| 全局目录 | `~/.mojocode/extensions/` | `*.ts` / `*.js` / `*.mjs`,或 `<name>/index.ts` |
| 项目目录 | `<项目>/.mojocode/extensions/` | 可随仓库提交 |
| 命令行 | `mojocode -e <文件或目录>`,可重复 | 临时试一个扩展 |

TypeScript 直接放就行:单二进制(Bun)原生认 `.ts`,npm 安装的 Node 版本经 [jiti](https://github.com/unjs/jiti) 转译。装不上的扩展(语法错、setup 抛错、id 撞车)在启动时给一条提示然后跳过,不影响会话。`mojocode extensions` 列出本工作区会加载的全部扩展与来源。

## 钩子

钩子异步、按注册顺序串行、返回值有意义。每个输入都带 `subagent` 标记:子 agent(task 工具、fork 技能)与主 agent 共享同一份钩子表,要不要区别对待由扩展自己决定。

| 钩子 | 时机 | 返回值 | 失败策略 |
|---|---|---|---|
| `session_start` | 会话就位之后(`reason`:`startup` / `new` / `resume` / `fork`),历史与状态已换好 | 无 | 只上报 |
| `session_shutdown` | 会话关闭 | 无 | 只上报 |
| `before_agent_start` | 每次开流前,收到组装好的 `systemPrompt` | `{ systemPrompt }` 改写发出去的系统提示词 | 保留原值 |
| `tool_call` | 工具执行前,`{ callId, toolName, input }` | `{ block: true, reason }` 否决 | **失败即否决** |
| `tool_result` | 工具执行后、结果喂回模型前,`{ output, isError }` | `{ output }` 改写 | 保留原值 |
| `turn_start` | 一轮开始,`{ userText }` | 无 | 只上报 |
| `turn_end` | 一轮完全收尾(历史已落盘),`{ outcome, usage, error }` | 无;在这里 `followUp` 排下一轮 | 只上报 |
| `agent_end` | 一次 run 的整个链条结束,`{ aborted, followUpsDropped }` | 无 | 只上报 |

`tool_call` 失败即否决是刻意的:没有权限系统之后它是拦截扩展唯一的卡口,一个抛错的处理器若被当成放行,等于扩展一有 bug 工具就全部裸跑。所有钩子失败都变成时间线上的一条提示,绝不冒泡进 agent 循环。

## ExtensionAPI

| 成员 | 作用 |
|---|---|
| `id` / `root` | 扩展 id;工作区根目录 |
| `on(hook, handler)` | 注册钩子,返回注销函数 |
| `onEvent(handler)` | 只读订阅事件总线(text-delta、tool-end、step-end 等) |
| `registerCommand(name, { description, argumentHint?, selectorTitle?, options?, handler })` | 斜杠命令。`options(path)` 给了就先进选择器,支持多级(`expands`)与预填(`prefill`);`handler(args)` 是即时 RPC,**不要在里面 await 一整轮** |
| `registerTool(name, (scope) => Tool \| undefined)` / `unregisterTool(name)` | 模型可调用的工具。传工厂而不是工具本身,按 `scope.subagent` / `scope.mode`(`general` / `explore`)自己决定给不给。内置工具名不可覆盖 |
| `setStatus(text, { since? })` | 输入框上方的一行状态,`undefined` 清除;带 `since` 的条目客户端自己走秒 |
| `setState(key, value)` | 结构化状态过线给客户端,客户端按 key 渲染(todo 清单就是这样);值要小且可 JSON |
| `notify(level, message)` | 时间线上的一条提示,`info` / `warn` |
| `publishRuntime(key, get)` | 把会话内的运行时快照挂给宿主,目前只有 `/doctor` 读;值不过线 |
| `run(text, { display?, images? })` | 发起一轮;运行中退化为轮内引导 |
| `followUp(text, options?)` | 当前链条收尾后作为新一轮开跑,空闲时立即开跑 |
| `isRunning()` / `abort()` | 忙碌状态;中断 |
| `history()` | 模型历史(压缩后是摘要加尾巴) |
| `appendEntry(type, data)` / `entries(type)` | 会话记录里的自定义记录:随会话分叉、随 `/resume` 读回。`session_start` 里从这里恢复自己的状态 |
| `config` | 会话配置,按引用 |
| `model(modelId?)` | 当前服务商的模型;传 id 换同一服务商的另一个模型(评估器、便宜模型) |

三个「对外说话」的成员分工别混:`setStatus` 是一行给人看的文字,`setState` 是数据,`publishRuntime` 不过线。

## 命令处理器的纪律

`runCommand` 走客户端那条串行的 RPC 队列。处理器里 await 几秒的 git 会把用户随后的每一条消息、中断、切换全堵在后面,请求本身还要冒 HTTP 超时。要发起一轮就 `followUp`,要做长活就放到后台,处理器同步返回。忙不忙由扩展按参数自己判,客户端不替扩展拦(`/goal clear` 正是循环跑着的时候才要用的)。

## 一方扩展

`goal` / `review` / `todo` / `web` / `mcp` / `lsp` 六个内置扩展与磁盘扩展用的是同一份 API,它们的源码(`src/extensions/`)就是最完整的示例,见[内置扩展](/extensions/builtin/)。
