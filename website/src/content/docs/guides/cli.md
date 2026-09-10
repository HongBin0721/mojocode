---
title: CLI 参考
description: 启动参数与全部子命令。
---

## 启动参数

```bash
mojocode [options]
```

| 参数 | 说明 |
|---|---|
| `-p, --print <prompt>` | 非交互执行一条指令后退出,见[非交互模式](/guides/headless/) |
| `--json` | 配合 `-p`,在 stderr 输出 NDJSON 事件 |
| `--provider <id>` | 使用的服务商(`kimi` `kimi-coding` `kimi-intl` `deepseek` `glm` `glm-coding` `glm-intl`,或配置里自定义的 id) |
| `-m, --model <id>` | 模型 id,覆盖服务商默认值 |
| `-C, --cwd <dir>` | 工作区根目录,默认当前目录 |
| `--max-context <tokens>` | 覆盖上下文窗口大小 |
| `--max-steps <n>` | 每轮对话的最大 agent 步数 |
| `--no-mcp` | 跳过连接 MCP 服务器,启动更快 |
| `-e, --extension <path>` | 加载一个扩展文件或目录,可重复 |
| `--search-backend <id>` | `web_search` 后端:`auto` `glm` `exa` `custom` `off` |
| `-r, --resume [sessionId]` | 按 id 前缀恢复会话,不带参数则交互选择 |
| `-c, --continue` | 恢复本工作区最近的会话 |
| `--fork-session` | 配合 `-c` / `-r`:载入历史但写入全新的会话 id |
| `-V, --version` | 版本号 |

## 子命令

| 命令 | 说明 |
|---|---|
| `mojocode auth`(别名 `login`) | 交互式配置服务商 API key |
| `mojocode models [--provider <id>]` | 列出所配置密钥可访问的模型 |
| `mojocode providers` | 列出内置服务商预设及密钥是否已配置 |
| `mojocode sessions [--all]` | 列出当前工作区已保存的会话;`--all` 含其他工作区 |
| `mojocode config` | 显示生效配置及其来源,密钥自动打码 |
| `mojocode doctor [--json] [--offline] [-C <dir>]` | 体检:安装、配置与服务商连通性。有 ✗ 项时退出码 1 |
| `mojocode install <source> [--local]` | 安装扩展包:`npm:<包名>`、`git:<地址>` 或本地目录 |
| `mojocode remove <name>` | 卸载扩展包 |
| `mojocode extensions` | 列出本工作区会加载的扩展与扩展包 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `DEEPSEEK_API_KEY` `MOONSHOT_API_KEY` `KIMI_CODE_API_KEY` `ZHIPU_API_KEY` … | 各服务商密钥,完整对应表见 `mojocode providers` |
| `MOJOCODE_PROVIDER` / `MOJOCODE_MODEL` | 覆盖配置里的 `provider` / `model` |
| `MOJOCODE_LANG` | 界面语言 `en` / `zh-CN` |
| `MOJOCODE_SEARCH_BACKEND` / `MOJOCODE_SEARCH_API_KEY` | 搜索后端与专用 key,见[联网搜索](/config/search/) |
| `MOJOCODE_GOAL_MODEL` / `MOJOCODE_TASK_MODEL` / `MOJOCODE_VISION_MODEL` | `/goal` 评估器、子 agent、`view_image` 各自用的模型 |
| `MOJOCODE_INSTALL_DIR` / `MOJOCODE_VERSION` | 只给 `install.sh` 用 |

优先级:环境变量高于配置文件,低于命令行参数。完整分层见[配置总览](/config/overview/)。
