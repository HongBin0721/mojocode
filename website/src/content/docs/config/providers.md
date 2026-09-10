---
title: 模型与服务商
description: 内置预设、自定义 OpenAI 兼容端点、思考档位与视觉模型。
---

mojocode 只说一种协议:OpenAI 兼容的 chat completions(DeepSeek 走其专用 SDK,行为一致)。任何提供这个接口的端点都能接。

## 内置预设

| id | 端点 | 密钥环境变量 | 说明 |
|---|---|---|---|
| `kimi` | `api.moonshot.cn/v1` | `MOONSHOT_API_KEY` `KIMI_API_KEY` | Kimi 开放平台(国内),按量付费 |
| `kimi-coding` | `api.kimi.com/coding/v1` | `KIMI_CODE_API_KEY` | Kimi Code 订阅,包月,密钥仅限此端点 |
| `kimi-intl` | `api.moonshot.ai/v1` | `MOONSHOT_API_KEY_INTL` `MOONSHOT_API_KEY` | Kimi 开放平台(国际) |
| `deepseek` | `api.deepseek.com` | `DEEPSEEK_API_KEY` | DeepSeek 官方 |
| `glm` | `open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` `ZHIPUAI_API_KEY` `GLM_API_KEY` | 智谱开放平台 |
| `glm-coding` | `open.bigmodel.cn/api/coding/paas/v4` | `ZHIPU_API_KEY` `GLM_API_KEY` | 智谱 Coding Plan |
| `glm-intl` | `api.z.ai/api/paas/v4` | `ZAI_API_KEY` `ZHIPU_API_KEY` | Z.ai 国际 |

预设里的默认模型只是起点,三家迭代都快。`mojocode models --provider <id>` 拉取你的密钥实际可用的列表,TUI 里 `/models` 打开分组选择器。接口滞后时(如 Coding Plan 初期列表里没有最新的 glm),预设默认模型仍会并入保证可选。

:::caution[GLM 的 baseURL]
GLM 的端点是 `/api/paas/v4`,**不要**在后面再拼 `/v1`,否则 404。
:::

## 自定义服务商

`providers` 里任意键都是一个服务商;内置 id 只需写要覆盖的字段:

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

| 字段 | 说明 |
|---|---|
| `baseURL` | 端点根 |
| `apiKey` / `apiKeyEnv` | 密钥,或读取密钥的环境变量名 |
| `model` | 默认模型 |
| `headers` | 附加请求头 |
| `contextWindow` | 上下文窗口(token),供用量计量与压缩阈值 |
| `parallelToolCalls` | 是否允许并行工具调用 |
| `reasoningEffort` | 该服务商的思考档位,覆盖全局 |
| `vision` | 显式声明该服务商的模型能否直接收图 |
| `label` | 选择器里显示的名字 |
| `models` | 逐条维护的模型列表,见下 |

### 逐模型条目

`providers.<id>.models` 是一个数组,每项 `{ id, label?, contextWindow?, maxOutputTokens?, reasoning? }`。配置了它之后模型选择器直接读它(不再探测 `/models` 端点),`contextWindow` 按模型覆盖服务商级的值,`maxOutputTokens` 直接传给请求。桌面 GUI 的模型设置维护的就是这张表。

## 思考档位

`reasoningEffort` 六档:`auto`(不发任何思考参数,交给服务端默认)、`off`、`low`、`medium`、`high`、`max`。三层覆盖:全局 → `providers.<id>.reasoningEffort` → 逐模型 `models[].reasoning`。会话内用 `/think <档位>` 调整并落盘。

**哪些档位可选由模型能力决定。** mojocode 镜像了 [models.dev](https://models.dev) 的目录(缓存在 `~/.mojocode/cache/models-dev.json`,24 小时刷新,失败沿用旧的),按当前模型给出它真正支持的档位;目录没覆盖的模型(本地端点、离线首启)回退到按厂商家族的内置表。`auto` 不在可选列表里,`/think auto` 是唯一回到「什么都不发」的方式。

档位怎么落到请求上按厂商翻译:GLM-5 及以上发真实的 `reasoning_effort`,GLM-4 只有开关;Kimi、DeepSeek 各按其 SDK 的规范键。

### 自定义思考参数

内置家族表达不了的开关(Qwen `enable_thinking`、vLLM `chat_template_kwargs`、代理网关的 `reasoning: {...}`),把逐模型 `reasoning` 写成对象,它会**原样**并入请求的 providerOptions,完全替代档位映射:

```json
{ "id": "qwen3-coder", "reasoning": { "enable_thinking": true, "thinking_budget": 4096 } }
```

选了对象形态,档位与 `/think` 对该模型不再生效。DeepSeek 的专用 SDK 只透传规范键,任意字段在那一家会被丢弃。

## 视觉模型

粘贴或 `@` 引用的图片直接发给支持视觉的模型。当前模型不能收图时,图片降级为文件引用(`@` 图沿用原路径,粘贴图落到 `~/.mojocode/images/`),模型需要看图时调 `view_image` 工具换取文字描述,该工具用 `visionModel` 指定的模型(与会话同一服务商;GLM 系预设 `glm-4.6v`),也可用 `MOJOCODE_VISION_MODEL` 覆盖。未配置视觉模型时工具不注册,`doctor` 会提示。

判定「能不能直接收图」:内置服务商按预设的模型表(DeepSeek 为显式空表,其 SDK 会静默丢弃图片);自定义服务商一无所知,乐观直发,服务端报错可见,可用 `providers.<id>.vision: false` 关掉;预设判错时同样用这个键纠偏。
