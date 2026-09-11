---
title: Web search
description: The web_search and web_fetch tools and how the search backend is configured.
---

The `web` extension provides two tools: `web_fetch` (fetch a page and turn it into Markdown) works out of the box with zero dependencies; `web_search` needs a key for a search backend and is simply not registered without one, so the model never sees the tool. Both are read-only and available to explore subagents too.

| Backend | Endpoint | Key env var | Cost |
|---|---|---|---|
| `glm` | Zhipu's standalone search API | `ZHIPU_API_KEY` (the same one as the GLM model) | search_std about ¥0.01 per call |
| `exa` | api.exa.ai | `EXA_API_KEY` | 20k calls/month free |
| `custom` | `search.baseURL` | `search.apiKey` or `search.apiKeyEnv` | yours |

Default `search.backend: "auto"`: tries glm then exa and takes the first backend whose key is available from **preset environment variables**. Users running GLM as their model get search with zero configuration.

:::note[auto deliberately ignores dedicated keys]
`auto` does not look at `search.apiKey` or `MOJOCODE_SEARCH_API_KEY`: firing a key whose owner is unknown at the wrong endpoint only yields a puzzling 401. A dedicated key requires an explicit backend. `"off"` disables search explicitly.
:::

The other keys in the `search` section: `engine` (the GLM flavour, `search_std` / `search_pro` and so on), `count` (default number of results, 1 to 20), `baseURL` (override the endpoint; required for `custom`, whose request and response contract match GLM's `/paas/v4/web_search`). Command line `--search-backend <id>`, environment variable `MOJOCODE_SEARCH_BACKEND`.

`mojocode doctor` has a dedicated "Web search" section: backend resolution, key origin, endpoint connectivity (the probe sends one minimal real request - about ¥0.01 on GLM).

## Zero-cost alternative: a free search MCP

If you would rather not configure any key for search, plug in a free DuckDuckGo MCP server:

```json
{
  "mcpServers": {
    "ddg": { "type": "stdio", "command": "npx", "args": ["-y", "duckduckgo-mcp-server"] }
  }
}
```

## Proxies

Node's native fetch does not read `HTTP_PROXY` / `HTTPS_PROXY`. To reach Exa through a proxy, set `NODE_USE_ENV_PROXY=1` (Node 24+), or just switch to the `glm` backend (direct from China).
