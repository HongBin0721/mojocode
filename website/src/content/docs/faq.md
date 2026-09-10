---
title: 常见问题
description: 排障与常见疑问。
---

### 跑不起来,不知道卡在哪一步

`mojocode doctor`。它逐项报出 Node 版本、配置文件解析、密钥来源、端点是否可达、模型 id 是否还在服务商列表里、MCP 连接、LSP 服务器、会话目录是否可写,并对每个异常项给出修复命令。

### 报 "No API key for provider ..."

运行 `mojocode auth` 配置,或检查环境变量名是否正确。`mojocode providers` 列出每家认哪些变量。

### GLM 返回 404

检查 baseURL 是否被改动过,必须是 `https://open.bigmodel.cn/api/paas/v4`,不带 `/v1`。

### `/models` 里没有我想要的模型

模型列表以线上接口为准。接口滞后时预设的默认模型仍会被并入保证可选。`mojocode models --provider <id>` 查看密钥实际返回的列表,确认后用 `/models <id>` 或配置 `model` 字段指定;也可以在 `providers.<id>.models` 里手工维护列表。

### 上下文满了怎么办

超过窗口 80% 会自动压缩成摘要继续,也可随时 `/compact`。磁盘上的会话记录始终是完整的。

### 能不能限制它只在某个目录里动手

mojocode 自己不设围栏,见[没有权限系统](/features/permissions/)。把它放进容器或一次性的工作副本里跑;要在进程内拦,写一个 `tool_call` 钩子扩展。

### 直接运行 `mojocode` 提示 Node 版本不够,但 `-p` 能用

TUI 需要 Node ≥ 26.1 的原生 FFI,`-p` 与子命令只需 22。装单二进制或升级 Node,见[快速开始](/guides/quickstart/#环境要求)。

### `shift+enter` 换不了行

需要终端支持 kitty 键盘协议(iTerm2 3.5+ / kitty / WezTerm / Ghostty)。任何终端可用的兜底:`option+enter`、`ctrl+j`,或行尾 `\` 再回车。

### 粘贴的图片被忽略了

DeepSeek 的官方 SDK 不支持图片,会被忽略并提示。其他模型不能直接收图时图片会降级为文件引用,配置 `visionModel` 后模型可以调 `view_image` 读图,见[视觉模型](/config/providers/#视觉模型)。
