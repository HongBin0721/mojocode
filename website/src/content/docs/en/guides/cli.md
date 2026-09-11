---
title: CLI reference
description: Launch options and every subcommand.
---

## Launch options

```bash
mojocode [options]
```

| Option | Notes |
|---|---|
| `-p, --print <prompt>` | run one instruction non-interactively and exit, see [Headless mode](/guides/headless/) |
| `--json` | with `-p`, emit NDJSON events on stderr |
| `--provider <id>` | provider to use (`kimi` `kimi-coding` `kimi-intl` `deepseek` `glm` `glm-coding` `glm-intl`, or a custom id from the config) |
| `-m, --model <id>` | model id, overriding the provider default |
| `-C, --cwd <dir>` | workspace root directory, defaults to the current directory |
| `--max-context <tokens>` | override the context window size |
| `--max-steps <n>` | maximum agent steps per turn |
| `--no-mcp` | skip connecting MCP servers, faster startup |
| `-e, --extension <path>` | load an extension file or directory, repeatable |
| `--search-backend <id>` | `web_search` backend: `auto` `glm` `exa` `custom` `off` |
| `-r, --resume [sessionId]` | resume a session by id prefix; without an argument, pick interactively |
| `-c, --continue` | resume the most recent session in this workspace |
| `--fork-session` | with `-c` / `-r`: load the history but write a brand-new session id |
| `-V, --version` | version |

## Subcommands

| Command | Notes |
|---|---|
| `mojocode auth` (alias `login`) | configure a provider API key interactively |
| `mojocode models [--provider <id>]` | list the models the configured keys can reach |
| `mojocode providers` | list built-in provider presets and whether a key is configured |
| `mojocode sessions [--all]` | list saved sessions in this workspace; `--all` includes other workspaces |
| `mojocode config` | show the effective config and where each layer came from, keys masked |
| `mojocode doctor [--json] [--offline] [-C <dir>]` | checkup: install, config and provider connectivity. Exit code 1 on any ✗ |
| `mojocode install <source> [--local]` | install an extension package: `npm:<name>`, `git:<url>` or a local directory |
| `mojocode remove <name>` | uninstall an extension package |
| `mojocode extensions` | list the extensions and packages this workspace will load |

## Environment variables

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` `MOONSHOT_API_KEY` `KIMI_CODE_API_KEY` `ZHIPU_API_KEY` … | provider keys; the full mapping is in `mojocode providers` |
| `MOJOCODE_PROVIDER` / `MOJOCODE_MODEL` | override `provider` / `model` from the config |
| `MOJOCODE_LANG` | interface language, `en` / `zh-CN` |
| `MOJOCODE_SEARCH_BACKEND` / `MOJOCODE_SEARCH_API_KEY` | search backend and its dedicated key, see [Web search](/config/search/) |
| `MOJOCODE_GOAL_MODEL` / `MOJOCODE_TASK_MODEL` / `MOJOCODE_VISION_MODEL` | models used by the `/goal` evaluator, subagents and `view_image` respectively |
| `MOJOCODE_INSTALL_DIR` / `MOJOCODE_VERSION` | for `install.sh` only |

Precedence: environment variables beat the config file and lose to command-line options. The full layering is in [Configuration](/config/overview/).
