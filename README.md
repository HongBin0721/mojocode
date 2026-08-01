# kdg

一个运行在终端里的编程 agent，支持 **Kimi**、**DeepSeek**、**GLM** 三家大模型。

全屏 TUI 交互、真实的文件/shell/搜索工具、所有改动前置权限确认、会话持久化与上下文自动压缩、MCP 扩展支持。

---

## 一、完整流程：从安装到第一次使用

### 0. 环境要求

| 依赖 | 要求 | 检查方式 |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| npm | 随 Node 附带 | `npm -v` |
| ripgrep（可选） | 有则代码搜索快 10~100 倍，没有自动降级 | `rg --version`，安装：`brew install ripgrep` |

### 1. 安装

```bash
cd agent_dev        # 项目目录
npm install         # 安装依赖
npm run build       # 打包到 dist/
npm link            # 把 kdg 命令挂到 PATH
```

验证安装：

```bash
kdg --version       # 输出 0.1.0 即成功
```

> 卸载：`npm unlink -g kdg`。

### 2. 配置 API 密钥（三选一即可）

**方式 A：交互式向导（推荐）**

```bash
kdg auth            # 别名：kdg login
```

流程：↑/↓ 选服务商 → 粘贴密钥（掩码显示，界面上有各平台申请密钥的网址）→
自动调用该平台 `/models` 接口验证 → 保存到 `~/.kdg/config.json`（文件权限 0600）→
可选设为默认服务商 → 可继续配置下一家。

没配置任何密钥时直接运行 `kdg` 也会自动进入这个向导。

**方式 B：环境变量**（共用机器上更安全，写进 `~/.zshrc`）：

```bash
export DEEPSEEK_API_KEY=sk-...      # DeepSeek:      platform.deepseek.com
export MOONSHOT_API_KEY=sk-...      # Kimi 开放平台:  platform.moonshot.cn（按量付费）
export KIMI_CODE_API_KEY=sk-kimi-.. # Kimi Code 订阅: kimi.com/code（包月，密钥仅限 api.kimi.com）
export ZHIPU_API_KEY=...            # GLM:           open.bigmodel.cn
```

> Kimi 有两套产品：开放平台（`kimi` 预设，api.moonshot.cn，按量付费）和
> Kimi Code 订阅（`kimi-coding` 预设，api.kimi.com/coding/v1，包月）。
> 两边密钥互不通用，按你买的是哪种选对应预设。

**方式 C：直接写配置文件** `~/.kdg/config.json`：

```json
{ "providers": { "glm": { "apiKey": "..." } } }
```

### 3. 验证连通

```bash
kdg providers                  # 列出内置服务商，✓ 表示密钥已就位
kdg models --provider glm      # 拉取你的密钥实际可用的模型列表
```

### 4. 开始使用

```bash
cd ~/你的项目
kdg                            # 进入全屏 TUI，直接打字提需求
```

第一次建议在不重要的目录跑一圈，感受默认 `ask` 模式的权限确认节奏。

---

## 二、日常使用

### 交互模式（TUI）

```bash
kdg
```

