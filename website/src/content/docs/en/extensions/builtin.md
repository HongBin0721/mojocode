---
title: Built-in extensions
description: "The six first-party extensions: goal / review / todo / web / mcp / lsp."
---

These features are all implemented as extensions, using exactly the same `ExtensionAPI` as disk extensions. The source is in `src/extensions/`, the best reference when writing your own; "turning a feature off" such as `--no-mcp` simply means not loading that extension.

| Extension | Provides | API used |
|---|---|---|
| `goal` | `/goal` goal mode: evaluated in `turn_end`, continued with `followUp`, the status line shows turn count and elapsed time, custom records persisted | `on` `registerCommand` `setStatus` `followUp` `appendEntry` `model` |
| `review` | `/review` and a multi-level selector over the four presets, assembles a prompt and `followUp`s one turn | `registerCommand` (multi-level `options`) `followUp` `notify` |
| `todo` | the `todo` tool and the task list: the model writes the list, the TUI renders a panel by key (`ctrl+t`); not given to subagents | `registerTool` `setState` `appendEntry` |
| `web` | `web_fetch` always, `web_search` once a key is available; it appends the "which network tools you have" sentence to the system prompt itself | `registerTool` `before_agent_start` |
| `mcp` | connects MCP servers, bridges their tools, `/mcp` command; connections do not block startup, they are only awaited in `turn_start` | `registerTool` `registerCommand` `on` `publishRuntime` |
| `lsp` | LSP diagnostics fed back after `write` / `edit`, the canonical `tool_result` hook example: adds no field at all when clean | `on('tool_result')` `publishRuntime` |

Detailed behaviour lives in [Goal mode](/features/goal/), [Review and cleanup](/features/review/), [Web search](/config/search/), [MCP](/config/mcp/) and [LSP diagnostics](/config/lsp/).

## What stays in the core

`/simplify` and the `task` subagent tool deliberately stay in the core. We checked five other agents - pi, opencode, Claude Code, Codex and Cline: none of them hangs "start a subagent" off the extension API. A subagent is always defined by a declarative file and always launched by a model-callable tool built into the host. `/simplify` has to orchestrate four parallel subagents and merge their tool events, which is host orchestration, not policy.
