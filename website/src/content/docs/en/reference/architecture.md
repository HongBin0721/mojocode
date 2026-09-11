---
title: Architecture
description: The core knows nothing about the UI; an event bus drives the frontends.
---

Core principle: **the agent core never imports a UI framework.** `src/core/events.ts` defines the contract, the core emits typed `AgentEvent`s onto a minimal event bus, and one loop drives the OpenTUI TUI and the `-p` headless renderer alike.

## Process model

The same single-process shape as pi: the TUI, the agent core, tools, extensions, MCP, LSP and the session store all live in one process, which is why an extension can hand interface components straight to the TUI (`ctx.ui.custom`, `setWidget`, a tool's `renderResult`).

```
src/
  config/      layered config, provider presets, key storage
  model/       AI SDK model construction, live /models lists, models.dev capability catalog
  agent/       the streamText loop, system prompt, context compaction, /init, /simplify, git collector
  tools/       read write edit glob grep bash task view_image (no path fencing)
  core/        event bus contract, hook layer, extension API
  extensions/  first-party extensions goal / lsp / mcp / review / todo / web, disk loader and packages
  skills/      skill discovery, frontmatter parsing, the slash and tool invocation paths
  mcp/         MCP client (bridged in extensions/mcp)
  lsp/         LSP client and server registry (policy in extensions/lsp)
  session/     append-only JSONL session records
  server/      HTTP + SSE server and the wire protocol
  client/      thin remote-session client (SSE state mirror plus serialized RPC)
  app/         bootstrap assembly, headless rendering, doctor, server launch
  i18n/        language catalogs en / zh-CN
  ui/          OpenTUI + SolidJS components; kit.tsx is the renderer adapter
website/       this documentation site, a separate package
```

## Data flow of one turn

`Agent.run()` wraps the AI SDK's `streamText`, with events flowing to the renderer; each step's history change is appended to `~/.mojocode/sessions/<id>.jsonl` through `onHistoryChange`. Tools are wrapped afresh by the hook layer on every stream (`tool_call` veto, `tool_result` rewrite); with no tool hook the original object goes straight to the SDK. The `turn_end` hook only runs after a turn has fully finished, and a message an extension `followUp`s there starts as a new turn; the session counts as busy for the whole chain.

## Hooks vs the bus

The bus is a synchronous, one-way stream of facts for the renderer, and handler return values mean nothing; hooks are async, run serially in registration order, and their return values matter. What lets features move out of the core into extensions is the hook layer, not the bus. By naming convention hooks use snake_case (`tool_call`) and the bus uses kebab-case (`tool-end`), so the two are distinguishable at a glance in code.

## Renderer

The TUI is [OpenTUI](https://github.com/anomalyco/opentui) + SolidJS, the same pairing as opencode: a native Zig rendering core plus Solid's fine-grained reactivity, running on the alternate screen. `src/ui/kit.tsx` wraps OpenTUI behind an Ink-shaped API (Box / Text / useInput) so the component layer never touches the upstream 0.x API and a breaking change is fixed in kit alone. The TUI module is loaded dynamically on demand: Bun and the single binary run it directly, npm plus Node needs 26.1+, and older Node only affects the TUI.

## Runtime

`-p` and the subcommands run on Node ≥ 22; the TUI needs native FFI - Bun (the single-binary distribution) or Node ≥ 26.1 with `--experimental-ffi` (injected by an automatic re-exec when missing). The single binary is cross-compiled for six platforms with Bun.
