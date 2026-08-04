# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`mojocode` — a terminal coding agent (full-screen Ink TUI + headless `-p` mode) that works with any LLM via the Vercel AI SDK (Kimi / DeepSeek / GLM presets + any OpenAI-compatible endpoint). ESM-only, Node ≥ 20, TypeScript with `strict` and `noUncheckedIndexedAccess`.

**Code comments and the README are written in Simplified Chinese** — keep new comments in Chinese to match.

## Commands

```bash
npm run build       # tsup → dist/cli.js (bin entry, esm, deps external)
npm run dev         # tsup --watch
npm run typecheck   # tsc --noEmit (tsup does not typecheck)
npm test            # vitest run (all tests in tests/**/*.test.{ts,tsx})
npx vitest run tests/gate.test.ts          # single test file
npx vitest run -t "test name substring"    # single test by name
node dist/cli.js    # run the built CLI (or `mojocode` after npm link)
```

There is no lint config; `npm run typecheck` is the correctness gate alongside tests.

## Architecture

Core principle: **the agent core never imports React.** `src/core/events.ts` defines the contract — the core emits typed `AgentEvent`s over a minimal `EventBus` and awaits permission decisions through a `PermissionAsker` callback. The same agent loop therefore drives both the Ink TUI (`src/ui/App.tsx`) and the non-interactive `-p` renderer (`src/app/headless.ts`).

Wiring happens in `src/app/bootstrap.ts`: it builds the `Session` object (agent + bus + gate + tools + MCP connections + session store) that both frontends consume. `src/cli.tsx` is the commander entry point (subcommands: `auth`, `models`, `providers`, `sessions`, `config`, `doctor`).

`src/app/doctor.ts` powers both `mojocode doctor` and the TUI's `/doctor`: `collectDoctor()` gathers levelled checks (env / config / provider / permissions / MCP / sessions / workspace) into a `DoctorReport`, `formatDoctor()` renders it. Check `id`s are the stable contract for `--json` and tests; `label`/`detail` are localized. A `fail` check sets exit code 1. Two things to keep in mind when touching it: commander lets the *root* command swallow `-C` and `--json` when a subcommand declares the same names, so the doctor action reads them off `program.opts()`; and the TUI passes `session.config` plus `session.mcpStatuses` into `runDoctor()` so the report reflects in-session `/approvals`, `/model` changes and does **not** re-connect MCP servers (that would spawn a second child process per stdio server).

Data flow for one turn: `Agent.run()` (`src/agent/loop.ts`, wraps AI SDK `streamText` with `stepCountIs`) → tools call `PermissionGate` inside their `execute()` (deliberately *not* AI SDK `toolApproval`, which would suspend the stream) → gate consults mode/rules or emits `permission-request` and awaits the asker → events stream to the renderer → `onHistoryChange` persists history to an append-only JSONL in `~/.mojocode/sessions/` via `SessionStore` (incremental `append` records when the array is a pure extension of what was last saved — reference-prefix compare — otherwise a full `snapshot`; a `<id>.meta.json` sidecar makes `list()` O(1) per session; session-level state — todos, session allow rules, permission mode — rides along as `state` records).

Module map:

- `src/config/` — layered config: builtin defaults → `~/.mojocode/config.json` → `<root>/.mojocode/config.json` → `MOJOCODE_*` env vars → CLI flags. Zod schemas in `schema.ts`; provider presets (baseURL, key env vars, default models) in `providers.ts`.
- `src/permissions/` — three layers: `sandbox.ts` (realpath-based workspace containment, denies `.git/`, `.env*`, key/SSH material regardless of mode), `bash-rules.ts` (command judgment + `Bash(prefix:*)` rule matching, hard-denies `rm -rf`/`sudo`/`curl|sh`/force-push etc.), `gate.ts` (mode policy: `readonly`/`ask`/`acceptEdits`/`yolo`; session vs. persisted allow rules).
- `src/tools/` — builtin tools: `read write edit glob grep bash todo`. `summarizeToolResult` produces the localized one-line UI summary; tool *results* fed back to the model stay English.
- `src/agent/` — the streamText loop, system prompt assembly (`prompt.ts` injects `AGENTS.md`/`MOJOCODE.md` from the project root), context compaction (`compact.ts`). Mid-turn guidance messages are queued and injected at step boundaries.
- `src/mcp/` — MCP client + bridge that wraps MCP tools as AI SDK tools, routed through the same PermissionGate.
- `src/i18n/` — `en.ts` / `zh-CN.ts` catalogs; a parity test asserts the two key sets match. Resolution: config `language` → `MOJOCODE_LANG` → `LC_ALL`/`LANG`. **UI strings are localized; text fed to the model (tool errors, denial reasons) is intentionally English-only** — mixed language degrades function calling.
- `src/ui/` — Ink components. Completed timeline entries go in Ink's `<Static>` so they render once into the scrollback buffer.

## Gotchas (documented in README, do not regress)

- GLM's baseURL is `/api/paas/v4` — never append `/v1` (404s).
- Never hardcode model IDs; presets are only starting defaults, `mojocode models` fetches the live list.
- Use `result.responseMessages` for history, not `result.response.messages` — the latter only contains the last step and silently drops earlier tool calls.
- `render(<App/>, { exitOnCtrlC: false })` is required — Ink's default swallows ctrl+c before `useInput`, breaking the double-ctrl+c-to-exit logic.
- Readonly enforcement uses `gate.assertCanMutate()` *before* tools do any work, separate from `checkWrite`, because tools short-circuit (e.g. `write` returns early on unchanged content) and the guarantee must not depend on which branch ran.
- In-turn compaction only shrinks the messages sent to the model; the persistent history stays long, and the `historyNeedsCompact` flag forces compaction at the next turn start (otherwise the shrunken `lastInputTokens` masks the need).
