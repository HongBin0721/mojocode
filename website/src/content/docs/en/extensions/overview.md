---
title: Extensions
description: One TypeScript file is an extension - hooks, commands, tools, UI.
---

mojocode extensions have the same shape as [pi](https://github.com/badlogic/pi-mono) extensions: a TypeScript / JavaScript module whose default export is a function that receives `api` and registers hooks, commands and tools. Hook names, API member names, hook payload field names and the rendering layer are deliberately **named like Pi's** - if you have written a Pi extension you can write one here; where fields and semantics still differ is listed in the [comparison](#differences-from-pi) at the end. Extensions run in the same process as the TUI (Pi's model): commands and status lines go straight into the menu and above the input box, user-facing notices go to the timeline, and questions or custom UI go through `ctx.ui`.

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
| `session_start` | after the session is in place (`reason`: `startup` / `new` / `resume` / `fork` / `reload`), history and state already swapped; a session change carries `previousSessionFile` (absolute path of the previous session file). `reload` goes only to extensions that `/reload` just loaded again; they restore their state from the session records here | none | reported only |
| `session_shutdown` | `{ reason: 'quit' \| 'reload' }`: the process exits, or `/reload` unloads this extension. Switching sessions does **not** fire it (the extension runtime lives across sessions) | none | reported only |
| `input` | before user input enters the conversation, `{ text, images, source: 'turn' \| 'guidance' }`; messages sent by extensions or skills do not pass through it | `{ action: 'transform', text }` rewrites; `{ action: 'handled' }` swallows it (no turn starts) | keeps the value |
| `agent_start` | a run's chain begins, `{ userText }` | none | reported only |
| `before_agent_start` | before each stream, `{ systemPrompt, prompt }` | `{ systemPrompt }` rewrites the outgoing system prompt; `{ message }` joins this turn's context (first stream only): a string is a user message, Pi's `{ customType, content, display?, details? }` enters history as a custom message and shows in the timeline (not with `display: false`) | keeps the value |
| `context` | before each model call, `{ messages }` is a copy of what is about to be sent | `{ messages }` rewrites this request only; persisted history is untouched | keeps the value |
| `before_provider_request` | before the provider call (AI SDK middleware), `{ params, type }` - prompt / tools / providerOptions / headers all live in `params` | `{ params }` replaces | keeps the value |
| `tool_call` | before a tool runs, `{ toolCallId, toolName, input }` | `{ block: true, reason }` vetoes | **failure vetoes** |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | tool actually starts (`args`) / streams a `partialResult` / finishes (raw `result`, `durationMs`). All carry `toolCallId` and `toolName` | none | reported only |
| `tool_result` | after the tool ran, before the result goes back to the model, `{ toolCallId, output, content, details, isError }` (`content` is the content parts the model sees, `details` the rendering data of a Pi-shaped tool) | `{ output }` replaces it wholesale; or Pi's `{ content, details, isError }`: `content` replaces what the model sees, `details` the rendering data, `isError` flips success to error or back | keeps the value |
| `message_start` / `message_update` | an assistant message starts streaming (one per step) / each streamed delta; `{ message }` is the partial message accumulated so far, `message_update` also carries `{ delta: { type: 'text' \| 'reasoning', id, text } }`. Nothing is assembled when nobody listens | none | reported only |
| `message_end` | before each finished assistant / tool message joins history, `{ message }` | `{ message }` replaces | keeps the value |
| `user_bash` | the user typed `!<command>` in the input box, before it runs, `{ command, cwd }` | `{ command }` rewrites the command; `{ run({ command, cwd, signal }) }` takes over execution (a container, a remote host) and returns `{ exitCode, output }`. The output joins history as a `user_bash` custom message without starting a turn | treated as silent |
| `session_before_compact` | before compaction, `{ reason: 'manual' \| 'auto' \| 'in-turn', messages }` | `{ cancel: true }` skips this one | treated as not cancelled |
| `session_compact` | after compaction, `{ reason, removedMessages, summaryChars }` | none | reported only |
| `model_select` / `thinking_level_select` | model / thinking level changed: `{ provider, model, previousProvider, previousModel, source: 'set' }` / `{ level, previousLevel }` | none | reported only |
| `turn_start` | a turn starts, `{ userText }` | none | reported only |
| `turn_end` | a turn fully finished (history persisted), `{ outcome, usage, error }` | none; queue the next turn with `followUp` here | reported only |
| `agent_end` | a run's whole chain ended, `{ aborted, followUpsDropped }` | none | reported only |
| `agent_settled` | after `agent_end` once the agent is confirmed idle (no extension started another chain in `agent_end`) | none | reported only |
| `after_provider_response` | after the provider answered (AI SDK middleware), `{ type, params, response }` | none | reported only |
| `session_before_switch` / `session_before_fork` | about to `/new` or `/resume` / `/fork` (also the extension's `newSession` / `switchSession` / `fork`): `{ reason: 'new' \| 'resume', id?, targetSessionFile? }` (on resume the prefix is already resolved) / none | `{ cancel: true }` cancels: the command path shows a failure, the extension's ctx path gets `{ cancelled: true }` | treated as not cancelled |
| `session_switch` / `session_fork` | switched to / forked into a new session (after `session_start`), `{ id }` is the new session id | none | reported only |
| `resources_discover` | collect resource directories, `{ cwd, reason: 'startup' \| 'reload' }`: every extension at startup, and every extension again after each `/reload`, replacing the previous result (directories from a removed extension go away) | `{ skillPaths, promptPaths, themePaths }`, relative to the workspace root: skill directories, prompt-template directories (each `*.md` becomes a `/name`), theme directories (`<name>.json`) | skipped |

Field names follow Pi. A few synonyms this project used earlier - `callId` (i.e. `toolCallId`), `input` / `output` / `chunk` in the tool execution hooks (i.e. `args` / `result` / `partialResult`), and `userText` in `before_agent_start` (i.e. `prompt`) - are **deprecated**: they are still filled in during the migration period and carry `@deprecated` in the types (your editor strikes them through), and a later release will remove them. The `input` of `tool_call` / `tool_result` and the `output` of `tool_result` are not affected: Pi uses that `input` name itself, and that `output` is the tool's raw structured return, which has no Pi counterpart.

`tool_call` failing closed is deliberate: without a permission system it is the only checkpoint an intercepting extension has, and treating a throwing handler as "allowed" would mean every tool runs bare as soon as that extension has a bug. All hook failures become a notice in the timeline and never bubble into the agent loop.

## ctx: the handler's second argument

Hook and command handlers both receive `ctx` (`api.ctx` is the same object), shaped like Pi's: `cwd`, `hasUI`, `mode` (`'tui' | 'print'`), `isIdle()`, `abort()`, `signal` (the AbortSignal of the turn currently streaming; `undefined` when nothing streams - between turns too), `hasPendingMessages()`, `shutdown()` (graceful exit: aborts the current turn, the TUI leaves through the same path as double ctrl+c, under `-p` the CLI finishes normally and a turn that has not started yet is skipped), `getSystemPrompt()` (the prompt the core assembled; a `before_agent_start` rewrite only exists at the moment a stream opens), `getContextUsage()`, `compact({ customInstructions?, onComplete?, onError? })` (instructions are appended after the default summary prompt; with `onError` given it no longer rejects), `waitForIdle()`, `newSession(options?)`, `fork(options?)`, `switchSession(id, options?)`, `reload()` (same path as `/reload`; calling it from your own handler unloads yourself, the rest of the handler runs in the old closure. It throws while extensions are loading or reloading - calling it then would wait on a reload that is waiting on you), `model(id?)`, `config`, `sessionManager`, `modelRegistry`, plus `ui` for talking to the interface. The three session operations resolve to `{ cancelled }` (`fork` also carries `id` on success): a veto from `session_before_switch` / `session_before_fork` is a receipt, not an exception, while real errors such as an unknown session still throw; `options.withSession(ctx)` runs once the new session is in place and receives this same `ctx` - it reads the current session by reference, so after the switch it points at the new one. `sessionManager` is a **read-only** view of the current session (`getSessionId` / `getSessionName` / `getEntries(type?)` / `getHistory` / `getDisplayHistory` / `listSessions`); writes go through the API members of the same names. `modelRegistry` is the model table: `getCurrent` / `getProviders` / `getModels(providerId?)` / `find` read the models known from config and presets synchronously, `capabilities(provider, model)` queries the models.dev catalog and `probe()` lists live (the same path as `/models`). `isIdle()` and `waitForIdle()` share one definition: idle means no chain and no compaction running - appending to history during compaction would be swallowed when the compacted history replaces it. **Each extension gets its own `ctx`**, so `ctx.ui.setWidget` and friends are recorded under that extension and `/reload` can withdraw them:

| Member | Notes |
|---|---|
| `ui.select(title, items, opts?)` | pick one item; esc gives `undefined`. `opts.timeout` (ms) dismisses as "unanswered" when it elapses (the prompt counts down); `opts.signal` aborting does the same |
| `ui.confirm(title, message, opts?)` | yes / no; esc, timeout and abort all give `false` |
| `ui.input(title, placeholder?, opts?)` | one line of text; esc gives `undefined` |
| `ui.editor(title, prefill?, opts?)` | multi-line editor: enter submits, a trailing `\` + enter inserts a newline; esc gives `undefined` |
| `ui.custom((host, done) => component, options?)` | mount a component that draws itself and handles its own keys (Pi's `ctx.ui.custom`): by default it replaces the input box and owns the keyboard, `done(value)` closes it and returns the value. With `{ overlay: true }` it floats above the timeline and the input box stays put (the keyboard still belongs to the component); `overlayOptions` positions and sizes it (`width` / `height` / `min*` / `max*` as numbers or percentages, `anchor` with nine positions or absolute `row` / `col`, `offsetX/Y`, `margin`, `visible(w, h)`); `onHandle(handle)` hands you `setHidden(bool)` / `hide()`. An overlay **owns the keyboard only while it is drawn**: a hidden one (`setHidden(true)`, or `visible` saying no) hands the keyboard back to the input box; while it owns the keyboard, extension prompts queue behind it and appear once it closes |
| `ui.setWidget(key, lines \| factory, { placement? })` | a block above (default) or below (`'belowEditor'`) the input box; `undefined` clears |
| `ui.setHeader(…)` / `ui.setFooter(…)` | a block at the top of the screen; replaces the footer |
| `ui.setTitle(title)` | terminal window title |
| `ui.setStatus(key, text)` | **one keyed entry under this extension** in the status line above the input box; `undefined` clears. Coexists with the un-keyed, `since`-ticking `api.setStatus` |
| `ui.setWorkingMessage(text)` | replaces the "thinking / responding" label in the status line (not while a tool or compaction runs); `undefined` restores |
| `ui.setWorkingVisible(visible)` | `false` hides the whole working status line (even while running); the input box's top edge falls back to the idle rule |
| `ui.setWorkingIndicator({ frames, intervalMs? })` | swaps the spinner frames: `['●']` is a static marker, `[]` draws no spinner, custom frames are rendered verbatim (bring your own colours); `intervalMs` defaults to 100 with a floor of 16; omit to restore the default animation |
| `ui.setHiddenThinkingLabel(label?)` | the label on a collapsed thinking entry (default "Thought …"); omit to restore |
| `ui.setEditorComponent((host, submit) => component)` / `ui.getEditorComponent()` | replaces the default input box: the component draws itself and handles keys, `submit(text)` takes the same path as pressing enter in the default box (slash commands, `!` commands, @ references included); optional `getText` / `setText` / `insertText` back `getEditorText` / `setEditorText` / `pasteToEditor` (without `insertText`, a paste degrades to appending at the end); `undefined` restores. `getEditorComponent` reads the current factory back |
| `ui.theme` | the colour helpers (`fg(name, text)` / `bold` / `dim` / `italic`), the same object as a component's `host.theme`, available headless too |
| `ui.getAllThemes()` / `ui.getTheme(name)` / `ui.setTheme(name \| colors)` | list the selectable themes (built-in `default` plus every `<name>.json` in the theme directories), read one theme's colours by name, switch (by name or with a `colors` object). Unlike `/theme` it **neither persists nor remounts the tree** - it only recomputes nodes that read `theme.x`, because an extension that follows the OS light/dark setting calls this at any time and must not wipe the user's draft. All three return Promises (Pi's are synchronous because it pre-scans at startup; we scan the directories on demand). When `setTheme` calls overlap only the last one takes effect; earlier ones resolve to `{ success: false }` |
| `ui.getToolsExpanded()` / `ui.setToolsExpanded(expanded)` | the ctrl+r details toggle (thinking text, tool output); headless always `false` / ignored |
| `ui.onTerminalInput(handler)` | listen to raw terminal sequences (**before** the TUI parses them into keys): return `{ consume: true }` to swallow one so no component sees it. Returns an unsubscribe function. There is no Pi-style `data` rewrite |
| `ui.getEditorText()` / `ui.setEditorText(text)` / `ui.pasteToEditor(text)` | read / write the input box draft; insert at the cursor |
| `ui.notify(message, level?)` | same path as `api.notify`; `level` is `info` / `warn` / `error` (Pi's spelling `warning` is accepted too), `error` renders red with a `✗` prefix |

While an extension editor or an overlay-style `ui.custom` is mounted, **`esc` during a running turn always means "interrupt" and is not forwarded to the component** - handing it over wholesale would leave a user whose editor extension ignores `esc` with nothing but double `ctrl+c`, which exits the whole program. When idle, `esc` goes to the component as usual (so `esc` `esc` rewind is unavailable while an extension editor is mounted - that follows from "the keyboard belongs to the component").

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
| `sendMessage({ customType, content, display?, details? }, { triggerTurn?, deliverAs? })` | put a typed message into the conversation (Pi's sendMessage). `deliverAs`: `steer` is in-turn guidance while running, `followUp` becomes a new turn after the current chain, `nextTurn` neither interrupts nor starts a turn and joins history right after the next **user** prompt (slash skills included); `triggerTurn` decides whether an idle agent starts a turn. Without `deliverAs` the previous semantics hold (while running, `triggerTurn` queues after the chain, otherwise guidance). `content` may be Pi's parts array (text only); `display: false` joins the conversation without a timeline entry (the flag is written into the history envelope, so `/resume` replay hides it too), a string is alternate text; `details` goes to `registerMessageRenderer`. Alternate text and `details` live only in this session's timeline and are not persisted (`/resume` replay does not have them). A `steer` that happens to meet the end of the running turn is handled as if idle (a turn if `triggerTurn`, otherwise appended to history) rather than dropped. History stores an `[extension message: <type>]` envelope that replay understands |
| `sendUserMessage(content, { deliverAs? })` | send a message as the user (Pi's sendUserMessage): idle, it starts a new turn (without waiting for it); while running `deliverAs: 'steer' \| 'followUp'` is required, otherwise it throws. Image parts in `content` become image attachments. It does not pass through the `input` hook. `ctx` has both members too (Pi's `withSession` callbacks use them) |
| `registerMessageRenderer(customType, (message, theme) => lines)` | how a custom message is drawn in the timeline; unregistered types get a `[type]` label plus the text |
| `mode` / `waitForIdle()` / `newSession(options?)` / `fork(options?)` / `switchSession(id, options?)` | same as the ctx members; the rest of the control surface (`signal` / `shutdown` / `reload` / `getSystemPrompt` / `hasPendingMessages`) lives on `ctx` only, as in Pi |
| `registerTool(name, (scope) => Tool \| undefined, { promptSnippet?, promptGuidelines?, renderCall?, renderResult? }?)` / `unregisterTool(name)` | a model-callable tool. Pass a factory, not the tool: decide per `scope.subagent` / `scope.mode` (`general` / `explore`) whether to provide it. Built-in tool names cannot be overridden. Tools with a snippet are gathered by the host into an "Extension tools" section of the system prompt, always consistent with what is actually registered |
| `registerTool({ name, description, parameters, execute, promptSnippet?, promptGuidelines?, renderCall?, renderResult?, scope? })` | Pi-shaped tool definition: `parameters` is JSON Schema (a TypeBox schema works as is), `execute(toolCallId, params, signal, onUpdate, ctx)` has Pi's signature, and a Pi `{ content: [{ type: 'text', text }], details? }` result reaches the model as the `content` text only, while the **whole object** (including `details`) goes to `renderResult` and the `tool_result` hook; `details` never enters persistent history. `renderCall` / `renderResult` return lines |
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
| `compact(options?)` / `getContextUsage()` | same as ctx: manual compaction (same path as `/compact`; `customInstructions` is appended after the default summary prompt, concurrent calls share one run); context usage `{ used, window, percent }` |
| `appendEntry(type, data)` / `entries(type)` | custom records in the session file: forked with the session, read back on `/resume`. Restore your state from here in `session_start` |
| `getSessionName()` / `setSessionName(name)` | the session title (the row in the session list) |
| `config` | session config, by reference |
| `model(modelId?)` | the current provider's model; pass an id for another model of the same provider (evaluators, cheap models) |
| `getModel()` / `setModel({ provider?, model? })` | current provider and model id; switch (same path as `/models`, fires `model_select`) |
| `getThinkingLevel()` / `setThinkingLevel(level)` | thinking level (same path as `/think`, fires `thinking_level_select`) |
| `exec(command, args, { cwd?, timeoutMs?, timeout?, signal?, env? })` | run an external command without a shell; a non-zero exit code does not throw (check `exitCode`). `timeout` is Pi's name for `timeoutMs` |

Keep the three "speaking" members apart: `setStatus` is one line of text for humans, `setState` is data, `publishRuntime` is for `/doctor` only.

## Command handler discipline

Awaiting a few seconds of git inside a handler leaves the `/` menu stuck on submit. To start a turn, `followUp`; to do long work, push it to the background and return synchronously. Whether the extension is "busy" is the extension's own call - the TUI does not block commands for it (`/goal clear` is exactly the command you need while the loop is running).

## First-party extensions

The six built-in extensions - `goal` / `review` / `todo` / `web` / `mcp` / `lsp` - use the same API as disk extensions; their source (`src/extensions/`) is the most complete example. See [Built-in extensions](/extensions/builtin/).

## Differences from Pi

Loading, hooks, the API surface and the rendering layer mirror Pi; the deliberate omissions:

| Pi has, mojocode does not | What to use instead |
|---|---|
| Session tree: `fork(entryId, { position })`, `navigateTree`, `setLabel`, `session_before_tree` / `session_tree` | sessions are linear JSONL: `fork()` can only fork the whole session (it still resolves to Pi's `{ cancelled }`, plus `id` on success); there is no entry to point at |
| `registerProvider`, `models.json` | providers are defined in the config (`providers.<id>`); rewrite requests with `before_provider_request`; `ctx.modelRegistry` is read-only |
| bare `--my-flag` | `-X my-flag` (commander can only pass unknown options through wholesale, see `src/extensions/flags.ts`) |
| pi-tui component classes (`Container`, `Text`, `SelectList`, …) | a component only needs `render(width)` + `handleInput`; `selectList` / `textInput` cover the common cases, `host.theme` / `ui.theme` gives colours |
| `ui.addAutocompleteProvider` | not available. The input box's completion (slash commands, @ files) is built in; an extension that wants its own replaces the whole input box with `setEditorComponent` |
| the `{ data }` rewrite in `onTerminalInput` | only `{ consume }`: OpenTUI's input handlers can only answer "swallow or not" |
| synchronous `getAllThemes` / `getTheme` / `setTheme` | all three return Promises - the directories are scanned on demand rather than at startup, so theme files can be added at any time |
| writable `ctx.sessionManager`, the writable `SessionManager` handed to `newSession({ setup(sessionManager) })` | a read-only view; write through `appendEntry` / `setSessionName`, and put post-switch initialisation in `withSession(ctx)` |

`registerEntryRenderer` / `registerMarkdownTransformer` / `project_trust` are not listed because Pi 0.73 itself has removed them - neither side has them.

### Hook payloads and API shapes

With the names aligned, a set of places still share a name but differ in fields or meaning. An extension written for Pi reads `undefined` there rather than getting an error, so check each one when porting:

| Where | Pi | Here |
|---|---|---|
| What a "turn" is: `turn_start` / `turn_end` / `agent_start` / `agent_end` | a turn is **one model call plus its tool calls** (`turnIndex`, `timestamp`, `message`, `toolResults`); an agent run is one prompt | a turn is **the whole round for one user prompt** (possibly many steps), with `userText` / `outcome` / `usage` / `aborted` / `followUpsDropped`; there is no hook for a single call between steps |
| `input` | `source: 'interactive' \| 'rpc' \| 'extension'`, and `sendUserMessage` passes through it | `source: 'turn' \| 'guidance'`; messages sent by extensions do not pass through it |
| `context` / `message_start` / `message_update` / `message_end` | Pi's own `AgentMessage`; `message_update` carries `assistantMessageEvent` | the AI SDK's `ModelMessage`; `message_update` carries `delta: { type, id, text }` |
| `session_before_compact` / `session_compact` | carries `preparation` / `branchEntries` / `signal` and may return its own `compaction`; `compactionEntry` | only `reason` / `messages`, can only `{ cancel }`; `{ reason, removedMessages, summaryChars }` |
| `before_provider_request` / `after_provider_response` | `{ payload }` returning a new payload; `{ status, headers }` | `{ params, type }` returning `{ params }` (AI SDK middleware params); `{ type, params, response }` |
| `model_select` | `model` / `previousModel` are model objects | id strings (plus `provider` / `previousProvider`) |
| `user_bash` | returns `{ operations }` / `{ result }`; `excludeFromContext` for `!!` | returns `{ command }` to rewrite or `{ run }` to take over; no `!!` |
| `session_shutdown` | fires on every session switch (Pi rebuilds the whole runtime) | fires only on exit and `/reload` |
| `ctx.model` | a property, `Model \| undefined` | a method `model(id?)` returning an AI SDK model |
| `getContextUsage()` | `{ tokens, contextWindow, percent }` (nullable) | `{ used, window, percent }` |
| `getAllTools()` / `getCommands()` | arrays of objects | arrays of names |
| `setModel` | takes a model object, returns `Promise<boolean>` | takes `{ provider?, model? }` |
| a tool's `renderCall` / `renderResult` | return a component and receive a render context (`isPartial`, `expanded`, `state`, `invalidate()`) | return string lines and receive only `theme` (`renderResult` also gets `{ isError, expanded, input }`) |
| tool definitions | `prepareArguments`, `executionMode`, `renderShell` | not available |
| command completion | `getArgumentCompletions(prefix)` | the `options(path)` multi-level picker |

Pi ecosystem extensions do **not** run unchanged: they import types from `@mariozechner/pi-coding-agent` and build UI from pi-tui classes. The shapes match, so switching the import and replacing pi-tui components with your own lines (or `selectList` / `textInput`) is all it takes.
