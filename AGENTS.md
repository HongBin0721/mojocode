# AGENTS.md

`mojocode` — a terminal coding agent (full-screen OpenTUI TUI + headless `-p` mode) that
works with any LLM via the Vercel AI SDK. ESM-only (`"type": "module"`), TypeScript with
`strict` + `noUncheckedIndexedAccess`. Runtime split: `-p` and subcommands run on Node ≥ 22;
the TUI needs native FFI — Bun (primary, single-binary distribution) or Node ≥ 26.1 with
`--experimental-ffi` (auto re-exec injects the flag).

## Commands (verified against package.json)

```bash
npm run build       # tsup → dist/cli.js + lazy chunks (esm, splitting on, deps external)
npm run dev         # tsup --watch
npm run typecheck   # tsc --noEmit — tsup does NOT typecheck; this is the gate
npm test            # core tests, Node lane (excludes tests/ui/)
npm run test:ui     # UI tests — MUST run under Bun (= bun --bun x vitest run --config vitest.ui.config.ts)
npx vitest run tests/gate.test.ts       # single core test file
npx vitest run -t "name substring"      # single test by name
node dist/cli.js    # run the built CLI
```

There is no lint config; `npm run typecheck` + both test lanes are the correctness gates.
UI tests need Bun because OpenTUI's test renderer is the real native renderer (FFI).

## Architecture

**The agent core never imports the UI framework (SolidJS).** `src/core/events.ts` defines
the contract: the core emits typed `AgentEvent`s over an `EventBus` and awaits permission
decisions via a `PermissionAsker` callback. One agent loop therefore drives both the
OpenTUI TUI (`src/ui/App.tsx`) and the non-interactive `-p` renderer (`src/app/headless.ts`).

**Process model (opencode-style client-server).** By default the TUI is a thin client: it
spawns a managed `mojocode serve --managed` child (agent, tools, MCP, LSP, session store
all live there) and talks REST + SSE — `src/server/serve.ts` + `src/server/protocol.ts`
(wire types, event replay via SSE `id:`/`Last-Event-ID`), `src/client/remote.ts` (SSE-driven
state mirror + serialized RPC queue). The UI consumes the narrow `SessionHandle` interface
(`src/app/session-handle.ts`); the local `Session` satisfies it structurally, so
`MOJOCODE_NO_SERVER=1` and UI tests run in-process. `-p` stays in-process by design.
Every awaited session call in UI code needs a `.catch` — they are RPCs and an unhandled
rejection kills the TUI.

Wiring lives in `src/app/bootstrap.ts`, which builds the `Session` object (agent + bus +
gate + tools + MCP + session store) consumed by both frontends. `src/cli.tsx` is the
commander entry (`auth`, `models`, `providers`, `sessions`, `config`, `doctor`, `serve`
subcommands). The TUI is a lazy `import('./ui/tui.js')` — never import `src/ui/` (→ kit →
`@opentui/core`, which needs FFI at module load) statically from anything on the `-p` path.

One turn: `Agent.run()` (`src/agent/loop.ts`, AI SDK `streamText` + `stepCountIs`) → tools
call `PermissionGate` **inside** their `execute()` (deliberately not AI SDK `toolApproval`,
which would suspend the stream) → gate consults mode/rules or awaits the asker → events
stream to the renderer → history persists to append-only JSONL in `~/.mojocode/sessions/`.

- `src/config/` — layered config: builtin → `~/.mojocode/config.json` → project
  `.mojocode/config.json` → `MOJOCODE_*` env → CLI flags. Zod schemas in `schema.ts`;
  provider presets in `providers.ts`.
- `src/permissions/` — `sandbox.ts` (realpath workspace containment; `.git/`, `.env*`,
  keys/SSH always denied), `bash-rules.ts` (command judgment + `Bash(prefix:*)` rules;
  hard-denies `rm -rf`/`sudo`/`curl|sh`/force-push; safelist is two-tier — commands that
  run project code (`npm test`, test runners) are safe only in writable sandboxes, and
  find/fd/git-branch arg forms that write are never safe), `gate.ts` (two-axis policy à la
  Codex: sandbox `read-only`/`workspace-write`/`danger-full-access` × approval
  `untrusted`/`on-request`/`never`; `/approvals` presets read-only/ask/auto/full-access
  in `config/schema.ts`). Unlike Codex there is no OS sandbox, so non-safelisted bash
  stays "outside the sandbox" even under workspace-write, and `on-failure` does not
  exist. Plan mode is a flag that overrides both axes (read-only, non-escalatable);
  the `exit_plan` tool submits a plan and approval restores the pre-plan combo
  (read-only+never promotes to ask). `full-access` and plan are session-only, never
  persisted. `shift+tab` cycles ask→auto→plan; from outside the cycle it lands on
  `plan`, so a stray keystroke can only tighten permissions, never loosen them.
