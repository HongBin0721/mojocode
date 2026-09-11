---
title: FAQ
description: Troubleshooting and common questions.
---

### It will not start and I do not know where it hangs

`mojocode doctor`. It reports item by item on the Node version, config-file parsing, key origins, whether endpoints are reachable, whether the model id is still in the provider's list, MCP connections, LSP servers and whether the session directory is writable, and gives a fix command for every failing item.

### "No API key for provider ..."

Run `mojocode auth` to configure one, or check that the environment variable name is right. `mojocode providers` lists which variables each provider accepts.

### GLM returns 404

Check whether the base URL was changed; it must be `https://open.bigmodel.cn/api/paas/v4`, with no `/v1`.

### The model I want is not in `/models`

The online API is the source of truth for the model list. When it lags behind, the preset default model is still merged in so it stays selectable. `mojocode models --provider <id>` shows the list your key actually returns; once confirmed, name the model with `/models <id>` or the config's `model` field, or maintain the list by hand under `providers.<id>.models`.

### What happens when the context fills up

Past 80% of the window it is compacted into a summary and the session continues; `/compact` does it on demand. The session record on disk is always complete.

### Can I restrict it to one directory

mojocode does not fence itself in, see [No permission system](/features/permissions/). Run it in a container or a disposable working copy; to intercept inside the process, write a `tool_call` hook extension.

### Running `mojocode` says the Node version is too old, but `-p` works

The TUI needs Node ≥ 26.1 for native FFI, while `-p` and the subcommands only need 22. Install the single binary or upgrade Node, see [Quickstart](/guides/quickstart/#requirements).

### `shift+enter` does not insert a newline

The terminal needs the kitty keyboard protocol (iTerm2 3.5+ / kitty / WezTerm / Ghostty). Fallbacks that work in any terminal: `option+enter`, `ctrl+j`, or a trailing `\` then enter.

### A pasted image was ignored

DeepSeek's official SDK does not support images; they are ignored with a notice. When other models cannot take images directly they degrade to file references, and once `visionModel` is configured the model can call `view_image` to read one, see [Vision models](/config/providers/#vision-models).
