---
title: Quickstart
description: From install to your first conversation.
---

This page takes you from installation to a first useful session.

## Requirements

Runtime requirements depend on how you install:

| Install method | Interactive TUI | `-p` and subcommands |
|---|---|---|
| Single binary | Runtime included, **no Node needed** | same |
| npm / source | Node **≥ 26.1** (the renderer needs native FFI; `--experimental-ffi` is injected automatically) | Node **≥ 22** |

The two floors differ: `node >= 22` is the hard minimum for the whole CLI, and being able to install only guarantees `-p` and subcommands run; the TUI additionally needs the native FFI that arrived in 26.1. On Node 22 to 25, running `mojocode` does not crash but prints a one-line hint to install the binary or upgrade Node; `-p` keeps working.

Optional: with [ripgrep](https://github.com/BurntSushi/ripgrep) installed, code search is 10 to 100 times faster; without it mojocode falls back silently (`brew install ripgrep`).

## Install

### Option A: single binary (recommended)

Runtime included, starts about 4x faster than the Node build. One line on macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/HongBin0721/mojocode/main/install.sh | sh
```

Installs to `~/.local/bin/mojocode`. The script detects the platform, picks the musl build on Alpine, and verifies against `SHA256SUMS` before writing anything. Two environment variables tune it:

| Variable | Purpose |
|---|---|
| `MOJOCODE_INSTALL_DIR` | Install directory, default `~/.local/bin` |
| `MOJOCODE_VERSION` | Pin a version such as `v0.6.0`, default latest |

On Windows, download `mojocode-windows-x64.zip` from the [Releases](https://github.com/HongBin0721/mojocode/releases) page and unzip it.

Uninstall: delete `~/.local/bin/mojocode`; config and sessions live in `~/.mojocode/` and can go too.

### Option B: npm global install

```bash
npm install -g mojocode
```

npm ships only the JS build, not the renderer runtime: the interactive TUI needs local Node ≥ 26.1. On Node 22 to 25 only `mojocode -p` and the subcommands are available (enough for CI and scripts). For the TUI on older Node, use option A.

Uninstall: `npm uninstall -g mojocode`.

### Option C: from source

```bash
git clone https://github.com/HongBin0721/mojocode.git
cd mojocode
npm install
npm run build       # bundles to dist/
npm link            # puts the mojocode command on PATH
```

Verify:

```bash
mojocode --version
```

## Configure an API key

Pick any one of the three.

### Interactive wizard (recommended)

```bash
mojocode auth            # alias: mojocode login
```

Flow: pick a provider with ↑/↓ → paste the key (masked; the screen shows where to get one for each platform) → the key is validated against that platform's `/models` endpoint → saved to `~/.mojocode/config.json` (mode 0600) → optionally set as default → configure another provider if you like.

Running `mojocode` with no key configured drops you into this wizard automatically.

### Environment variables

Safer on shared machines; put them in `~/.zshrc`:

```bash
export DEEPSEEK_API_KEY=sk-...      # DeepSeek:            platform.deepseek.com
export MOONSHOT_API_KEY=sk-...      # Kimi open platform:  platform.moonshot.cn (pay as you go)
export KIMI_CODE_API_KEY=sk-kimi-.. # Kimi Code plan:      kimi.com/code (subscription)
export ZHIPU_API_KEY=...            # GLM:                 open.bigmodel.cn
```

:::note[Kimi has two products]
The open platform (`kimi` preset, api.moonshot.cn, pay as you go) and the Kimi Code subscription (`kimi-coding` preset, api.kimi.com/coding/v1, monthly). Keys are not interchangeable; pick the preset matching what you bought. All presets are listed under [Models and providers](/config/providers/).
:::

### Write the config file directly

`~/.mojocode/config.json`:

```json
{ "providers": { "glm": { "apiKey": "..." } } }
```

## Verify connectivity

```bash
mojocode doctor                     # one-shot checkup: environment, config, keys, endpoints, MCP, session store
mojocode providers                  # list built-in providers; ✓ means a key is in place
mojocode models --provider glm      # fetch the models your key can actually use
```

`doctor` is the first stop for troubleshooting: every item is marked ✓ / ! / ✗, failing items come with a fix command, and keys are shown masked. It exits 1 when anything fails, so it can gate CI.

```bash
mojocode doctor --offline           # skip network checks
mojocode doctor --json              # structured output with stable ids
mojocode doctor -C ~/some-project   # check a specific workspace
```

## First conversation

```bash
cd ~/your-project
mojocode
```

Type your request in the full-screen TUI; the agent reads code, edits files and runs commands on its own. Keys you will need right away:

| Key | Action |
|---|---|
| `esc` | Interrupt the running task |
| `ctrl+c` twice | Quit (the timeline is written back to the terminal as plain text) |
| type `/` | Command menu |
| type `@` | Fuzzy file completion; referenced files are attached to the model on submit |

:::caution[No permission prompts]
mojocode has no permission system: tools can touch anything the process can, and `bash` runs commands directly. Try it first in a throwaway directory or a disposable working copy. See [No permission system](/features/permissions/) for the reasoning and how to intercept.
:::

Next: [TUI](/guides/tui/) for every command and shortcut, or jump to [Configuration](/config/overview/).
