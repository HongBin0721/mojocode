---
title: 内置扩展
description: goal / review / todo / web / mcp / lsp 六个一方扩展。
---

这些功能都以扩展实现,用的是与磁盘扩展完全相同的 `ExtensionAPI`。源码在 `src/extensions/`,是写自己扩展时最好的参考;`--no-mcp` 之类的「关掉一个功能」就是不加载那个扩展。

| 扩展 | 提供 | 用到的 API |
|---|---|---|
| `goal` | `/goal` 目标模式:`turn_end` 里评估、`followUp` 续跑、状态行显示轮数与已用时、custom 记录持久化 | `on` `registerCommand` `setStatus` `followUp` `appendEntry` `model` |
| `review` | `/review` 与四个预设的多级选择器,组一段提示词后 `followUp` 一轮 | `registerCommand`(`options` 多级)`followUp` `notify` |
| `todo` | `todo` 工具与任务清单:模型写清单,TUI 按 key 渲染面板(`ctrl+t`);子 agent 不给 | `registerTool` `setState` `appendEntry` |
| `web` | `web_fetch` 恒有,`web_search` 拿得到 key 时才有;系统提示词里「你有哪些联网工具」那句由它自己追加 | `registerTool` `before_agent_start` |
| `mcp` | 连接 MCP 服务器、桥接工具、`/mcp` 命令;连接不阻塞启动,`turn_start` 里才等收尾 | `registerTool` `registerCommand` `on` `publishRuntime` |
| `lsp` | `write` / `edit` 之后回喂 LSP 诊断,`tool_result` 钩子的标准示例:干净时不加任何字段 | `on('tool_result')` `publishRuntime` |

详细行为分别见[目标模式](/features/goal/)、[评审与清理](/features/review/)、[联网搜索](/config/search/)、[MCP](/config/mcp/)、[LSP 诊断](/config/lsp/)。

## 留在核心的东西

`/simplify` 与 `task` 子 agent 工具明确留在核心。查过 pi、opencode、Claude Code、Codex、Cline 五家,没有一家在扩展 API 上挂「起一个子 agent」:子 agent 的定义永远是声明式文件,发起永远是宿主内建的模型可调用工具。`/simplify` 要编排四个并行子代理并合成工具事件,那是宿主编排,不是策略。
