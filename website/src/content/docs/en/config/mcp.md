---
title: MCP
description: Tools from Model Context Protocol servers.
---

The `mcp` extension connects the MCP servers in the config and registers their tools with the model. The core knows nothing about MCP: connecting, bridging and status all live in the extension.

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

| Field | stdio | http |
|---|---|---|
| `command` / `args` / `env` / `cwd` | how to start the child process | none |
| `url` / `headers` | none | endpoint and request headers |
| `enabled` | `true` by default; `false` keeps the config but does not connect | same |

`env` and `headers` conventionally carry tokens and are stripped from any config snapshot a server pushes to a client.

## Behaviour

- **Connecting does not block startup.** The extension kicks connections off while it is assembling and does not wait; only before the first turn actually starts does it wait for them to finish (15 seconds worst case per server).
- A failed connection becomes a notice in the timeline, not stderr. `/mcp` lists the current state.
- MCP tools are invisible to explore subagents: they are opaque and may have side effects, so read-only investigations do not get them.
- `--no-mcp` skips the whole extension for a faster start.
- `mojocode doctor`'s MCP section connects on its own when there is no session; the TUI's `/doctor` trusts the session's connections and does not spawn another child process per stdio server.

To add a confirmation or interception in front of MCP tools, write a `tool_call` hook extension, see [Extensions](/extensions/overview/).
