---
title: Subagents
description: The task tool delegates a self-contained job to a subagent.
---

The main agent can delegate a self-contained job to a **subagent** with the built-in `task` tool: it runs the same loop in a fresh context with the same tools (minus `task` itself and `todo`; recursion is one level deep, and session state stays with the main agent), then brings exactly one report back to the main conversation. The value is context isolation: the intermediate work of an investigation such as "read these 40 files and summarise how they call each other" no longer crowds the main context, which only receives the conclusion.

No configuration is needed; the model decides when to delegate. Two kinds:

| Kind | Tools | Good for |
|---|---|---|
| `general` | the main agent's set (minus task / todo) | independent jobs that need to act |
| `explore` | read-only: read / glob / grep / web_fetch / web_search; MCP tools are withheld | pure investigation, safer |

Progress is visible while it runs: the tool row carries the step count and up to the three most recent tool calls scroll below it, indented. The trace only exists in the live area and disappears when the task finishes; the timeline keeps one summary line (`12 steps · 45.2k tokens`).

```
⚒ Task(find call sites · explore) · 5 steps
   ⎿ Grep(handleSubmit · src/**)
   ⎿ Read(src/ui/App.tsx)
```

A subagent's token spend counts towards `/cost` and the footer total. The full run (every step's messages) is persisted with the session as a `task` record, so "why did that subagent reach the wrong conclusion" can be investigated afterwards. When it hits the step cap or fails midway, the report is explicitly marked incomplete - a half-finished investigation is never passed off as a conclusion. An `esc` that interrupts the main turn stops the subagent immediately.

| Key | Default | Notes |
|---|---|---|
| `taskModel` | the session's current model | model id used by subagents, on the same provider as the session. Switching an investigative subagent to a cheaper model pays off; `MOJOCODE_TASK_MODEL` overrides it |
| `taskMaxSteps` | `50` | step cap for a single task, independent of the main turn's "no limit by default"; an explicit `maxSteps` is inherited instead |

Hooks apply to subagents too, and every hook input carries `subagent: true` so an intercepting extension can treat them differently. A skill with `context: fork` goes through this same channel.
