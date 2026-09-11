---
title: Configuration
description: Layered config, precedence and every field.
---

Configuration lives in two files: `~/.mojocode/config.json` (global) and `<project>/.mojocode/config.json` (project level, can be committed). Precedence, low to high:

```
built-in defaults → global config → project config → MOJOCODE_* environment variables → command-line options
```

`mojocode config` shows the effective config and the origin of every value, keys masked. The two layers are deep-merged per key: `providers`, `mcpServers` and `lsp.servers` merge by id, `packages` is unioned, everything else lets the later layer override the earlier. Write only the keys you want to override in the project layer - keys you leave out are not reset by "phantom defaults".

## Full example

```json
{
  "provider": "glm",
  "model": "GLM-5.3",
  "language": "zh-CN",
  "reasoningEffort": "medium",
  "providers": {
    "glm": { "apiKey": "..." },
    "local": {
      "baseURL": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "LOCAL_KEY",
      "model": "qwen3-coder",
      "contextWindow": 131072,
      "models": [
        { "id": "qwen3-coder", "contextWindow": 131072, "reasoning": { "enable_thinking": true } }
      ]
    }
  },
  "search": { "backend": "glm" },
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  },
  "lsp": { "timeoutMs": 3000 },
  "packages": ["npm:@someone/mojocode-ext"]
}
```

## Top-level fields

| Key | Default | Notes |
|---|---|---|
| `provider` | `deepseek` | the active provider id: a built-in preset or a key in `providers` |
| `model` | preset default | overrides the current provider's default model |
| `providers` | `{}` | provider entries, see [Models and providers](/config/providers/) |
| `packages` | `[]` | extension packages recorded by `mojocode install`, unioned across the two layers |
| `mcpServers` | `{}` | MCP servers, see [MCP](/config/mcp/) |
| `search` | `{ backend: "auto" }` | web search, see [Web search](/config/search/) |
| `lsp` | `{ enabled: true, timeoutMs: 3000 }` | LSP diagnostics fed back, see [LSP diagnostics](/config/lsp/) |
| `maxSteps` | unset | hard cap on agent steps per turn; hitting it stops the turn and asks you to send a message to carry on |
| `taskMaxSteps` | `50` | step cap for a subagent's single task; an explicit `maxSteps` is inherited instead |
| `taskModel` | the session's current model | model id used by subagents, on the same provider as the session |
| `goalModel` | the session's current model | model id used by the `/goal` evaluator |
| `goalMaxTurns` | `10` | how many turns one goal may auto-continue for, capped at 100 |
| `visionModel` | preset (`glm-4.6v` for GLM) | multimodal model id used by `view_image` |
| `temperature` | unset | sampling temperature, 0 to 2 |
| `reasoningEffort` | `auto` | global thinking level: `auto` `off` `low` `medium` `high` `max`, overridable by `providers.<id>.reasoningEffort` and per-model `reasoning` |
| `compactThreshold` | `0.8` | compact history once input tokens pass this fraction of the window, 0.1 to 0.95 |
| `maxContext` | unset | force the context window, overriding the provider preset |
| `systemPromptAppend` | unset | extra instructions appended to the end of the system prompt |
| `language` | `auto` | interface language `auto` / `en` / `zh-CN` |
| `statusBar` | all | footer segments: `model` `cwd` `think` `context` `total` `todos`, configured in `/setting` |
| `theme` | none | TUI theme name; `<name>.json` is looked up in the project / global `themes/` and in theme directories shipped by packages, see [Packages](/extensions/packages/#themes) |
| `timeline` | `full` | timeline density `full` / `compact` / `result`, persisted by `/focus` |
| `cleanupPeriodDays` | `30` | how many days sessions are kept; inactive ones past that are cleaned up at startup |

The old `sandbox` / `approval` / `permissions` / `permissionMode` keys and the `mode` segment in `statusBar` were retired along with the permission system; when read they are treated as unknown keys, without an error.

## How keys are provided

Three sources, taking the first of: `providers.<id>.apiKey` → the variable named by `providers.<id>.apiKeyEnv` → the preset's environment variable list. `mojocode auth` writes the first (file mode 0600); on a shared machine environment variables are preferable. `mojocode providers` lists which variables each provider accepts.
