---
title: Headless mode
description: One-shot runs with -p in scripts, pipes and CI.
---

```bash
mojocode -p "find every TODO comment and summarise them"   # one-shot, result on stdout
mojocode -p "analyse this error" --provider deepseek       # pick a provider
mojocode -p "..." --json                                   # NDJSON event stream on stderr
cat error.log | mojocode -p "analyse this log"             # works with pipes
mojocode -p "/init"                                        # generate AGENTS.md
mojocode -p "/release 1.2.0"                               # invoke a skill with a slash command
```

`-p` deliberately skips the client-server split and stays a single process with pipe semantics: stdout carries only the final answer, and with `--json` stderr carries `AgentEvent`s line by line (text-delta, tool-start, tool-end, turn-end, …) for scripts to consume.

## Step limit

A turn has **no step limit by default**, the same stance as Claude Code: a human is watching interactive use, `esc` is the brake, and in-turn compaction covers runaway context. For unattended runs, use `--max-steps <n>` (or the config key `maxSteps`) as a fuse: hitting it stops the current turn with a notice, and sending one more message carries on from the breakpoint with the step count reset.

Subagents have their own `taskMaxSteps` (default 50) and do not follow the main turn's "no limit by default"; see [Subagents](/features/subagents/).

## In CI

```bash
mojocode doctor --offline || exit 1          # environment gate: exits 1 on any ✗
mojocode -p "/review base main" --json       # review this branch against main
```

Provide keys through environment variables (`DEEPSEEK_API_KEY` and friends, see [Quickstart](/guides/quickstart/#environment-variables)); never commit `~/.mojocode/config.json`.
