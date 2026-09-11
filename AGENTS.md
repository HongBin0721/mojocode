# AGENTS.md

`mojocode` — a terminal coding agent (full-screen OpenTUI TUI + headless `-p` mode) that
works with any LLM via the Vercel AI SDK. ESM-only (`"type": "module"`), TypeScript with
`strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`/`noUnusedParameters`. **Single
process, Pi-style**: TUI, agent core, tools, extensions, MCP, LSP and the session store all
live in one process. Runtime split: `-p` and subcommands run on Node ≥ 22; the TUI needs
native FFI — Bun (primary, single-binary distribution) or Node ≥ 26.1 with
`--experimental-ffi` (auto re-exec injects the flag, `src/app/runtime.ts`).

`CLAUDE.md` is the long-form companion (design history, review findings, gotchas); this file
is the short map. Keep the two consistent when the tree changes.

## Commands (verified against package.json)

```bash
npm run build       # tsup → dist/cli.js + lazy chunks (esm, splitting on, deps external)
npm run dev         # tsup --watch
npm run typecheck   # tsc --noEmit — tsup does NOT typecheck; this is the gate
npm test            # core tests, Node lane (excludes tests/ui/)
npm run test:ui     # UI tests — MUST run under Bun (= bun --bun x vitest run --config vitest.ui.config.ts)
npm run build:bin   # bun scripts/build-binaries.ts — single binaries for 6 platforms
npx vitest run tests/hooks.test.ts      # single core test file
npx vitest run -t "name substring"      # single test by name
node dist/cli.js    # run the built CLI
cd website && npm ci && npm run build   # docs site (Astro Starlight), separate package
```

There is no lint config; `npm run typecheck` + both test lanes are the correctness gates.
UI tests need Bun because OpenTUI's test renderer is the real native renderer (FFI). CI
(`.github/workflows/test.yml`) also runs the core lane under Bun to guard dual-runtime compat.

## Architecture

**The agent core never imports the UI framework (SolidJS).** `src/core/events.ts` defines
the contract: the core emits typed `AgentEvent`s over an `EventBus`. One agent loop drives
both the OpenTUI TUI (`src/ui/App.tsx`) and the non-interactive `-p` renderer
(`src/app/headless.ts`). The UI consumes the narrow `SessionHandle` interface
(`src/app/session-handle.ts`); the `Session` built by `src/app/bootstrap.ts` satisfies it
structurally, and UI tests build fake sessions against it (`tests/support/extensions.ts`'s
`stubExtensions()` must list every extension-facing member App reads).

**Process model.** `src/cli.tsx` (commander entry: `auth`, `models`, `providers`,
`sessions`, `doctor`, `install`, `remove`, `extensions`, `config`) bootstraps a `Session`
and hands it straight to `runTui` or `renderHeadless`. There is no server, no protocol
layer, no RPC — an earlier opencode-style `serve` sidecar, REST+SSE client and Electron GUI
were removed deliberately (commit `be17f24`) so extensions can hand the TUI live
**components**. The TUI is a lazy `import('./ui/tui.js')` — never import `src/ui/` (→ kit →
`@opentui/core`, which needs FFI at module load) statically from anything on the `-p` path.

One turn: `Agent.run()` (`src/agent/loop.ts`, AI SDK `streamText` + `stepCountIs`) → tools
are wrapped per stream with the hook layer (`src/agent/hooked-tools.ts`) → events stream to
the renderer → history persists to append-only JSONL in `~/.mojocode/sessions/`.

**No permission system** (deliberate, like Pi; commit `4a856ef`). Tools resolve paths
relative to the workspace via `src/tools/paths.ts` with no fence. To intercept, write an
extension: a `tool_call` hook returning `{ block: true, reason }` vetoes; to ask the user,
`ctx.ui.confirm`. `tool_call` hook failure **vetoes** (fail closed). Old `sandbox` /
`approval` / `permissions` config keys are ignored as unknown.

- `src/core/` — `events.ts` (bus), `hooks.ts` (`HookRegistry`, snake_case hook names,
  async, serial, return values matter), `extension.ts` (`ExtensionAPI`, the **only** surface
  an extension touches; members named after Pi's), `extension-types.ts` (Node-free wire
  types shared with UI components), `ui-kit.ts` (`selectList` / `textInput`),
  `palette.ts` (the single colour table; TUI and `ExtensionTheme` both read it).
- `src/extensions/` — first-party extensions `goal` `lsp` `mcp` `review` `todo` `web`
  (`index.ts`), plus `loader.ts` (disk discovery: packages → `~/.mojocode/extensions` →
  `<root>/.mojocode/extensions` → config `extensions:[]` → `-e`), `packages.ts`
  (`mojocode install npm:|git:|<path>`, manifest key `mojocode`), `flags.ts` (`-X name[=value]`),
  `tool-adapter.ts` (Pi-shaped `registerTool(definition)`). Disk `.ts` loads natively on
  Bun, via jiti on Node. `/reload` unloads and reloads disk extensions through an undo stack.
- `src/extension-entry.ts` — the public `mojocode/extension` entry (types + `selectList` /
  `textInput` + `ExtensionEvents`).
