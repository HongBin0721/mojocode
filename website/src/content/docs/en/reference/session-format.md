---
title: Session format
description: The record kinds in the JSONL files under ~/.mojocode/sessions/.
---

Each session is an append-only JSONL file `~/.mojocode/sessions/<id>.jsonl`, one record per line, distinguished by `kind`; the neighbouring `<id>.meta.json` is a metadata copy of the same content so listing does not have to read the whole file. Older readers silently skip unknown `kind`s, so the format is backward compatible.

| kind | Content | Written by |
|---|---|---|
| `meta` | `{ id, root, provider, model, createdAt, updatedAt, title, messageCount, archivedAt? }` | on create, rename, archive and model switch |
| `append` | messages added since the last save | after each step, when history purely extends the old one |
| `snapshot` | a full replacement message array; the `display` field only appears when it differs from `messages` | compaction or a rewind, when history is no longer an extension of the old history |
| `state` | session-level state, currently `changedFiles` (files this session's write / edit landed on) | on change |
| `task` | the full run of one subagent: `{ callId, description, mode, steps, tokens, finishReason, error, messages }` | when the subagent finishes |
| `usage` | one turn's usage: `{ provider, model, inputTokens, outputTokens, cachedInputTokens? }` | at the end of every turn |
| `custom` | an extension's own record `{ type, data }`, uninterpreted by the core | `appendEntry` |
| `messages` | the old full-snapshot format, read-only compatibility | no longer written |

## Two histories

`messages` is what the model sees; compaction replaces its prefix with a summary. `displayMessages` is never shortened by compaction and is what `/resume` replays. A `snapshot` record carries `display` only when the two differ; an old file without `display` is rebuilt from its shape. Rewinding is a real deletion and cuts both.

## Forking

`/fork` or `--fork-session` carries the current history, `state` and every `custom` record into a new file, leaving the original frozen at the fork point. Extension state (the todo list, the goal condition) belongs to the session, so losing it in a fork would lose the todo with it.

## Metadata

`title` comes from the first user message; `archivedAt` is a timestamp, and archived sessions stay in the list for the consumer to filter while startup cleanup skips them too. `provider` / `model` are for display only (the session picker, `mojocode sessions`); resuming never switches back to them.
