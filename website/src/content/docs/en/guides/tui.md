---
title: TUI
description: Keys, slash commands and pickers in the full-screen interface.
---

```bash
mojocode
```

The TUI runs on the alternate screen (full screen, like vim): the wheel, `PageUp` and `PageDown` scroll back through the timeline, scrolling up pauses follow mode automatically and returning to the bottom resumes it; on exit the whole session is written back to the terminal as plain text, still scrollable and copyable.

## Copying text

Just drag to select; releasing the button copies to the system clipboard (tmux copy-on-select style, with `copied N characters` echoed in the footer; over SSH it arrives through OSC 52, and iTerm2 needs "Applications may access clipboard" enabled in its settings). You can also hold `shift` (`option` on macOS) to drag-select with the terminal's native copying.

## Keys

| Action | Notes |
|---|---|
| type and press enter | ask for something |
| `esc` | interrupt the running task |
| `esc` `esc` (when idle) | open the rewind picker, see below |
| `ctrl+c` twice | quit |
| wheel / `PageUp` / `PageDown` | scroll the timeline. While the wheel is over the command menu, the file menu or a picker it scrolls that list instead, without scrolling the timeline along |
| `ctrl+o` | cycle timeline density: `full` → `compact` → `result` (`/focus` persists it) |
| `ctrl+r` | expand / collapse detail: reasoning bodies and tool output are folded into a single `+ N lines of output` row by default. Diffs and task lists are results and never collapse |
| `ctrl+t` | collapse / expand the live task panel (the todo list) |
| click | a row in the rewind picker or the `/setting` panel is selected with one click. Press and release must land on the same cell for it to count, so drag-copying does not mis-trigger |
| `shift+enter` | newline in the input box (needs a terminal with the kitty keyboard protocol: iTerm2 3.5+ / kitty / WezTerm / Ghostty) |
| `option+enter` / `ctrl+j` / trailing `\` + enter | fallbacks for a newline, available in any terminal |
| `↑` / `↓` | browse input history; inside a multi-line draft they move the cursor |
| type `/` | command menu, `↑`/`↓` to choose, enter to run, `tab` to complete |
| type `!<command>` | run a shell command in the workspace (Pi's shape); the output joins the conversation context without starting a turn - the next question sees it naturally, and an extension's `user_bash` hook can rewrite or take it over |
| type `@` | fuzzy file completion, enter or `tab` inserts the path. Referenced files are attached to the model on submit; images such as `@screenshot.png` are attached as images to models that support vision (png/jpg/gif/webp, ≤ 5MB each) |
| `ctrl+v` | paste an image from the clipboard: an `[image #N]` placeholder appears in the input box and goes out with the message (macOS is the main platform; on Linux `xclip` or `wl-paste` is required) |

An image whose long edge exceeds 1568px is downsampled proportionally, keeping its format; all images are additionally capped at 5MB each and 10MB per message. When the current model cannot take images directly, they degrade to file references and the model calls the `view_image` tool for a text description when it needs to look - see [Vision models](/config/providers/#vision-models).

## Slash commands

Built-in commands come first, extension commands next and skills last; on a name clash the built-in wins. A command with enumerated arguments (`/provider` `/think` `/focus` `/review`) opens a second-level picker when you press enter in the menu; `/models` with no arguments opens a model picker grouped by provider.

| Command | Purpose |
|---|---|
| `/help` | list every command |
| `/init` | analyse the codebase and generate or improve `AGENTS.md` at the project root |
| `/review [scope]` | review git changes and print findings ordered by severity, read-only. See [Review and cleanup](/features/review/) |
| `/simplify [target]` | look for cleanup opportunities in recent changes and apply the fixes. See [Review and cleanup](/features/review/) |
| `/goal [condition\|clear]` | goal mode: give a completion condition and it is checked at the end of every turn, carrying on until it holds. See [Goal mode](/features/goal/) |
| `/models [id]` | switch model. With no argument it opens the grouped picker: type to search, `←`/`→` collapse and expand groups; `/model` is an alias |
| `/provider [id]` | switch provider. With no argument it opens the picker: configured providers switch at once, missing keys are entered and validated in place |
| `/think <level>` | reasoning effort. The available levels depend on the current model, see [Thinking levels](/config/providers/#thinking-levels) |
| `/setting` | settings panel: interface language, status bar items. `↑`/`↓` to select, enter to open, `esc` to go back one level; the status bar is multi-select with space to toggle and enter to apply. Changes take effect at once and are written to the global config |
| `/focus <full\|compact\|result>` | timeline density, persisted. `full` keeps everything, `compact` folds runs of tool calls into "⋯ N tool calls collapsed", `result` shows only questions and answers. Answers, errors and notices are never hidden at any density |
| `/compact` | compact the context manually |
| `/new` | start a new session (keeping the screen contents) |
| `/clear` | clear the screen and start a new session |
| `/resume` | switch to another past session from this workspace |
| `/fork` | fork the conversation into a new session; the original stays frozen at the fork point |
| `/skills` | rescan and list skills |
| `/reload` | reload extensions from disk (built-in extensions stay) |
| `/mcp` | show MCP server status |
| `/doctor [offline]` | checkup against the session's current config; `offline` skips network checks |
| `/cost` | token usage for this session |
| `/exit` | quit; `/quit` is an alias |

## esc esc rewind

Press `esc` twice while idle to open the rewind picker; picking a message truncates the conversation to just before it, the original text returns to the input box, and editing it and sending again starts over from that point as a fork. Rewinding is a real deletion: model history and display history are cut together.

## Footer and status line

The footer has two groups: model, working directory and thinking level on the left, the context usage bar and total tokens on the right. Which segments show is chosen in `/setting`.

The top border of the input box is the working status line: while working it reads `── ⠋ thinking · 12s · esc to interrupt ──`, and when idle it is an ordinary separator. An extension can hang another line of its own above the input box (the `/goal` "goal 3/10" line, for instance); entries carrying a timer tick client-side.
