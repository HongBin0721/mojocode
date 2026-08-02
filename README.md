# mojocode

一个运行在终端里的通用编程 agent，可接入任意大模型——内置 **Kimi**、**DeepSeek**、**GLM** 预设，也支持任何 OpenAI 兼容接口。

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
npm link            # 把 mojocode 命令挂到 PATH
```

验证安装：

```bash
mojocode --version       # 输出 0.1.0 即成功
```

> 卸载：`npm unlink -g mojocode`。

### 2. 配置 API 密钥（三选一即可）

**方式 A：交互式向导（推荐）**

```bash
mojocode auth            # 别名：mojocode login
```

流程：↑/↓ 选服务商 → 粘贴密钥（掩码显示，界面上有各平台申请密钥的网址）→
自动调用该平台 `/models` 接口验证 → 保存到 `~/.mojocode/config.json`（文件权限 0600）→
可选设为默认服务商 → 可继续配置下一家。

没配置任何密钥时直接运行 `mojocode` 也会自动进入这个向导。

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

**方式 C：直接写配置文件** `~/.mojocode/config.json`：

```json
{ "providers": { "glm": { "apiKey": "..." } } }
```

### 3. 验证连通

```bash
mojocode providers                  # 列出内置服务商，✓ 表示密钥已就位
mojocode models --provider glm      # 拉取你的密钥实际可用的模型列表
```

### 4. 开始使用

```bash
cd ~/你的项目
mojocode                            # 进入全屏 TUI，直接打字提需求
```

第一次建议在不重要的目录跑一圈，感受默认 `ask` 模式的权限确认节奏。

---

## 二、日常使用

### 交互模式（TUI）

```bash
mojocode
```

| 操作 | 说明 |
|---|---|
| 直接打字回车 | 提需求，agent 自主读代码/改文件/跑命令 |
| `esc` | 中断正在执行的任务 |
| `ctrl+c` 两次 | 退出 |
| `shift+tab` | 循环切权限档位：`ask` → `auto` → `plan`（仅本会话，不落盘） |
| `shift+enter` | 输入框内换行（需终端支持 kitty 键盘协议：iTerm2 3.5+ / kitty / WezTerm / Ghostty 等） |
| `option+enter` / `ctrl+j` / 行尾 `\` + 回车 | 换行的兜底按键，任何终端可用 |
| `↑`/`↓` | 翻历史输入；多行草稿内为上下移动光标 |
| 输入 `/` | 弹出命令菜单，`↑`/`↓` 选择、回车执行、`tab` 补全 |
| 命令菜单回车 | 带枚举参数的命令（`/model` `/provider` `/approvals` `/lang`）会进入二级选择器 |

**斜杠命令**：

| 命令 | 作用 |
|---|---|
| `/help` | 列出所有命令 |
| `/init` | 分析代码库并生成/改进项目根目录的 AGENTS.md（会注入后续会话的系统提示词） |
| `/plan [任务]` | 进入计划模式：只读调研、产出方案交你批准，批准后自动开工。带参数则顺带以该任务开跑 |
| `/model <id>` | 切换模型；不带参数列出可用模型 |
| `/provider <id>` | 切换服务商（kimi / deepseek / glm / …） |
| `/approvals <预设>` | 切换沙箱与确认策略预设 |
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
mojocode -p "找出所有 TODO 注释并汇总"          # 单次执行，结果输出到 stdout
mojocode -p "分析这段报错" --provider deepseek  # 指定服务商
mojocode -p "..." --json                        # stderr 输出 NDJSON 事件流
cat error.log | mojocode -p "分析这个日志"       # 配合管道
mojocode -p "/init" --full-auto                 # 生成 AGENTS.md
```

`-p` 模式下没人可确认，需要授权的操作会被拒绝——脚本场景加 `--full-auto` 或 `--dangerously-bypass-approvals-and-sandbox`。

### 会话管理

```bash
mojocode -c                  # 继续本目录最近一次会话（--continue）
mojocode -r                  # 交互式选择要恢复的会话（--resume）
mojocode -r <id前缀>          # 恢复指定会话；`mojocode sessions` 列出的 8 位前缀即可
mojocode -r <id前缀> --fork-session   # 载入历史但写入全新会话（原会话不再变动）
mojocode sessions            # 列出本目录的历史会话
mojocode sessions --all      # 所有目录的
```

