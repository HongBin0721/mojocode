---
title: Sessions
description: Resume, fork, rewind and context compaction.
---

Every conversation is stored as append-only JSONL under `~/.mojocode/sessions/`, and the record on disk is always complete (compaction never shortens it).

## Resume and fork

```bash
mojocode -c                          # continue the most recent session in this workspace (--continue)
mojocode -r                          # pick a session to resume interactively (--resume)
mojocode -r <id-prefix>              # resume a specific session; the 8-character prefix from `mojocode sessions` is enough
mojocode -r <id-prefix> --fork-session   # load the history but write a brand-new session, leaving the original alone
mojocode sessions                    # list past sessions in this workspace
mojocode sessions --all              # across every workspace
```

Inside the TUI the same two are `/resume` (a second-level picker) and `/fork`. Resuming replays the timeline in full and restores extension state (the todo list, an unfinished `/goal`); **the model is not restored** - the provider / model configured right now is always used. When the history is too long for the current model's smaller window, it is compacted once before the first turn starts.

Sessions untouched for longer than `cleanupPeriodDays` (30 days by default) are cleaned up at startup; archived sessions are never cleaned up.

## Rewind

Press `esc` twice while idle to open the rewind picker; picking a message truncates the conversation to just before it, the original text returns to the input box, and editing it and sending again starts over. This is a real deletion: model history and display history are cut together. To keep the original conversation, `/fork` first and rewind the fork.

## Context compaction

When the input tokens exceed `compactThreshold` of the context window (80% by default), older history is compacted into a summary and the session carries on; `/compact` does the same on demand. Compaction only affects the messages sent to the model - the file on disk and what `/resume` replays still show the original conversation.

The context window comes from the provider preset or `providers.<id>.contextWindow`, can be set per model in `providers.<id>.models[]`, or forced with `--max-context` (handy when testing the compaction logic).

## Two histories

The session store keeps two histories: `messages` is what the model sees, and compaction replaces its prefix with a summary; `displayMessages` is never shortened by compaction and is what `/resume` replays. Rewinding is a real deletion and cuts both. The record format is documented in [Session format](/reference/session-format/).
