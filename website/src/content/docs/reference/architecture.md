---
title: 架构
description: 核心不认识 UI,事件总线驱动三个前端。
---

核心原则:**agent 核心不 import UI 框架。** `src/core/events.ts` 定义契约,核心把类型化的 `AgentEvent` 发到一个极简的事件总线上,同一套循环同时驱动 OpenTUI 的 TUI 与 `-p` 的 headless 渲染器。

## 进程模型

与 pi 相同的单进程形态:TUI、agent 核心、工具、扩展、MCP、LSP、会话存储都在同一个进程里,扩展因此可以直接把界面组件交给 TUI(`ctx.ui.custom`、`setWidget`、工具的 `renderResult`)。

```
src/
  config/      分层配置、服务商预设、密钥保存
  model/       AI SDK 模型构造、实时 /models 列表、models.dev 能力目录
  agent/       streamText 循环、系统提示、上下文压缩、/init、/simplify、git 收集器
  tools/       read write edit glob grep bash task view_image(无路径围栏)
  core/        事件总线契约、钩子层、扩展 API
  extensions/  一方扩展 goal / lsp / mcp / review / todo / web,磁盘扩展装载器与包管理
  skills/      技能发现、frontmatter 解析、斜杠与工具两种调用
  mcp/         MCP 客户端(桥接在 extensions/mcp)
  lsp/         LSP 客户端与服务器注册表(策略在 extensions/lsp)
  session/     追加式 JSONL 会话记录
  server/      HTTP + SSE server 与线上协议
  client/      远程会话瘦客户端(SSE 状态镜像加串行化 RPC)
  app/         bootstrap 装配、headless 渲染、doctor、server 拉起
  i18n/        语言目录 en / zh-CN
  ui/          OpenTUI + SolidJS 组件;kit.tsx 是渲染器适配层
website/       本文档站,独立包
```

## 一轮的数据流

`Agent.run()` 包着 AI SDK 的 `streamText`,事件流向渲染层;每一步的历史变化经 `onHistoryChange` 追加写入 `~/.mojocode/sessions/<id>.jsonl`。工具在每次开流时被钩子层现包(`tool_call` 否决、`tool_result` 改写),没有工具钩子时原对象直达 SDK。`turn_end` 钩子在一轮完全收尾后才跑,扩展在这里 `followUp` 的消息作为新一轮开跑,整个链条内会话都算忙。

## 钩子与总线的分工

总线是同步、单向、给渲染层看的事实流,处理器返回值无意义;钩子异步、按注册顺序串行、返回值有意义。功能从核心搬出去成为扩展靠的是钩子层,不是总线。命名上钩子用 snake_case(`tool_call`),总线用 kebab-case(`tool-end`),代码里一眼可分。

## 渲染层

TUI 是 [OpenTUI](https://github.com/anomalyco/opentui) + SolidJS,与 opencode 同款:Zig 原生渲染核心加 Solid 细粒度响应式,运行在 alternate screen。`src/ui/kit.tsx` 以 Ink 形状的 API(Box / Text / useInput)包住 OpenTUI,组件层不直接触碰上游 0.x API,破坏性变更只改 kit 一处。TUI 模块按需动态加载:Bun 与单二进制直接跑,npm 加 Node 需要 26.1+,更老的 Node 只影响 TUI。

## 运行时

`-p` 与子命令跑在 Node ≥ 22;TUI 需要原生 FFI,Bun(单二进制分发)或 Node ≥ 26.1 加 `--experimental-ffi`(缺了自动重启注入)。单二进制用 Bun 交叉编译六个平台。
