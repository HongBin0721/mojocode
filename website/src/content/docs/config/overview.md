---
title: 配置总览
description: 分层配置、优先级与全部字段。
---

配置文件分两层:`~/.mojocode/config.json`(全局)和 `<项目>/.mojocode/config.json`(项目级,可提交进仓库)。优先级从低到高:

```
内置默认 → 全局配置 → 项目配置 → MOJOCODE_* 环境变量 → 命令行参数
```

`mojocode config` 显示最终生效的配置及每个值的来源,密钥自动打码。两层按键深合并:`providers`、`mcpServers`、`lsp.servers` 按 id 合并,`packages` 取并集,其余后者覆盖前者。项目层只写你要覆盖的键,没写的键不会被「幻影默认值」重置。

## 完整示例

```json
{
  "provider": "glm",
  "model": "GLM-5.3",
  "language": "zh-CN",
  "reasoningEffort": "medium",
  "providers": {
    "glm": { "apiKey": "..." },
    "local": {
      "baseURL": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "LOCAL_KEY",
      "model": "qwen3-coder",
      "contextWindow": 131072,
      "models": [
        { "id": "qwen3-coder", "contextWindow": 131072, "reasoning": { "enable_thinking": true } }
      ]
    }
  },
  "search": { "backend": "glm" },
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  },
  "lsp": { "timeoutMs": 3000 },
  "packages": ["npm:@someone/mojocode-ext"]
}
```

## 顶层字段

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `deepseek` | 当前激活的服务商 id:内置预设或 `providers` 里的键 |
| `model` | 预设默认模型 | 覆盖当前服务商的默认模型 |
| `providers` | `{}` | 服务商条目,见[模型与服务商](/config/providers/) |
| `packages` | `[]` | `mojocode install` 记下的扩展包,两层取并集 |
| `mcpServers` | `{}` | MCP 服务器,见 [MCP](/config/mcp/) |
| `search` | `{ backend: "auto" }` | 联网搜索,见[联网搜索](/config/search/) |
| `lsp` | `{ enabled: true, timeoutMs: 3000 }` | LSP 诊断回喂,见 [LSP 诊断](/config/lsp/) |
| `maxSteps` | 不设 | 每轮 agent 步数硬上限,撞上截停并提示续发消息 |
| `taskMaxSteps` | `50` | 子 agent 单次任务的步数上限;显式设了 `maxSteps` 则沿用它 |
| `taskModel` | 会话当前模型 | 子 agent 用的模型 id,与会话同一服务商 |
| `goalModel` | 会话当前模型 | `/goal` 评估器用的模型 id |
| `goalMaxTurns` | `10` | 一个目标最多自动续跑多少轮,上限 100 |
| `visionModel` | 预设(GLM 系为 `glm-4.6v`) | `view_image` 读图用的多模态模型 id |
| `temperature` | 不设 | 采样温度 0 到 2 |
| `reasoningEffort` | `auto` | 思考强度全局默认:`auto` `off` `low` `medium` `high` `max`,可被 `providers.<id>.reasoningEffort` 与逐模型 `reasoning` 覆盖 |
| `compactThreshold` | `0.8` | 输入 token 超过窗口的这一比例时压缩历史,0.1 到 0.95 |
| `maxContext` | 不设 | 强制指定上下文窗口,覆盖服务商预设 |
| `systemPromptAppend` | 不设 | 追加到系统提示词末尾的额外指令 |
| `language` | `auto` | 界面语言 `auto` / `en` / `zh-CN` |
| `statusBar` | 全部 | 状态栏显示段:`model` `cwd` `think` `context` `total` `todos`,`/setting` 里调 |
| `theme` | 无 | TUI 主题名,在项目 / 全局 `themes/` 与包带的主题目录里找 `<name>.json`,见[包管理](/extensions/packages/#主题) |
| `timeline` | `full` | 时间线密度 `full` / `compact` / `result`,`/focus` 落盘 |
| `cleanupPeriodDays` | `30` | 会话保留天数,超期未活动的启动时清理 |

旧版本的 `sandbox` / `approval` / `permissions` / `permissionMode` 键与 `statusBar` 里的 `mode` 段已随权限系统一起退役,读到时当作未知键忽略,不会报错。

## 密钥怎么给

三种来源,按 `providers.<id>.apiKey` → `providers.<id>.apiKeyEnv` 指定的变量 → 预设的环境变量列表的顺序取第一个。`mojocode auth` 写的是第一种(文件权限 0600),共用机器上更推荐环境变量。`mojocode providers` 列出每家认哪些变量。