- `src/tools/` — builtin `read write edit glob grep bash web_fetch todo exit_plan`, plus
  `web_search` when a search backend resolves, plus `task` (subagent — one recursion level).
- `src/skills/` — Agent Skills (agentskills.io `SKILL.md` dirs): discovery from
  `.mojocode/skills` + `.claude/skills` (project > global, 15s-TTL `SkillManager`),
  a `skill` tool whose description carries the L1 name+description list (rebuilt in place
  on digest change — the tools object is shared by reference with the running Agent),
  and slash invocation (`/name args` → `runSkill` on Session: activate → substitute
  `$ARGUMENTS`/`$N` → run a turn wrapped in the `<skill-command>` replay envelope,
  `invocation.ts` — first-line marker is a persistence contract like INIT_PROMPT_MARKER).
  Activation adds the skill dir as a **read-only** extra root (`resolveReadable` in
  sandbox.ts — read/glob only; writes still single-root) and, for `allowed-tools`,
  asks once per session via `gate.confirmSessionRules` (session buckets only, never
  persisted from frontmatter). `context: fork` runs the body through `runTaskSubagent`;
  subagents get the skill tool without `runFork` (fork inlines — one recursion level).
- `src/agent/` — loop, system prompt (`prompt.ts` injects this file), compaction (`compact.ts`).
- `src/mcp/` — MCP client; MCP tools are wrapped as AI SDK tools through the same gate.
- `src/i18n/` — `en.ts` / `zh-CN.ts` catalogs with a parity test asserting key sets match.
- `src/session/` — append-only JSONL store; incremental `append` on pure extension, else
  full `snapshot`; `<id>.meta.json` sidecar makes `list()` O(1). Non-history records
  (`task`, `usage`) ride the same file; `open()` skips unknown kinds, old readers skip
  them too. `usage` records (per-turn input/output/cached tokens) exist for after-the-fact
  cache-hit / cost stats — read them with `SessionStore.readUsage()`.
- `src/server/` + `src/client/` — the client-server split (HTTP + SSE, Bearer-token auth,
  loopback bind; server is FFI-free and runs on Node ≥ 22).
- `src/ui/` — **SolidJS** (`@opentui/solid`) components; `kit.tsx` is the renderer adapter
  exposing Ink-shaped `Box`/`Text`/`useInput`/`useApp`/`render` — components import kit,
  never `@opentui/*` directly. Solid discipline: never destructure props; derived values
  are functions/memos; multi-signal updates observed by an effect must be `batch()`ed.
  Two upstream traps: span (TextNode) styles only apply via the `style` prop (direct
  `fg=`/`bg=` are silently ignored), and bare `solid-js` resolves to the non-reactive SSR
  stub under Node/Bun native conditions — the build pins `solid-js/dist/solid.js`
  everywhere (see tsup.config.ts / vitest.solid.ts); keep it pinned.
  Two orthogonal collapse axes: `/focus` (ctrl+o, `focus.ts`) hides whole entries —
  `user`/`assistant`/`error`/`banner` and all notices never (iron law, `tests/focus.test.ts`);
  **ctrl+r** toggles the *bodies* of reasoning and raw tool output, collapsed by default,
  while diff/plan/todo bodies are results and never collapse. Each turn ends with a
  `kind: 'turn'` line (model · elapsed · that turn's tokens, plus a cache-hit segment
  `cached/input (pct%)` when the provider reports one — `formatCacheHit` decides, 0% is
  shown, missing data is not). Single-line info rows must be
  measured and cut before layout (`Footer.fitParts`) — an overflowing OpenTUI flex row
  shrinks its children and silently eats the spaces around separators. Diff rows use
  `highlightDiffLine`, not `highlightLine`: highlight.js's default theme is built for a
  white background (strings red, numbers/comments green) and paints red-on-green inside
  the diff; `DIFF_THEME` overrides every colored default key (unset keys fall back) with a
  red/green-free bright palette, emitted as raw truecolor SGR instead of via chalk.

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
- **Kit's `render()` defaults `exitOnCtrlC: false`** — the renderer would otherwise swallow
  ctrl+c before `useInput`, breaking double-ctrl+c-to-exit (startup wizard/picker opt back in).
- **In-turn compaction shrinks only the messages sent to the model**; persistent history
  stays full, and `historyNeedsCompact` forces compaction at next turn start.
- Timeline items are immutable once finalized — the `<For>` in App reuses entries by
  reference (zero re-render under Solid's fine-grained updates) and `renderMarkdownAnsi`
  is LRU-cached by `(key, width)` in `md-cache.ts`; keep the wrap-safety margin and
  truncate by display width (`WIDTH_SAFETY` and `truncateWidth` in `theme.ts`).
- Core tests live in `tests/*.test.ts` mirroring the module under test (`gate.test.ts`,
  `sandbox.test.ts`, `i18n.test.ts`, ...) on the Node lane; UI tests live in `tests/ui/`
  on the Bun lane with the `tests/support/otui.tsx` harness.