- `src/tools/` — builtin `read write edit glob grep bash` (+ `view_image` when a vision
  model resolves) and `task` (subagent, one recursion level, `mode: 'explore'` is
  read-only). `web_fetch` / `web_search` belong to the `web` extension, `todo` to the
  `todo` extension; `skill` is built by `src/skills/`. Extensions may not override builtin
  names (`BUILTIN_TOOL_NAMES` in bootstrap).
- `src/skills/` — Agent Skills (`SKILL.md` dirs) from `.mojocode/skills` + `.claude/skills`
  (project > global), a `skill` tool, slash invocation (`/name args` → `runSkill`),
  `context: fork` runs through `runTaskSubagent`. The `<skill-command>` first-line marker
  in `invocation.ts` is a persistence contract (like `INIT_PROMPT_MARKER`) — never change it.
- `src/agent/` — loop, system prompt (`prompt.ts` injects this file, or `MOJOCODE.md` /
  `CLAUDE.md` as fallbacks), compaction (`compact.ts`), `/init`, review collectors shared
  by `/review` (extension) and `/simplify` (core).
- `src/config/` — layered config: builtin → `~/.mojocode/config.json` → project
  `.mojocode/config.json` → `MOJOCODE_*` env → CLI flags. Zod schemas in `schema.ts`;
  provider presets in `providers.ts`; `save.ts` writes single keys back (`/theme` writes to
  whichever layer already holds `theme`, otherwise global).
- `src/mcp/`, `src/lsp/` — mechanism libraries; policy lives in the `mcp` / `lsp` extensions.
  They stay in core because `mojocode doctor` uses them without a session.
- `src/session/` — append-only JSONL store; `append` on pure extension, else `snapshot`;
  `<id>.meta.json` sidecar makes `list()` O(1). `custom` records carry extension state
  (`api.appendEntry`), `task` and `usage` records ride the same file; unknown kinds are skipped.
- `src/i18n/` — `en.ts` / `zh-CN.ts` with a parity test asserting key sets match.
- `src/ui/` — **SolidJS** (`@opentui/solid`) components; `kit.tsx` is the renderer adapter
  exposing Ink-shaped `Box`/`Text`/`useInput`/`useApp`/`render` — components import kit,
  never `@opentui/*` directly. Solid discipline: never destructure props; derived values are
  functions/memos; multi-signal updates observed by an effect must be `batch()`ed. Span
  (TextNode) styles only apply via the `style` prop; bare `solid-js` resolves to the
  non-reactive SSR stub under Node/Bun conditions — the build and both vitest configs pin
  `solid-js/dist/solid.js`; keep it pinned. `theme` (`ui/theme.ts`) is a reactive Proxy
  over `core/palette.ts`: read `theme.x` inside JSX/memos, never snapshot at module level.
  Slash commands: `ui/commands/registry.ts` (table) + `ui/commands/index.ts` (dispatch) +
  handlers in `*-cmds.ts`; enumerated arguments get a second-level picker via
  `SlashCommand.options(path)`, `onHighlight` previews the highlighted item (`/theme`).
  Two collapse axes: `/focus` (ctrl+o) hides whole entries (`user`/`assistant`/`error`/
  `banner` and notices never — `tests/focus.test.ts`); ctrl+r toggles reasoning and raw
  tool-output *bodies*. Single-line rows must be measured and cut before layout
  (`Footer.fitParts`). Diff rows use `highlightDiffLine` with `DIFF_THEME`, not `highlightLine`.
- `website/` — docs (Astro Starlight): Chinese pages in `src/content/docs/`, English mirrors
  under `src/content/docs/en/` with the same slugs. Update both when behaviour changes.

## Conventions

- **Code comments are written in Simplified Chinese** — keep new comments in Chinese.
- **UI strings are localized; text fed back to the model (tool errors, hook veto reasons)
  stays English-only** — mixed language degrades function calling.
- **Never hardcode model IDs** — presets are starting defaults only; `mojocode models`
  fetches the live list.
- **GLM baseURL is `/api/paas/v4`** — never append `/v1` (404s).
- **Use `result.responseMessages` for history**, not `result.response.messages` — the
  latter only holds the last step and silently drops earlier tool calls.
- **Kit's `render()` defaults `exitOnCtrlC: false`** — otherwise the renderer swallows
  ctrl+c before `useInput`, breaking double-ctrl+c-to-exit (startup wizard/picker opt back in).
- **In-turn compaction shrinks only the messages sent to the model**; persistent history
  stays full, and `historyNeedsCompact` forces compaction at next turn start.
- `src/config/paths.ts` resolves home from `$HOME`/`$USERPROFILE`, never bare `os.homedir()`
  (Bun snapshots it; tests that stub HOME would read the developer's real config).
- Timeline items are immutable once finalized — `<For>` reuses entries by reference and
  `renderMarkdownAnsi` is LRU-cached by `(key, width)` in `md-cache.ts`; keep the
  wrap-safety margin (`WIDTH_SAFETY`) and truncate by display width (`truncateWidth`).
- Every extension gets its own `ctx` whose `hasUI` is a getter — never `{ ...ctx }` it.
  Hook/command/shortcut registrations carry that ctx so `/reload` can undo them.
- Core tests live in `tests/*.test.ts` mirroring the module under test on the Node lane;
  UI tests live in `tests/ui/` on the Bun lane with the `tests/support/otui.tsx` harness.
