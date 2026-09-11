---
title: Models and providers
description: Built-in presets, custom OpenAI-compatible endpoints, thinking levels and vision models.
---

mojocode speaks one protocol: OpenAI-compatible chat completions (DeepSeek goes through its dedicated SDK with the same behaviour). Any endpoint offering that interface plugs in.

## Built-in presets

| id | Endpoint | Key env vars | Notes |
|---|---|---|---|
| `kimi` | `api.moonshot.cn/v1` | `MOONSHOT_API_KEY` `KIMI_API_KEY` | Kimi open platform (China), pay as you go |
| `kimi-coding` | `api.kimi.com/coding/v1` | `KIMI_CODE_API_KEY` | Kimi Code subscription, monthly; the key only works on this endpoint |
| `kimi-intl` | `api.moonshot.ai/v1` | `MOONSHOT_API_KEY_INTL` `MOONSHOT_API_KEY` | Kimi open platform (international) |
| `deepseek` | `api.deepseek.com` | `DEEPSEEK_API_KEY` | DeepSeek official |
| `glm` | `open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` `ZHIPUAI_API_KEY` `GLM_API_KEY` | Zhipu open platform |
| `glm-coding` | `open.bigmodel.cn/api/coding/paas/v4` | `ZHIPU_API_KEY` `GLM_API_KEY` | Zhipu Coding Plan |
| `glm-intl` | `api.z.ai/api/paas/v4` | `ZAI_API_KEY` `ZHIPU_API_KEY` | Z.ai international |

A preset's default model is only a starting point - all three vendors iterate fast. `mojocode models --provider <id>` fetches the list your key can actually use, and `/models` in the TUI opens the grouped picker. When the API lags behind (a fresh Coding Plan whose list is missing the newest glm, say), the preset default model is still merged in so it stays selectable.

:::caution[GLM base URL]
The GLM endpoint is `/api/paas/v4` - do **not** append `/v1`, that 404s.
:::

## Custom providers

Any key under `providers` is a provider; for a built-in id write only the fields you want to override:

```json
{
  "providers": {
    "glm": { "apiKey": "...", "model": "GLM-5.3" },
    "local": {
      "baseURL": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "LOCAL_KEY",
      "model": "qwen3-coder",
      "contextWindow": 131072,
      "headers": { "X-Custom": "1" }
    }
  }
}
```

| Field | Notes |
|---|---|
| `baseURL` | endpoint root |
| `apiKey` / `apiKeyEnv` | the key, or the name of an environment variable holding it |
| `model` | default model |
| `headers` | extra request headers |
| `contextWindow` | context window in tokens, used for usage accounting and the compaction threshold |
| `parallelToolCalls` | whether parallel tool calls are allowed |
| `reasoningEffort` | thinking level for this provider, overriding the global one |
| `vision` | explicitly declare whether this provider's models take images directly |
| `label` | the name shown in pickers |
| `models` | a hand-maintained model list, see below |

### Per-model entries

`providers.<id>.models` is an array of `{ id, label?, contextWindow?, maxOutputTokens?, reasoning? }`. Once it is configured the model picker reads it directly (no more probing the `/models` endpoint), `contextWindow` overrides the provider-level value per model, and `maxOutputTokens` is passed straight into the request.

## Thinking levels

`reasoningEffort` has six levels: `auto` (send nothing, leave it to the server default), `off`, `low`, `medium`, `high`, `max`. Three layers override each other: global → `providers.<id>.reasoningEffort` → per-model `models[].reasoning`. Inside a session `/think <level>` sets it and persists the choice.

**Which levels are available depends on the model's capabilities.** mojocode mirrors the [models.dev](https://models.dev) catalog (cached in `~/.mojocode/cache/models-dev.json`, refreshed every 24 hours, falling back to the old copy on failure) and offers the levels the current model really supports; a model the catalog does not cover (local endpoints, an offline first start) falls back to a built-in table by vendor family. `auto` is not in the selectable list - `/think auto` is the only way back to "send nothing".

How a level reaches the request is translated per vendor: GLM-5 and above get a real `reasoning_effort`, GLM-4 only has an on/off switch; Kimi and DeepSeek use the canonical keys of their SDKs.

### Custom thinking parameters

For switches the built-in families cannot express (Qwen's `enable_thinking`, vLLM's `chat_template_kwargs`, a gateway's `reasoning: {...}`), write the per-model `reasoning` as an object: it is merged into the request's providerOptions **as is**, replacing the level mapping entirely:

```json
{ "id": "qwen3-coder", "reasoning": { "enable_thinking": true, "thinking_budget": 4096 } }
```

With the object form, levels and `/think` no longer apply to that model. DeepSeek's dedicated SDK only passes canonical keys through; arbitrary fields are dropped for that one vendor.

## Vision models

Images pasted or referenced with `@` go straight to models that support vision. When the current model cannot take images, they degrade to file references (an `@` image keeps its path, a pasted one lands in `~/.mojocode/images/`), and the model calls the `view_image` tool for a text description when it needs to look. That tool uses the model named by `visionModel` (same provider as the session; `glm-4.6v` in the GLM presets) and can be overridden with `MOJOCODE_VISION_MODEL`. Without a vision model configured the tool is not registered and `doctor` points it out.

Deciding whether images can be sent directly: built-in providers follow the preset's model table (DeepSeek has an explicitly empty table - its SDK would silently drop images); a custom provider is unknown, so images are sent optimistically and the server error is visible - turn it off with `providers.<id>.vision: false`. The same key corrects a preset's wrong answer.
