---
title: Extensions
description: One TypeScript file is an extension - hooks, commands, tools, UI.
---

mojocode extensions have the same shape as [pi](https://github.com/badlogic/pi-mono) extensions: a TypeScript / JavaScript module whose default export is a function that receives `api` and registers hooks, commands and tools. The hook table, the API surface and the rendering layer are deliberately **named and shaped like Pi's** - if you have written a Pi extension you can write one here; the remaining differences are listed at the end. Extensions run in the same process as the TUI (Pi's model): commands and status lines go straight into the menu and above the input box, user-facing notices go to the timeline, and questions or custom UI go through `ctx.ui`.

```ts
// ~/.mojocode/extensions/no-rm.ts
export default (api) => {
  // Called before every tool execution; return { block: true, reason } to veto.
  // The reason is fed back to the model as a tool error (keep it English);
  // the turn keeps going.
  api.on('tool_call', ({ toolName, input }) => {
    const cmd = String((input as { command?: unknown }).command ?? '');
    if (toolName === 'bash' && /\brm\s+-rf\b/.test(cmd)) {
      return { block: true, reason: 'rm -rf is blocked by the no-rm extension' };
    }
    return undefined;
  });

  api.registerCommand('hello', {
    description: 'say hi',
    handler: async (args, ctx) => {
      // Ask the user: the TUI shows a prompt; headless resolves the default at once.
      const ok = await ctx.ui.confirm('hello', `say hi to ${args}?`);
      if (ok) api.notify('info', `hi ${args}`);
    },
  });
};
```

Types come from `mojocode/extension`: `import type { ExtensionAPI, ExtensionComponent } from 'mojocode/extension'`. The same entry exports two ready-made component factories, `selectList` / `textInput` (see below), and `ExtensionEvents`.

`export default { id, setup(api) {…} }` is accepted too; the id defaults to the file name (`foo.ts` → `foo`, `foo/index.ts` → `foo`, prefixed with `<package>/` inside a package). `setup` may be async.

## Load order

Three sources plus the command line, loaded in this order; a later command / tool with the same name overrides an earlier one, and the built-in first-party extensions always come first:

| Source | Location | Notes |
|---|---|---|
| Packages | recorded in the config key `packages` by `mojocode install …` | see [Packages](/extensions/packages/) |
| Global directory | `~/.mojocode/extensions/` | `*.ts` / `*.js` / `*.mjs`, or `<name>/index.ts` |
| Project directory | `<project>/.mojocode/extensions/` | can be committed with the repo |
| Config | `extensions: ["path", …]` (global or project config) | same as `-e` but persistent; relative paths resolve against the workspace root; the two layers are unioned |
| Command line | `mojocode -e <file-or-dir>`, repeatable | try an extension once |

Flags an extension declares with `api.registerFlag` are passed as `mojocode -X name` / `-X name=value` (repeatable) and read with `api.getFlag(name)` according to the declared type.

TypeScript works as is: the single binary (Bun) loads `.ts` natively, the npm-installed Node build transpiles through [jiti](https://github.com/unjs/jiti). An extension that fails to load (syntax error, `setup` throws, duplicate id) produces one notice at startup and is skipped; the session carries on. `mojocode extensions` lists everything this workspace would load, with its source. After editing an extension file, type `/reload` in the TUI: disk extensions are unloaded one by one (hooks, commands, tools, shortcuts and UI surfaces are all withdrawn) and loaded again; built-in extensions are untouched.

## Hooks

Hooks are async, run serially in registration order, and their return values matter. Every handler receives two arguments: the input and a `ctx` shaped like Pi's (next section). Every input carries a `subagent` flag: subagents (the task tool, fork skills) share the hook table with the main agent; whether to treat them differently is up to the extension.

| Hook | When | Return value | On failure |
|---|---|---|---|
| `session_start` | after the session is in place (`reason`: `startup` / `new` / `resume` / `fork`), history and state already swapped | none | reported only |
| `session_shutdown` | session closes | none | reported only |
| `input` | before user input enters the conversation, `{ text, images, source: 'turn' \| 'guidance' }`; messages sent by extensions or skills do not pass through it | `{ action: 'transform', text }` rewrites; `{ action: 'handled' }` swallows it (no turn starts) | keeps the value |
| `agent_start` | a run's chain begins, `{ userText }` | none | reported only |
| `before_agent_start` | before each stream, `{ systemPrompt, userText }` | `{ systemPrompt }` rewrites the outgoing system prompt; `{ message }` adds one user message to this turn (first stream only) | keeps the value |
| `context` | before each model call, `{ messages }` is a copy of what is about to be sent | `{ messages }` rewrites this request only; persisted history is untouched | keeps the value |
| `before_provider_request` | before the provider call (AI SDK middleware), `{ params, type }` - prompt / tools / providerOptions / headers all live in `params` | `{ params }` replaces | keeps the value |
| `tool_call` | before a tool runs, `{ callId, toolName, input }` | `{ block: true, reason }` vetoes | **failure vetoes** |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | tool actually starts / streams a `chunk` / finishes (raw `output`, `durationMs`) | none | reported only |
| `tool_result` | after the tool ran, before the result goes back to the model, `{ output, isError }` | `{ output }` rewrites | keeps the value |
| `message_end` | before each finished assistant / tool message joins history, `{ message }` | `{ message }` replaces | keeps the value |
| `session_before_compact` | before compaction, `{ reason: 'manual' \| 'auto' \| 'in-turn', messages }` | `{ cancel: true }` skips this one | treated as not cancelled |
| `session_compact` | after compaction, `{ reason, removedMessages, summaryChars }` | none | reported only |
| `model_select` / `thinking_level_select` | model / thinking level changed | none | reported only |
| `turn_start` | a turn starts, `{ userText }` | none | reported only |
| `turn_end` | a turn fully finished (history persisted), `{ outcome, usage, error }` | none; queue the next turn with `followUp` here | reported only |
| `agent_end` | a run's whole chain ended, `{ aborted, followUpsDropped }` | none | reported only |
| `agent_settled` | after `agent_end` once the agent is confirmed idle (no extension started another chain in `agent_end`) | none | reported only |
| `after_provider_response` | after the provider answered (AI SDK middleware), `{ type, params, response }` | none | reported only |
| `session_before_switch` / `session_before_fork` | about to `/resume` / `/fork` (also the extension's `switchSession` / `fork`), `{ id }` / none | `{ cancel: true }` cancels; the caller gets an error | treated as not cancelled |
| `resources_discover` | at startup after extensions loaded, collect resource directories | `{ skillPaths: [...] }`, relative to the workspace root | skipped |

`tool_call` failing closed is deliberate: without a permission system it is the only checkpoint an intercepting extension has, and treating a throwing handler as "allowed" would mean every tool runs bare as soon as that extension has a bug. All hook failures become a notice in the timeline and never bubble into the agent loop.

## ctx: the handler's second argument

Hook and command handlers both receive `ctx` (`api.ctx` is the same object), shaped like Pi's: `cwd`, `hasUI`, `mode` (`'tui' | 'print'`), `isIdle()`, `abort()`, `waitForIdle()`, `newSession()`, `fork()`, `switchSession(id)`, `model(id?)`, `config`, plus `ui` for talking to the interface. `isIdle()` and `waitForIdle()` share one definition: idle means no chain and no compaction running - appending to history during compaction would be swallowed when the compacted history replaces it. **Each extension gets its own `ctx`**, so `ctx.ui.setWidget` and friends are recorded under that extension and `/reload` can withdraw them:

| Member | Notes |
|---|---|
| `ui.select(title, items)` | pick one item; esc gives `undefined` |
| `ui.confirm(title, message)` | yes / no; esc gives `false` |
| `ui.input(title, placeholder?)` | one line of text; esc gives `undefined` |
| `ui.custom((host, done) => component)` | mount a component that draws itself and handles its own keys (Pi's `ctx.ui.custom`): it replaces the input box, owns the keyboard, and `done(value)` closes it and returns the value |
| `ui.setWidget(key, lines \| factory)` | a block above the input box; `undefined` clears |
| `ui.setHeader(…)` / `ui.setFooter(…)` | a block at the top of the screen; replaces the footer |
| `ui.setTitle(title)` | terminal window title |
| `ui.getEditorText()` / `ui.setEditorText(text)` | read / write the input box draft |
| `ui.notify(message, level?)` | same path as `api.notify` |

Two ready-made component factories save every extension from rewriting cursor and backspace handling: `selectList({ items, onSelect, onCancel?, title?, window? })` and `textInput({ placeholder?, initial?, onSubmit, onCancel? })`. Both return factories you can hand to `ui.custom` / `setWidget` (inside `ui.custom`, wire `done` to `onSelect` / `onSubmit`).

Components have Pi's `Component` shape: `render(width): string[]` (lines may carry ANSI colour - `host.theme.fg('accent', …)` and friends colour for you) and optionally `handleInput(data, key)` - `data` is the raw Pi-style sequence (printable characters as is, esc as `\x1b`, enter as `\r`, arrows as CSI sequences), `key` is the parsed form; use whichever you prefer. `host.requestRender()` asks for a repaint. Widgets, header and footer only draw; `custom` also receives keys. A tool definition's `renderCall(input, theme)` / `renderResult(output, options, theme)` return lines that replace the default rendering of that tool entry in the timeline; returning `undefined` or throwing falls back to the default.

**When nobody is watching** (`mojocode -p`) the asking calls resolve their defaults immediately (`select` / `input` / `custom` give `undefined`, `confirm` gives `false`) - the same outcome as the user pressing esc, so the extension need not tell the two apart; surface settings are ignored. `hasUI` exists only for extensions that want to skip the question altogether.

## ExtensionAPI

| Member | Purpose |
|---|---|
| `id` / `root` | extension id; workspace root |
| `on(hook, handler)` | register a hook, returns an unsubscribe function |
| `onEvent(handler)` | read-only subscription to the event bus (text-delta, tool-end, step-end, …) |
| `events` | an event bus between extensions (`on(type, handler)` / `emit(type, data)`), unrelated to the one above |
| `ctx` / `ui` / `hasUI` | the ctx handlers receive (previous section); `ui` and `hasUI` are two of its members |
| `registerCommand(name, { description, argumentHint?, selectorTitle?, options?, handler })` / `getCommands()` | slash command. With `options(path)` the command opens a selector first, multi-level (`expands`) and prefill (`prefill`) supported; **never await a whole turn inside `handler(args, ctx)`** |
| `registerShortcut(key, { description, handler })` | global shortcut, `key` like `ctrl+g` / `meta+shift+k`, ctrl or meta required; the keys the TUI owns - ctrl+c / ctrl+t / ctrl+o / ctrl+r - **throw at registration**; not dispatched while an overlay is open. Returns an unsubscribe function |
| `sendMessage({ customType, content, display? }, { triggerTurn? })` | put a typed message into the conversation (Pi's sendMessage): with `triggerTurn` it starts a new turn; otherwise it is injected as guidance while running, or appended to history without a turn when idle. History stores an `[extension message: <type>]` envelope that replay understands |
| `registerMessageRenderer(customType, (message, theme) => lines)` | how a custom message is drawn in the timeline; unregistered types get a `[type]` label plus the text |
| `mode` / `waitForIdle()` / `newSession()` / `fork()` / `switchSession(id)` | same as the ctx members |
| `registerTool(name, (scope) => Tool \| undefined, { promptSnippet?, promptGuidelines?, renderCall?, renderResult? }?)` / `unregisterTool(name)` | a model-callable tool. Pass a factory, not the tool: decide per `scope.subagent` / `scope.mode` (`general` / `explore`) whether to provide it. Built-in tool names cannot be overridden. Tools with a snippet are gathered by the host into an "Extension tools" section of the system prompt, always consistent with what is actually registered |
| `registerTool({ name, description, parameters, execute, promptSnippet?, promptGuidelines?, renderCall?, renderResult?, scope? })` | Pi-shaped tool definition: `parameters` is JSON Schema (a TypeBox schema works as is), `execute(toolCallId, params, signal, onUpdate, ctx)` has Pi's signature, and a Pi `{ content: [{ type: 'text', text }] }` result is flattened to text for the model; `renderCall` / `renderResult` return lines |
| `getAllTools()` / `getActiveTools()` / `setActiveTools(names \| undefined)` | every tool name in the main tool set; the ones currently offered to the model; offer only these (main agent and subagents alike), the rest stay registered |
| `registerFlag(name, { description, type, default? })` / `getFlag(name)` | command-line flags (`-X name[=value]`) |
| `setStatus(text, { since? })` | one status line above the input box, `undefined` clears; entries with `since` get a live elapsed time |
| `setState(key, value)` | structured state for the TUI, rendered per key (the todo list works this way); must be JSON-serialisable |
| `notify(level, message)` | a notice in the timeline, `info` / `warn` |
| `publishRuntime(key, get)` | expose a runtime snapshot to the host; only `/doctor` reads it today |
| `run(text, { display?, images? })` | start a turn; while running it degrades to in-turn guidance. Messages sent by extensions do not pass the `input` hook |
| `followUp(text, options?)` | start as a new turn after the current chain finishes; starts immediately when idle |
| `isRunning()` / `abort()` | busy state; interrupt |
| `history()` | model history (a summary plus tail after compaction) |
| `compact()` / `getContextUsage()` | manual compaction (same path as `/compact`); context usage `{ used, window, percent }` |
| `appendEntry(type, data)` / `entries(type)` | custom records in the session file: forked with the session, read back on `/resume`. Restore your state from here in `session_start` |
| `getSessionName()` / `setSessionName(name)` | the session title (the row in the session list) |
| `config` | session config, by reference |
| `model(modelId?)` | the current provider's model; pass an id for another model of the same provider (evaluators, cheap models) |
| `getModel()` / `setModel({ provider?, model? })` | current provider and model id; switch (same path as `/models`, fires `model_select`) |
| `getThinkingLevel()` / `setThinkingLevel(level)` | thinking level (same path as `/think`, fires `thinking_level_select`) |
| `exec(command, args, { cwd?, timeoutMs?, signal?, env? })` | run an external command without a shell; a non-zero exit code does not throw (check `exitCode`) |

Keep the three "speaking" members apart: `setStatus` is one line of text for humans, `setState` is data, `publishRuntime` is for `/doctor` only.

## Command handler discipline

Awaiting a few seconds of git inside a handler leaves the `/` menu stuck on submit. To start a turn, `followUp`; to do long work, push it to the background and return synchronously. Whether the extension is "busy" is the extension's own call - the TUI does not block commands for it (`/goal clear` is exactly the command you need while the loop is running).

## First-party extensions

The six built-in extensions - `goal` / `review` / `todo` / `web` / `mcp` / `lsp` - use the same API as disk extensions; their source (`src/extensions/`) is the most complete example. See [Built-in extensions](/extensions/builtin/).

## Differences from Pi

Loading, hooks, the API surface and the rendering layer mirror Pi; the deliberate omissions:

| Pi has, mojocode does not | What to use instead |
|---|---|
| `registerEntryRenderer` / `registerMarkdownTransformer` | `registerMessageRenderer` for custom messages, `renderCall` / `renderResult` for tool entries, `setWidget` / `setState` for the rest |
| Session tree: `fork(entryId)`, `navigateTree`, `setLabel`, `session_before_tree` | sessions are linear JSONL; `/fork` copies the whole session |
| `registerProvider`, `models.json` | providers are defined in the config (`providers.<id>`); rewrite requests with `before_provider_request` |
| `project_trust` | there is no permission system (a deliberate decision, like Pi) |
| bare `--my-flag` | `-X my-flag` (commander can only pass unknown options through wholesale, see `src/extensions/flags.ts`) |
| pi-tui component classes (`Container`, `Text`, `SelectList`, …) | a component only needs `render(width)` + `handleInput`; `selectList` / `textInput` cover the common cases, `host.theme` gives colours |

Pi ecosystem extensions do **not** run unchanged: they import types from `@mariozechner/pi-coding-agent` and build UI from pi-tui classes. The shapes match, so switching the import and replacing pi-tui components with your own lines (or `selectList` / `textInput`) is all it takes.
