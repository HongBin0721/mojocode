# AGENTS.md

`mojocode` — a terminal coding agent (full-screen Ink TUI + headless `-p` mode) that works
with any LLM via the Vercel AI SDK. ESM-only (`"type": "module"`), Node ≥ 20, TypeScript
with `strict` + `noUncheckedIndexedAccess`.

## Commands (verified against package.json)

```bash
npm run build       # tsup → dist/cli.js (bin entry, esm, deps kept external)
npm run dev         # tsup --watch
npm run typecheck   # tsc --noEmit — tsup does NOT typecheck; this is the gate
npm test            # vitest run — all tests in tests/**/*.test.{ts,tsx}
npx vitest run tests/gate.test.ts       # single test file
npx vitest run -t "name substring"      # single test by name
node dist/cli.js    # run the built CLI
```

There is no lint config; `npm run typecheck` + `npm test` are the correctness gates.

## Architecture

**The agent core never imports React.** `src/core/events.ts` defines the contract: the core
emits typed `AgentEvent`s over an `EventBus` and awaits permission decisions via a
`PermissionAsker` callback. One agent loop therefore drives both the Ink TUI
(`src/ui/App.tsx`) and the non-interactive `-p` renderer (`src/app/headless.ts`).

Wiring lives in `src/app/bootstrap.ts`, which builds the `Session` object (agent + bus +
gate + tools + MCP + session store) consumed by both frontends. `src/cli.tsx` is the
commander entry (`auth`, `models`, `providers`, `sessions`, `config` subcommands).

One turn: `Agent.run()` (`src/agent/loop.ts`, AI SDK `streamText` + `stepCountIs`) → tools
call `PermissionGate` **inside** their `execute()` (deliberately not AI SDK `toolApproval`,
which would suspend the stream) → gate consults mode/rules or awaits the asker → events
stream to the renderer → history persists to append-only JSONL in `~/.mojocode/sessions/`.

- `src/config/` — layered config: builtin → `~/.mojocode/config.json` → project
  `.mojocode/config.json` → `MOJOCODE_*` env → CLI flags. Zod schemas in `schema.ts`;
  provider presets in `providers.ts`.
- `src/permissions/` — `sandbox.ts` (realpath workspace containment; `.git/`, `.env*`,
  keys/SSH always denied), `bash-rules.ts` (command judgment + `Bash(prefix:*)` rules;
  hard-denies `rm -rf`/`sudo`/`curl|sh`/force-push), `gate.ts` (`readonly`/`ask`/
  `acceptEdits`/`yolo` policy).
- `src/tools/` — builtin `read write edit glob grep bash todo`.
- `src/agent/` — loop, system prompt (`prompt.ts` injects this file), compaction (`compact.ts`).
- `src/mcp/` — MCP client; MCP tools are wrapped as AI SDK tools through the same gate.
- `src/i18n/` — `en.ts` / `zh-CN.ts` catalogs with a parity test asserting key sets match.
- `src/session/` — append-only JSONL store; incremental `append` on pure extension, else
  full `snapshot`; `<id>.meta.json` sidecar makes `list()` O(1).

## Conventions

- **Code comments are written in Simplified Chinese** — keep new comments in Chinese.
- **UI strings are localized; text fed back to the model (tool errors, denial reasons)
  stays English-only** — mixed language degrades function calling.
- **Never hardcode model IDs** — presets are starting defaults only; `mojocode models`
  fetches the live list.
- **GLM baseURL is `/api/paas/v4`** — never append `/v1` (404s).
- **Use `result.responseMessages` for history**, not `result.response.messages` — the
  latter only holds the last step and silently drops earlier tool calls.
- **Readonly mode enforces `gate.assertCanMutate()` before any work**, separate from
  `checkWrite`, because tools short-circuit and the guarantee must not depend on the branch.
- **`render(<App/>, { exitOnCtrlC: false })` is required** — Ink's default swallows ctrl+c
  before `useInput`, breaking double-ctrl+c-to-exit.
- **In-turn compaction shrinks only the messages sent to the model**; persistent history
  stays full, and `historyNeedsCompact` forces compaction at next turn start.
- Completed timeline entries render in Ink's `<Static>` (once, into scrollback). Text in
  the dynamic region must keep a wrap-safety margin and truncate by display width
  (`WIDTH_SAFETY` in `App.tsx`, `truncateWidth` in `theme.ts`).
- Tests live in `tests/*.test.{ts,tsx}` mirroring the module under test
  (`gate.test.ts`, `sandbox.test.ts`, `i18n.test.ts`, ...); UI tests use
  `ink-testing-library`.