恢复会话时会完整回放时间线,并还原当时的模型、两轴权限、任务列表与本会话
批准过的规则(CLI 参数可覆盖,如 `--provider`)。会话完整记录(未压缩)保存
在 `~/.mojocode/sessions/*.jsonl`,超过 `cleanupPeriodDays`(默认 30 天)未活动的
会话在启动时自动清理。

### 常用启动参数

```bash
mojocode --provider kimi -m kimi-k2.6   # 本次指定服务商和模型
mojocode -s read-only                   # 只读沙箱，写入逐次升级确认
mojocode --plan                         # 计划模式启动：先给方案，批准后再动手
mojocode --full-auto                    # auto 预设：编辑免确认，命令仍确认
mojocode --dangerously-bypass-approvals-and-sandbox   # 全部免确认（谨慎）
mojocode --no-mcp                       # 跳过 MCP 连接，启动更快
mojocode -C ~/另一个项目                # 指定工作区目录
```

---

## 三、配置

配置文件分两层：`~/.mojocode/config.json`（全局）和 `<项目>/.mojocode/config.json`（项目级，可提交进仓库）。完整示例：

```json
{
  "provider": "glm",
  "model": "glm-4.6",
  "language": "zh-CN",
  "sandbox": "workspace-write",
  "approval": "untrusted",
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

优先级从低到高：内置默认 → 全局配置 → 项目配置 → `MOJOCODE_*` 环境变量 → 命令行参数。
`mojocode config` 可查看最终生效的配置及来源（密钥自动打码）。

### 界面语言

界面内置英文和简体中文。解析顺序：配置 `language` → `MOJOCODE_LANG` → 系统 `LANG`/`LC_ALL`
（任何 `zh*` 都映射到 zh-CN）。运行中可用 `/lang zh-CN` / `/lang en` 即时切换。

回喂给模型的文本（工具报错、拒绝原因）刻意保持英文——那是 prompt 的一部分，
混语言会影响 function calling 质量。语言文件在 `src/i18n/`，有 parity 测试保证
两份目录键位对齐，新增语言只需加一个文件和一个联合类型成员。

### 项目指令

在项目根放 `AGENTS.md`（或 `MOJOCODE.md`），内容会注入系统提示，用来声明项目规范
（构建命令、代码风格、禁改目录等）。

---

## 四、权限模型

权限是两根正交的轴，对齐 Codex：

- **sandbox**（能做什么）：`read-only` / `workspace-write` / `danger-full-access`
- **approval**（什么时候问）：`untrusted` / `on-request` / `never`

平时不用直接摆弄两根轴，`/approvals` 提供四档预设：

| 预设 | = sandbox + approval | 文件编辑 | shell 命令 |
|---|---|---|---|
| `read-only` | read-only + on-request | 逐次升级确认 | 只读白名单放行，其余升级确认 |
| `ask`（默认） | workspace-write + untrusted | 确认 | 确认（白名单除外） |
| `auto` | workspace-write + on-request | 自动放行 | 确认（白名单除外） |
| `full-access` | danger-full-access + never | 自动放行 | 自动放行，含硬拒名单 |

配置写 `sandbox` / `approval` 两个键（自由组合也行，比如 `read-only`+`never` 表示
「彻底只读、连问都别问」）；启动参数 `-s/--sandbox`、`-a/--ask-for-approval`，快捷方式
`--full-auto`（= auto）与 `--dangerously-bypass-approvals-and-sandbox`（= full-access）。
环境变量 `MOJOCODE_SANDBOX` / `MOJOCODE_APPROVAL`。旧的单轴 `permissionMode`（配置、
环境变量、会话记录里的）启动时自动映射到两轴并提示一次。

命令白名单分两级：纯只读命令（`ls`/`grep`/`git status` 等）任何环境免确认；
**执行项目自带代码**的命令（`npm test`/`npm run`/各家测试运行器）只在可写沙箱下免确认——
package.json 的脚本可以写文件连网，「只读」的承诺不能取决于仓库自觉，所以 `read-only`
沙箱与计划模式下这类命令（以及可写语境下授权的 allow 规则）一律回到逐次确认。
`find -exec`、`fd -x`、`git branch <名字>`、`git remote add` 这类「前缀只读、参数写盘」
的形态同样不免检。

**与 Codex 的一处刻意差异**：Codex 的 sandbox 是 OS 内核强制（Seatbelt/Landlock），
命令真的跑在沙箱里，所以 workspace-write 下任意命令都能放行。mojocode 的约束在权限门
这一层，无法把一条 bash 命令圈在工作区里，所以 workspace-write 下非白名单命令仍视为
「沙箱外」（要确认，`never` 下直接拒）；Codex 的 `on-failure` 策略也因此不存在。

运行中 `shift+tab` 在 `ask` → `auto` → `plan` 之间循环。循环里刻意不含 `full-access`：
它绕过硬拒名单，绝不能离一个快捷键只有一步之遥。当前档位在循环外（read-only、
full-access、自由组合）时，按下落到 `plan`——它写不了任何东西，误触只可能收紧权限。
`shift+tab` 的切换只在本会话生效，不写配置文件（`/approvals` 才落盘）。

`full-access` 只在本次会话有效，既不写进 `.mojocode/config.json` 也不写进会话记录：
它是「就这一次」的临时逃生口。计划模式同理（见下）。

### 计划模式

`plan` 不在轴上——它是协作方式，激活时压过两轴（等同只读且不可升级），出口是方案获批：

1. `/plan` 或 `/plan <任务>` 进入（也可以 `mojocode --plan` 直接启动）。
2. 模型只读调研——`read`/`glob`/`grep` 与白名单只读命令照常，写入一律被拒，
   拒绝理由会引导它去提交方案而不是叫你重启。
3. 调研完模型调用 `exit_plan` 工具呈交 Markdown 方案，界面弹出批准框。
4. 选「同意」→ 自动还原进入 `/plan` 之前的两轴组合，**同一轮内**接着落地实现；
   选「不同意，继续完善方案」→ 留在计划模式，模型据反馈修订后重新提交。

`exit_plan` 是离开计划模式的唯一出口：即使模型认为「不需要改代码」，也要通过它把这个
结论交给你，而不是自己认定后直接作答收尾。万一它没这么做，时间线会明确提示「本轮没有
提交方案」——门禁保证了那一轮什么都没改，但「我用了 /plan 它却没问我」必须看得见。

批准后忠实还原进入 `/plan` 之前的组合：进入前是 `full-access`，批准后就回到
`full-access`，后续不再有任何确认。唯一的例外是 `read-only`+`never`——那套组合批准
不了任何写入，「批准」就没有意义了，所以提升到 `ask`（且这次提升只在本会话有效）。
`read-only`+`on-request` 忠实还原：实现阶段的每次写入走升级确认。

非交互场景（`mojocode --plan -p "…"`）没有人可以批准，`exit_plan` 会被自动拒绝
并告知模型「把方案作为最终答复输出即可」——即 `--plan -p` 的语义就是「只要方案，
别动手」。

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
- **模型 ID 一律不硬编码。** 三家迭代都快，预设只是起始默认值，`mojocode models` 看实时列表。
- **已完成的时间线条目放在 Ink 的 `<Static>` 里**，只渲染一次进终端回滚缓冲区，
  长会话不卡顿、滚动回看正常。
- **历史用 `result.responseMessages`**，不是 `result.response.messages`——
  后者只含最后一步，会悄悄丢掉前面的工具调用。
- **动态区（流式预览、进行中的工具行）的文本必须留折行安全边距、按显示宽度截断**
  （`App.tsx` 的 `WIDTH_SAFETY`、`theme.ts` 的 `truncateWidth`）。string-width 与
  终端对个别字符（emoji、CJK 标点）的宽度判定有 ±1 列分歧，顶满最后一列的行会被
  终端自动折行，Ink 的擦除记账随之逐帧向下漂移，在回滚区留下成片空白。

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
运行 `mojocode auth` 配置，或检查环境变量名是否正确（`mojocode providers` 会列出每家认哪些变量）。

**Q：GLM 返回 404**
检查 baseURL 是否被改动过——必须是 `https://open.bigmodel.cn/api/paas/v4`，不带 `/v1`。

**Q：`/model` 里没有我想要的模型**
模型列表来自你的密钥实际权限。`mojocode models --provider <id>` 确认后用 `/model <id>` 或配置 `model` 字段指定。

**Q：上下文满了怎么办**
超过窗口 80% 会自动压缩成摘要继续；也可随时 `/compact`。磁盘上的会话记录始终是完整的。

**Q：想让某条命令不再每次确认**
确认框按 `a`（本会话）或 `A`（写入项目配置），也可以直接编辑配置里的 `permissions.allowBash`。