| 操作 | 说明 |
|---|---|
| 直接打字回车 | 提需求，agent 自主读代码/改文件/跑命令 |
| `esc` | 中断正在执行的任务 |
| `ctrl+c` 两次 | 退出 |
| `shift+enter` | 输入框内换行（需终端支持 kitty 键盘协议：iTerm2 3.5+ / kitty / WezTerm / Ghostty 等） |
| `option+enter` / `ctrl+j` / 行尾 `\` + 回车 | 换行的兜底按键，任何终端可用 |
| `↑`/`↓` | 翻历史输入；多行草稿内为上下移动光标 |
| 输入 `/` | 弹出命令菜单，`↑`/`↓` 选择、回车执行、`tab` 补全 |
| 命令菜单回车 | 带枚举参数的命令（`/model` `/provider` `/mode` `/lang`）会进入二级选择器 |

**斜杠命令**：

| 命令 | 作用 |
|---|---|
| `/help` | 列出所有命令 |
| `/model <id>` | 切换模型；不带参数列出可用模型 |
| `/provider <id>` | 切换服务商（kimi / deepseek / glm / …） |
| `/mode <模式>` | 切换权限模式 |
| `/lang zh-CN` | 切换界面语言 |
| `/compact` | 手动压缩上下文 |
| `/clear` | 开始新对话 |
| `/resume` | 切换到本目录的另一个历史会话（二级选择器选取） |
| `/mcp` | 查看 MCP 服务器状态 |
| `/cost` | 查看本次会话 token 用量 |

**esc esc 回退**：空闲时连按两次 `esc` 打开回退选择器，选中一条历史消息即把对话截断到它之前，原文回到输入框，编辑后重发——相当于从那一点分叉重来。

**权限确认框**：`y` 允许一次 · `n` 拒绝 · `a` 本会话始终允许 · `A` 永久保存规则到项目配置。

### 非交互模式（脚本 / 管道 / CI）

```bash
kdg -p "找出所有 TODO 注释并汇总"          # 单次执行，结果输出到 stdout
kdg -p "分析这段报错" --provider deepseek  # 指定服务商
kdg -p "..." --json                        # stderr 输出 NDJSON 事件流
cat error.log | kdg -p "分析这个日志"       # 配合管道
```

`-p` 模式下没人可确认，需要授权的操作会被拒绝——脚本场景加 `--accept-edits` 或 `--yolo`。

### 会话管理

```bash
kdg -c                  # 继续本目录最近一次会话（--continue）
kdg -r                  # 交互式选择要恢复的会话（--resume）
kdg -r <id前缀>          # 恢复指定会话；`kdg sessions` 列出的 8 位前缀即可
kdg -r <id前缀> --fork-session   # 载入历史但写入全新会话（原会话不再变动）
kdg sessions            # 列出本目录的历史会话
kdg sessions --all      # 所有目录的
```

恢复会话时会完整回放时间线,并还原当时的模型、权限模式、任务列表与本会话
批准过的规则(CLI 参数可覆盖,如 `--provider`)。会话完整记录(未压缩)保存
在 `~/.kdg/sessions/*.jsonl`,超过 `cleanupPeriodDays`(默认 30 天)未活动的
会话在启动时自动清理。

### 常用启动参数

```bash
kdg --provider kimi -m kimi-k2.6   # 本次指定服务商和模型
kdg --readonly                     # 只读分析，绝不改文件
kdg --accept-edits                 # 文件编辑免确认，shell 命令仍确认
kdg --yolo                         # 全部免确认（谨慎）
kdg --no-mcp                       # 跳过 MCP 连接，启动更快
kdg -C ~/另一个项目                # 指定工作区目录
```

---

## 三、配置

配置文件分两层：`~/.kdg/config.json`（全局）和 `<项目>/.kdg/config.json`（项目级，可提交进仓库）。完整示例：

```json
{
  "provider": "glm",
  "model": "glm-4.6",
  "language": "zh-CN",
  "permissionMode": "ask",
  "permissions": {
    "allowBash": ["Bash(npm test:*)", "Bash(git diff:*)"],
    "allowWrite": ["src/**"]
  },
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

优先级从低到高：内置默认 → 全局配置 → 项目配置 → `KDG_*` 环境变量 → 命令行参数。
`kdg config` 可查看最终生效的配置及来源（密钥自动打码）。

### 界面语言

界面内置英文和简体中文。解析顺序：配置 `language` → `KDG_LANG` → 系统 `LANG`/`LC_ALL`
（任何 `zh*` 都映射到 zh-CN）。运行中可用 `/lang zh-CN` / `/lang en` 即时切换。

回喂给模型的文本（工具报错、拒绝原因）刻意保持英文——那是 prompt 的一部分，
混语言会影响 function calling 质量。语言文件在 `src/i18n/`，有 parity 测试保证
两份目录键位对齐，新增语言只需加一个文件和一个联合类型成员。

### 项目指令

在项目根放 `AGENTS.md`（或 `KDG.md`），内容会注入系统提示，用来声明项目规范
（构建命令、代码风格、禁改目录等）。

---

## 四、权限模型

| 模式 | 文件编辑 | shell 命令 |
|---|---|---|
| `readonly` | 拒绝 | 只放行只读命令 |
| `ask`（默认） | 确认 | 确认（安全只读命令白名单除外） |
| `acceptEdits` | 自动放行 | 确认 |
| `yolo` | 自动放行 | 自动放行 |

对应参数：`--readonly`、`--accept-edits`、`--yolo`；运行中用 `/mode` 切换。

与模式无关、始终生效的硬约束：

- 所有路径经 `realpath` 解析后必须落在工作区内（防 symlink 逃逸）
- `.git/`、`.env*`、密钥文件、SSH 材料永远禁止读写
- 灾难性命令直接拒绝：`rm -rf`、`sudo`、`curl … | sh`、force push、hard reset 等

---

## 五、架构

核心原则：agent core 不 import React。core 通过事件总线发事件、通过回调等待授权决定，
同一套循环同时驱动 TUI 和 headless 渲染器。

```
src/
  config/      分层配置、服务商预设、密钥保存
  model/       AI SDK 模型构造、实时 /models 列表
  agent/       streamText 循环、系统提示、上下文压缩
  tools/       read write edit glob grep bash todo
  permissions/ sandbox（路径）、bash-rules（命令）、gate（策略）
  mcp/         MCP 客户端 + AI SDK 工具桥接
  session/     追加式 JSONL 会话记录
  core/        事件总线契约
  i18n/        语言目录（en / zh-CN）
  ui/          Ink 组件（含 AuthWizard 密钥向导）
```

容易踩的坑（都已处理，改代码时注意别退化）：

- **GLM 的 baseURL 是 `/api/paas/v4`**，绝不能再拼 `/v1`，否则 404。
- **模型 ID 一律不硬编码。** 三家迭代都快，预设只是起始默认值，`kdg models` 看实时列表。
- **已完成的时间线条目放在 Ink 的 `<Static>` 里**，只渲染一次进终端回滚缓冲区，
  长会话不卡顿、滚动回看正常。
- **历史用 `result.responseMessages`**，不是 `result.response.messages`——
  后者只含最后一步，会悄悄丢掉前面的工具调用。

---

## 六、开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest：沙箱逃逸、bash 拒绝列表、配置分层、权限门、i18n 对齐、密钥保存
npm run dev         # 监听改动自动重新打包
```

---

## 常见问题

**Q：报 "No API key for provider ..."**
运行 `kdg auth` 配置，或检查环境变量名是否正确（`kdg providers` 会列出每家认哪些变量）。

**Q：GLM 返回 404**
检查 baseURL 是否被改动过——必须是 `https://open.bigmodel.cn/api/paas/v4`，不带 `/v1`。

**Q：`/model` 里没有我想要的模型**
模型列表来自你的密钥实际权限。`kdg models --provider <id>` 确认后用 `/model <id>` 或配置 `model` 字段指定。

**Q：上下文满了怎么办**
超过窗口 80% 会自动压缩成摘要继续；也可随时 `/compact`。磁盘上的会话记录始终是完整的。

**Q：想让某条命令不再每次确认**
确认框按 `a`（本会话）或 `A`（写入项目配置），也可以直接编辑配置里的 `permissions.allowBash`。
