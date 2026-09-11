---
title: Review and cleanup
description: /review is a read-only review, /simplify applies the fixes.
---

## /review

Ask the agent to review git changes and print findings ordered by severity; it is read-only and touches no file. With no argument it opens a menu of four presets:

| Preset | Notes |
|---|---|
| Against a base branch | PR style, then pick a branch |
| Uncommitted changes | what is in the working tree |
| Review a commit | then pick one from the recent list |
| Custom review instructions | add a focus and review uncommitted changes |

Or type the scope directly:

```
/review uncommitted
/review base main
/review commit <sha>
/review custom focus on concurrency safety
```

The review arrives as one turn and you can follow up in it. Typing `/review` while a task runs is not refused - it queues until the current chain ends. Only a git summary and ready-to-run commands are embedded in the prompt, never the full diff; the agent reads what it needs.

`/review` is an extension (`src/extensions/review/`): the command, the presets and the second-level picker all live there, reusing the core's git collector.

## /simplify

Aligned with Claude Code: look for cleanup opportunities in changed code and **apply the fixes directly**, leaving them uncommitted for you to inspect. Two phases:

1. Four **parallel read-only explore subagents**, each taking one dimension (reuse of existing implementations, redundant logic, efficiency, level of abstraction), with independent contexts and step budgets; they report, they do not edit.
2. The main conversation runs an apply turn: deduplicate, verify against the current workspace, apply the fixes.

Correctness bugs are not this turn's job - that is `/review`. The bare command cleans up uncommitted changes by default; it also takes `/review`'s scope syntax (`/simplify base main`, `/simplify commit <sha>`, `/simplify custom <focus>`) or a path or focus as the cleanup target (`/simplify src/foo.ts`).

During phase one the main agent is idle but treated as busy: `esc` is ignored and submitted messages are refused; you can talk to it again once the apply turn starts. A dimension that failed keeps its slot marked "not covered", and the apply turn runs even if all of them failed.
