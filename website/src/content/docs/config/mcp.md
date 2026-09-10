---
title: MCP
description: 接入 Model Context Protocol 服务器的工具。
---

`mcp` 扩展把配置里的 MCP 服务器连上,并把它们的工具注册给模型。核心对 MCP 一无所知:连接、桥接、状态都在扩展里。

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "TOKEN": "..." },
      "cwd": "."
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

| 字段 | stdio | http |
|---|---|---|
| `command` / `args` / `env` / `cwd` | 子进程怎么起 | 无 |
| `url` / `headers` | 无 | 端点与请求头 |
| `enabled` | 默认 `true`,`false` 保留配置但不连 | 同左 |

`env` 与 `headers` 按惯例带 token,server 推给客户端的配置快照里会被抹掉。

## 行为

- **连接不阻塞启动。** 扩展装配时只发起连接不等待,第一轮真正开跑前才等它收尾(每个服务器最坏 15 秒超时)。
- 连接失败以时间线上的一条提示呈现,不写 stderr。`/mcp` 列出当前状态。
- MCP 工具对 explore 子 agent 不可见:它们不透明、可能有副作用,只读调研不给。
- `--no-mcp` 跳过整个扩展,启动更快。
- `mojocode doctor` 的 MCP 分节在无会话时自己连一遍;TUI 的 `/doctor` 直接采信会话内的连接状态,不会为每个 stdio 服务器再拉一个子进程。

想给 MCP 工具加确认或拦截,写一个 `tool_call` 钩子扩展,见[扩展](/extensions/overview/)。
