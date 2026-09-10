---
title: 联网搜索
description: web_search 与 web_fetch 两个工具,以及搜索后端的配置。
---

`web` 扩展提供两个工具:`web_fetch`(抓网页转 Markdown)零依赖随时可用;`web_search` 需要一个搜索后端的 key,没有就不注册,模型不会看到这个工具。两者都是只读的,explore 子 agent 也能用。

| 后端 | 端点 | key 环境变量 | 成本 |
|---|---|---|---|
| `glm` | 智谱独立搜索 API | `ZHIPU_API_KEY`(与 GLM 大模型同一把) | search_std 约 ¥0.01/次 |
| `exa` | api.exa.ai | `EXA_API_KEY` | 免费 20k 次/月 |
| `custom` | `search.baseURL` | `search.apiKey` 或 `search.apiKeyEnv` | 自定 |

默认 `search.backend: "auto"`:按 glm → exa 的顺序取第一个能从**预设环境变量**拿到 key 的后端。用 GLM 当大模型的用户零配置即可搜索。

:::note[auto 刻意忽略专用 key]
`auto` 不看 `search.apiKey` 与 `MOJOCODE_SEARCH_API_KEY`:一把不知道属于谁的 key 拿去打错端点只会得到费解的 401。专用 key 必须配显式 backend。`"off"` 显式关闭。
:::

`search` 节的其余键:`engine`(GLM 档位,`search_std` / `search_pro` 等)、`count`(默认返回条数,1 到 20)、`baseURL`(覆盖端点;`custom` 必填,请求与响应契约与 GLM 的 `/paas/v4/web_search` 相同)。命令行 `--search-backend <id>`,环境变量 `MOJOCODE_SEARCH_BACKEND`。

`mojocode doctor` 有独立的「联网搜索」分节:后端解析、key 来源、端点连通(探测发一次最小真实请求,GLM 计费约 ¥0.01)。

## 零成本替代:免费搜索 MCP

不想为搜索配任何 key,可以接一个免费的 DuckDuckGo MCP server:

```json
{
  "mcpServers": {
    "ddg": { "type": "stdio", "command": "npx", "args": ["-y", "duckduckgo-mcp-server"] }
  }
}
```

## 代理

Node 的原生 fetch 不读 `HTTP_PROXY` / `HTTPS_PROXY`。需要走代理访问 Exa 时,可设 `NODE_USE_ENV_PROXY=1`(Node 24+),或直接换 `glm` 后端(国内直连)。
