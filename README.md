# mojocode

一个运行在终端里的通用编程 agent，可接入任意大模型——内置 **Kimi**、**DeepSeek**、**GLM** 预设，也支持任何 OpenAI 兼容接口。

全屏 TUI 交互、真实的文件/shell/搜索工具、所有改动前置权限确认、会话持久化与上下文自动压缩、MCP 扩展支持。

---

## 一、完整流程：从安装到第一次使用

### 0. 环境要求

运行时要求**取决于装法**，先看这张表再挑下面的安装方式：

| 安装方式 | 交互 TUI | `-p` 与子命令 |
|---|---|---|
| 单二进制 | ✅ 自带运行时，**完全不需要 Node** | ✅ |
| npm / 源码 | 需 Node **≥ 26.1**（渲染器原生 FFI，启动时自动补 `--experimental-ffi`） | Node **≥ 22** |

两个门槛不一样：`engines` 里的 `node >= 22` 是整个 CLI 的硬下限（依赖 execa 10 用到
`Set.prototype.union`，Node 20 上 import 期直接崩），装得上只代表 `-p` 与子命令能跑；
TUI 另外需要 26.1+ 的原生 FFI。Node 在 22~25 之间时直接运行 `mojocode` 不会崩，
会打印一行提示让你装单二进制或升级 Node，`-p` 照常可用。

| 其它依赖 | 要求 | 检查方式 |
|---|---|---|
| ripgrep（可选） | 有则代码搜索快 10~100 倍，没有自动降级 | `rg --version`，安装：`brew install ripgrep` |

### 1. 安装

**方式 A：单二进制（推荐，免装 Node）**

自带运行时、启动比 Node 版快约 4 倍。macOS / Linux 一行装好：

```bash
curl -fsSL https://raw.githubusercontent.com/HongBin0721/mojocode/main/install.sh | sh
```

装到 `~/.local/bin/mojocode`（`MOJOCODE_INSTALL_DIR` 可改，`MOJOCODE_VERSION` 可锁版本）。
脚本会自动认平台、Alpine 切 musl 产物，并用 `SHA256SUMS` 校验后才落盘。
Windows 到 [Releases](https://github.com/HongBin0721/mojocode/releases) 页下载 `mojocode-windows-x64.zip` 解压使用。

> 该脚本从 GitHub Releases 拉产物，依赖仓库已发布过 `v*` Release（发布流程见「六、开发」）。

> 卸载：删掉 `~/.local/bin/mojocode` 即可,配置在 `~/.mojocode/` 里,可一并删除。

**方式 B：npm 全局安装**

```bash
npm install -g mojocode
```

⚠️ npm 只分发 JS 产物，**不含渲染器运行时**：交互 TUI 需要本机 Node ≥ 26.1，
Node 22~25 上只有 `mojocode -p "..."` 与各子命令可用（CI、脚本场景够用）。
Node < 22 装不上（`engines` 挡住）。想在旧 Node 上用 TUI 请改用方式 A。

> 卸载：`npm uninstall -g mojocode`。

**方式 C：从源码（`-p` 需 Node ≥ 22，TUI 需 ≥ 26.1）**

```bash
cd agent_dev        # 项目目录
npm install         # 安装依赖
npm run build       # 打包到 dist/
npm link            # 把 mojocode 命令挂到 PATH
```

验证安装：

```bash
mojocode --version       # 输出版本号即成功
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
mojocode doctor                     # 一次性体检：环境、配置、密钥、端点连通、MCP、会话存储
mojocode providers                  # 列出内置服务商，✓ 表示密钥已就位
mojocode models --provider glm      # 拉取你的密钥实际可用的模型列表
```

`doctor` 是排障的第一站：它把每一项标成 ✓（正常）/ !（提醒）/ ✗（异常），并对异常项直接给出
修复命令。密钥只显示打码后的头尾。存在异常项时退出码为 1，可以直接放进 CI 当门禁。

```bash
mojocode doctor --offline           # 跳过联网检查（端点探测、版本比对、MCP 连接）
mojocode doctor --json              # 结构化输出，字段 id 稳定，便于脚本消费
mojocode doctor -C ~/某项目          # 体检指定工作区（项目级配置、git、AGENTS.md）
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

TUI 运行在 alternate screen(全屏,类似 vim):滚轮/`PageUp`/`PageDown` 回看时间线,
上滚自动暂停跟随、滚回底部恢复;退出时整场会话以纯文本写回终端,历史仍可翻可复制。

**复制文本**:直接拖选即可——松手自动写入系统剪贴板(tmux copy-on-select 风格,
footer 回显「已复制 N 个字符」;SSH 场景经 OSC 52 送达本机,iTerm2 需在设置里允许
「Applications may access clipboard」)。也可按住 `shift`(macOS 上 `option`)拖选走
终端原生复制。

| 操作 | 说明 |
|---|---|
| 直接打字回车 | 提需求，agent 自主读代码/改文件/跑命令 |
| `esc` | 中断正在执行的任务 |
| `ctrl+c` 两次 | 退出（时间线自动 dump 回终端历史） |
| `滚轮` / `PageUp` / `PageDown` | 回看时间线;滚到底部恢复自动跟随。滚轮停在 `/` 命令菜单、`@` 文件菜单或二级选择器上时滚的是那份列表（等同 `↑`/`↓`，同样首尾环绕），不会连带滚动时间线 |
| `ctrl+o` | 循环时间线密度：`full` → `compact` → `result`（`/focus` 可落盘,见下） |
| `ctrl+r` | 展开/收起详情：思考正文与工具输出默认折叠成一行 `+ N 行输出`，按一次全部摊开（diff、方案正文、任务清单是结果，从不折叠） |
| `shift+tab` | 循环切权限档位：`read-only` → `ask` → `auto` → `full-access` → `plan` → `read-only`（只改本会话，不落盘） |
| `鼠标点击` | 点底栏的权限档位弹出档位选项框（四个预设 + `plan` 全列出，键盘同样可用，`esc` 取消；点名指定的这一档会落盘到本工作区配置）；授权确认框、回退选择器、`/setting` 面板的列表行点一下即选中。按下与抬起要落在同一格才算点击，所以拖选复制不会误触发 |
| `shift+enter` | 输入框内换行（需终端支持 kitty 键盘协议：iTerm2 3.5+ / kitty / WezTerm / Ghostty 等） |
| `option+enter` / `ctrl+j` / 行尾 `\` + 回车 | 换行的兜底按键，任何终端可用 |
| `↑`/`↓` | 翻历史输入；多行草稿内为上下移动光标 |
| 输入 `/` | 弹出命令菜单，`↑`/`↓` 选择、回车执行、`tab` 补全 |
| 输入 `@` | 弹出文件模糊补全菜单，回车/`tab` 插入路径；提交时被 `@` 引用的文件内容自动附给模型作上下文（时间线仍只显示原文）。`@截图.png` 等图片引用会作为图片附给支持视觉的模型（png/jpg/gif/webp，单张 ≤5MB） |
| `ctrl+v` | 粘贴剪贴板中的图片：输入框出现 `[image #N]` 占位符，提交时图片随消息发给模型（macOS 为主平台，Linux 需 `xclip`/`wl-paste`）。注意 DeepSeek 官方 SDK 不支持图片，会被忽略并提示 |

图片长边超过 1568px 时会自动等比降采样（PNG 用 `node:zlib` 手写编解码，JPEG 走纯 JS 的 `jpeg-js`，缩放统一用盒式滤波）——服务商本身就会缩到这个尺寸，多传的像素只会白白撑大会话文件并在后续每一步重传。格式保持不变，重编码后反而更大时保留原图；GIF/WebP 不处理。所有图片另受 5MB/张、10MB/条的上限约束。
| 命令菜单回车 | 带枚举参数的命令（`/model` `/provider` `/approvals` `/think` `/focus`）会进入二级选择器 |

**斜杠命令**：

| 命令 | 作用 |
|---|---|
| `/help` | 列出所有命令 |
| `/init` | 分析代码库并生成/改进项目根目录的 AGENTS.md（会注入后续会话的系统提示词） |
| `/plan [任务]` | 进入计划模式：只读调研、产出方案交你批准，批准后自动开工。带参数则顺带以该任务开跑 |
| `/goal [条件\|clear]` | 目标模式：给一个完成条件，每轮结束后自动检查、没达成就接着干。不带参数看状态，`clear` 取消 |
| `/model <id>` | 切换模型；不带参数列出可用模型 |
| `/provider <id>` | 切换服务商（kimi / deepseek / glm / …） |
| `/approvals <预设>` | 切换沙箱与确认策略预设 |
| `/setting` | 打开设置面板：界面语言、状态栏显示项。`↑`/`↓` 选择、回车进入、`esc` 逐级返回；状态栏是多选，空格勾选、回车生效。改动即时生效并写入 `~/.mojocode/config.json` |
| `/focus <full\|compact\|result>` | 时间线密度并落盘:`full` 全量、`compact` 折叠成段的工具调用为「⋯ N 个工具调用已折叠」、`result` 只看问答。`ctrl+o` 会话内循环切换,随时双向可逆;回答、报错与各类提示在任何档位都不隐藏 |
| `/compact` | 手动压缩上下文 |
| `/clear` | 开始新对话 |
| `/resume` | 切换到本目录的另一个历史会话（二级选择器选取） |
| `/fork` | 把当前对话分叉进新会话继续，原会话停在分叉点不再变动 |
| `/mcp` | 查看 MCP 服务器状态 |
| `/doctor [offline]` | 体检：环境、配置、密钥、端点连通、MCP、会话存储。读会话此刻的配置，`offline` 跳过联网检查 |
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

恢复会话时会完整回放时间线,并还原当时的两轴权限、任务列表与本会话批准过
的规则(CLI 参数可覆盖);模型不还原,始终沿用当前配置的 provider/model。
会话完整记录(未压缩)保存
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

### server 模式（进阶）

TUI 默认以 client-server 方式运行（与 opencode 相同的进程模型）：启动时自动拉起一个
受管的 `mojocode serve` 子进程，agent 核心、工具、MCP、LSP、会话存储都在 server 侧，
TUI 只是经 HTTP + SSE 连接的瘦客户端。这一切对日常使用完全透明；需要时也可以手动操作：

```bash
mojocode serve                          # 独立运行 server，打印地址与 token
MOJOCODE_SERVER_TOKEN=<token> mojocode --attach http://127.0.0.1:<port>
                                        # 另开终端，把 TUI 连到已运行的 server
MOJOCODE_NO_SERVER=1 mojocode           # 排障逃生口：回到单进程模式
```

server 只绑定 127.0.0.1，所有请求都要 Bearer token 鉴权（它能执行任意命令，必须挡住
本机上的其他程序与浏览器页面的盲发请求）。`-p` 非交互模式不走 server，管道语义不变。

---

## 三、配置

配置文件分两层：`~/.mojocode/config.json`（全局）和 `<项目>/.mojocode/config.json`（项目级，可提交进仓库）。完整示例：

```json
{
  "provider": "glm",
  "model": "glm-5.3",
  "language": "zh-CN",
  "sandbox": "workspace-write",
  "approval": "untrusted",
  "permissions": {
    "allowBash": ["Bash(npm test:*)", "Bash(git diff:*)"],
    "allowWrite": ["src/**"],
    "allowNet": ["WebSearch", "WebFetch(domain:*.github.com)"]
  },
  "search": { "backend": "glm" },
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

`/goal` 另有两个配置项：

| 键 | 默认 | 说明 |
|---|---|---|
| `goalModel` | 会话当前模型 | 判定目标是否达成的模型 id，走当前服务商。判定只读一段抄本、只回两行，换个便宜的小模型能把自动循环的附加成本压到接近零。也可用 `MOJOCODE_GOAL_MODEL` 覆盖 |
| `goalMaxTurns` | `10` | 一个目标最多自动续跑多少轮（上限 100）。默认给得保守：10 轮无人看管的 agent 轮次在真实代码库上已经是几十万 token |

### 联网搜索

内置 `web_search`（搜索）与 `web_fetch`（抓网页转 Markdown）两个工具。`web_fetch` 零依赖
随时可用；`web_search` 需要一个搜索后端的 key，没有就不注册（模型不会看到这个工具）。

| 后端 | 端点 | key 环境变量 | 成本 |
|---|---|---|---|
| `glm` | 智谱独立搜索 API | `ZHIPU_API_KEY`（与 GLM 大模型同一把 key） | search_std 约 ¥0.01/次 |
| `exa` | api.exa.ai | `EXA_API_KEY` | 免费 20k 次/月 |
| `custom` | 自定义（`search.baseURL`） | `search.apiKey` 或 `search.apiKeyEnv` | — |

默认 `search.backend: "auto"`：按 glm → exa 的顺序取第一个能从**预设环境变量**拿到 key
的后端。**用 GLM 当大模型的用户零配置即可搜索。** 注意 `auto` 刻意忽略 `search.apiKey`
与 `MOJOCODE_SEARCH_API_KEY`——一把不知道属于谁的 key 拿去打错端点只会得到费解的 401，
**专用 key 必须配显式 backend**。`"off"` 显式关闭。`search` 节的其余键：`engine`
（GLM 档位，`search_std`/`search_pro`/…）、`count`（默认返回条数）、`baseURL`（覆盖端点；
custom 必填，请求/响应契约与 GLM 的 `/paas/v4/web_search` 相同）。

命令行 `--search-backend <id>`，环境变量 `MOJOCODE_SEARCH_BACKEND`。`mojocode doctor`
有独立的「联网搜索」分节：后端解析、key 来源、端点连通（探测发一次最小真实请求，
GLM 计费约 ¥0.01）。

**零成本替代：挂免费搜索 MCP。** 不想为搜索配任何 key，可以接一个免费的
DuckDuckGo MCP server——MCP 工具与内置工具走同一套权限门：

```json
{
  "mcpServers": {
    "ddg": { "type": "stdio", "command": "npx", "args": ["-y", "duckduckgo-mcp-server"] }
  }
}
```

区别：MCP 工具按 `Mcp(工具名)` 逐工具确认，内置 `web_fetch` 按域名确认记忆，两者可共存。

> 代理提示：Node 的原生 fetch 不读 `HTTP_PROXY`/`HTTPS_PROXY`。需要走代理访问 Exa 时，
> 可设 `NODE_USE_ENV_PROXY=1`（Node 24+），或直接换 `glm` 后端（国内直连）。

### LSP 诊断回喂

agent 每次 `write`/`edit` 成功后，mojocode 会把文件交给对应语言的 LSP 服务器，
将**错误与警告**（不含 info/hint）随工具结果一并回喂给模型——改坏了当场就知道，
不用等到跑 `tsc`/测试才发现。工具卡片的摘要也会带上错误数（如 `1 处替换 · 2 个 LSP 错误`）。

内置识别四个服务器，**装了就用，没装就静默跳过**（绝不自动下载，也绝不因此报错）：

| 语言 | 命令 | 安装 |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript@5`（工作区 node_modules 里有 typescript@5 也行；注意 tsls 尚不支持 typescript@7） |
| Python | `pyright-langserver` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |

服务器按需惰性拉起（首次检查多付一次握手时间），拉不起来的本会话不再重试。
`lsp` 配置节：

```json
{
  "lsp": {
    "enabled": true,
    "timeoutMs": 3000,
    "servers": {
      "typescript": { "enabled": false },
      "clangd": { "command": "clangd", "extensions": [".c", ".cc", ".cpp", ".h"] }
    }
  }
}
```

`enabled: false` 整体关闭；`timeoutMs` 是单次等诊断的时长（超时不打扰模型，宁缺毋滥）；
`servers` 里内置 id（`typescript` / `pyright` / `gopls` / `rust-analyzer`）只需写要覆盖的
字段，自定义条目至少要 `command` 和 `extensions`。全局与项目配置按服务器 id 合并。
`graceMs` 是收到空诊断批次后再等后续批次的时长——rust-analyzer（cargo check 流式
出结果）和 gopls（按包检查）先发空批次占位，内置宽限分别为 1500/1000ms（其余 400ms），
大项目上漏报「有错」时把它调大。

**跨文件连带错误**也能感知：改了 A 的签名、之前检查过的 B 的调用点炸了，结果里会带
一行 `src/b.ts: 2 errors（本次改动可能弄坏了它）`——只报本会话检查过的文件，
全工程分析器顺手推送的存量问题不算。

`mojocode doctor` 有独立的「LSP 诊断」分节：逐个列出合并后的服务器。命令不在 PATH
上时，内置服务器报 info（没装是常态）、用户显式配置的条目告警；在 PATH 上的会做一次
**真握手探测**（拉起、initialize、随即杀掉）——只查存在性抓不住「装了个坏的」，比如
tsls 没有工作区 typescript@5 时命令在而起不来。`--offline` 跳过探测；TUI 的 `/doctor`
对会话内已拉起的服务器直接采信运行状态，不重复拉起。

### 界面语言

界面内置英文和简体中文。解析顺序：配置 `language` → `MOJOCODE_LANG` → 系统 `LANG`/`LC_ALL`
（任何 `zh*` 都映射到 zh-CN）。运行中在 `/setting` 设置面板里选「语言」即时切换并落盘。

回喂给模型的文本（工具报错、拒绝原因）刻意保持英文——那是 prompt 的一部分，
混语言会影响 function calling 质量。语言文件在 `src/i18n/`，有 parity 测试保证
两份目录键位对齐，新增语言只需加一个文件和一个联合类型成员。

### 项目指令

在项目根放 `AGENTS.md`（或 `MOJOCODE.md`），内容会注入系统提示，用来声明项目规范
（构建命令、代码风格、禁改目录等）。

### 技能（Agent Skills）

技能是可复用的指令包，遵循 [agentskills.io](https://agentskills.io) 开放标准——一个目录
一个技能，入口是 `SKILL.md`（YAML frontmatter + Markdown 正文），Claude Code / opencode
生态里现成的技能可以直接拿来用。发现目录按优先级：

```
<项目>/.mojocode/skills/<名字>/SKILL.md    项目级（可提交进仓库）
~/.mojocode/skills/<名字>/SKILL.md         全局
<项目>/.claude/skills/<名字>/SKILL.md      兼容 Claude Code 的项目技能
~/.claude/skills/<名字>/SKILL.md           兼容 Claude Code 的全局技能
```

最小示例（`~/.mojocode/skills/release/SKILL.md`）：

```markdown
---
description: 发布一个新版本。用户要求发版、打 tag 或更新 changelog 时使用。
argument-hint: "[版本号]"
---

按以下步骤发布版本 $0：
1. 跑通 npm test 与 npm run typecheck
2. 更新 CHANGELOG.md 与 package.json 的版本号
3. 提交并打 tag v$0
```

两个入口：**模型自主调用**——技能的 name+description 常驻在内置 `skill` 工具的描述里
（每个技能只占几十 token），模型判断相关时自己加载正文；**斜杠直接调用**——技能名
出现在 `/` 补全菜单里，`/release 1.2.0` 直接展开正文发起一轮（`$ARGUMENTS`、`$0`…`$N`
被替换成参数），`-p "/release 1.2.0"` 在脚本里同样可用。`/skills` 强制重扫并列出全部
技能；平时的增删改在 15 秒内自动生效。与内置命令同名的技能不进菜单——内置命令优先。

frontmatter 可选字段：`name`（缺省取目录名，写了必须与目录名一致）、`argument-hint`
（补全菜单里的参数提示）、`disable-model-invocation: true`（只允许用户斜杠触发，适合
发版、部署这类有副作用的流程）、`user-invocable: false`（只允许模型加载，适合背景知识）、
`context: fork`（正文交给子 agent 在独立上下文里执行，只把报告带回主对话，走 task 工具
同一条通道）、`allowed-tools`（见下）。未知字段一律忽略。

技能目录里可以放 `references/`、`scripts/` 等附属文件,激活后该目录自动成为**只读**
扩展根——`read`/`glob` 够得着技能自带的资料,但任何写入仍然只限工作区,`.env`、密钥
等拒绝规则在技能目录里同样生效。

`allowed-tools: Bash(git tag:*) Bash(npm publish:*)` 声明技能希望预先放行的规则。
**首次激活时会弹一次确认框**,列出全部规则,批准后进本会话的临时授权(等价于确认框里
的「本次会话始终允许」),拒绝则技能照常加载、后续操作回到逐条确认。规则永远不会
被技能自动写进配置文件——frontmatter 是随仓库来的内容,落盘授权只能由用户在确认框里
逐条选择。

**安全提示**:技能正文是喂给模型的指令,与随仓库而来的任何可执行内容一样,存在提示
注入面——只使用你自己写的或审阅过的技能,`/skills` 与 `mojocode doctor` 都会列出当前
生效的技能及其来源目录。

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

**联网是独立的权限维度**：`web_search`/`web_fetch` 首次访问一个目标会弹确认，
「本会话总是允许」记为规则——搜索一条总闸 `WebSearch`，抓取按域名
`WebFetch(domain:example.com)`（`*.example.com` 匹配任意深度子域，不含裸域）。规则可
持久化进 `permissions.allowNet`，headless/`never` 档靠预先配置的 allowNet 无人值守联网。
两条硬线不受任何档位影响：私网/链路本地/云元数据地址（`192.168.*`、`169.254.169.254`
之类）一律拒绝，`danger-full-access` 也不豁免；跨域名重定向会对落点重新走一遍确认。
计划模式允许联网——调研本来就常要查文档。

**与 Codex 的一处刻意差异**：Codex 的 sandbox 是 OS 内核强制（Seatbelt/Landlock），
命令真的跑在沙箱里，所以 workspace-write 下任意命令都能放行。mojocode 的约束在权限门
这一层，无法把一条 bash 命令圈在工作区里，所以 workspace-write 下非白名单命令仍视为
「沙箱外」（要确认，`never` 下直接拒）；Codex 的 `on-failure` 策略也因此不存在。

运行中 `shift+tab` 按放宽递增循环 `read-only` → `ask` → `auto` → `full-access` → `plan`，
再回到 `read-only`。当前档位是自由组合（不在四个预设里）时，按下落到 `plan`——它写不了
任何东西，误触只可能收紧权限。底栏最左边那枚档位徽章可以直接点，弹出的选项框把四个预设和
`plan` 一并列出、标出当前档，点或回车选定、`esc` 取消——差别只是由你指定落在哪一档，
而不是盲切下一档，也正因为是点名指定的，只有它会落盘。

在选项框里选定的档位（以及 `/approvals`）会写进**本工作区**的 `.mojocode/config.json`
（不碰全局配置：放宽是对某个工作区的信任声明，不该泄漏到别的目录），所以选一次就管到
下次在这个目录启动，落盘后时间线上会说明写到了哪个文件。`shift+tab` 只改本会话不落盘：
按下之前并不知道会落在哪一档，一次误触不该改写可提交的项目配置——尤其是从 `plan` 出来
那一步循环规定落到 `read-only`，那是退出计划模式的附带结果，不是你对档位的表态。
`plan` 任何路径都不落盘——它是一次协作方式的选择，不是档位。

`full-access` 绕过硬拒名单，是唯一能让模型在工作区外动手、跑 `rm -rf`/`sudo` 这类命令
的一档。它同样会被留存，所以每次切到它都会在时间线上留一条警告：底栏那两秒的回显翻不
出来，事后看记录得能认出这一段跑在无沙箱下。要收回，切回别的档位即可（照样落盘）。

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

### 目标模式

`/goal <条件>` 给出一个完成条件，条件原文即刻作为第一轮的指令发出。此后**每一轮结束**
都由一次独立的模型调用判断条件达成没有：达成就收工，没达成就把判定理由当作下一轮的
指令接着干，直到达成或触到刹车。

```
/goal 让 npm test 全部通过，且不改动任何测试文件
/goal                # 看状态：条件、轮数、已用时、本次目标花掉的 token、最近一次判词
/goal clear          # 取消（stop / off / reset / none / cancel 同义）
```

条件写得越可验证越好——判定器只能读对话记录，不能自己跑命令，所以「`npm test` 退出码
为 0」这种能在记录里看见输出的条件，远比「代码质量变好」可靠。它也被明确要求：记录里
没有出现证据就一律判未达成，模型嘴上说的「应该能过」不算数。

刹车有四道，任何一道触发都会解除目标（而不是留着等你下次发言时又自己跑起来）：

- `goalMaxTurns`（默认 10 轮）——无人看管的循环必须有上限，想跑长任务就把它调高；
- esc 中断，或那一轮以错误收尾——不对着一个被掐掉或 401 的会话反复重试；
- 判定器连续两次给不出能读懂的判词——评估器坏了和确实没做完不能混为一谈；
- 切进计划模式——它的要义是停下来等批准，与自动续跑正相反，因此 `/goal` 也拒绝在
  计划模式下启动。

`/goal` **不改权限档位**：`ask` 档下每一轮照样逐次弹确认框。想要真正无人值守，
自己配合 `/approvals auto`。

两轮之间的判定窗口里 agent 是空闲的，但这段时间同样算「忙」：`/clear`、`/model`、
`/resume` 会被拦下，esc 停的是整个循环；这时候发消息则会成为下一轮的指令，取代判定器
的引导——你随时可以纠偏，而不必先把循环停掉。

未完成的目标会随会话存盘。`mojocode -c` 恢复回来时它是「已设定但不自动开跑」：轮数、
计时和 token 基线全部重置，发条消息才接着往下做——打开一个旧会话不该凭空烧掉一轮。

### 子任务（task 工具）

主 agent 可以用内置的 `task` 工具把一个独立子任务委托给**子 agent**：它在全新的上下文
里跑同一套循环，拥有同样的工具（去掉 `task` 自身、`todo` 与 `exit_plan`——递归只放
一层，会话状态归主 agent 管），最终只把一份报告带回主对话。价值在于上下文隔离：
「把这 40 个文件翻一遍、总结调用关系」这类调研的中间过程不再挤占主上下文，主对话
只收到结论。

不需要任何配置，模型自己决定何时委托。子 agent 分两种类型：`general`（与主 agent
同一套工具）和 `explore`（**只读调研**——只有 read/glob/grep/web，纯调研任务用它
更安全，连写入确认框都不会弹）。运行中过程实时可见——工具行贴步数，下方缩进
滚动显示子 agent 最近三条工具调用：

```
⚒ Task(找调用点 · explore) · 5 步
   ⎿ Grep(handleSubmit · src/**)
   ⎿ Read(src/ui/App.tsx)
```

轨迹只画在动态区，任务收尾即消失，时间线（回滚缓冲）里只留一行摘要
（`12 步 · 45.2k tokens`）。子 agent 的 token 消耗计入 `/cost` 与状态栏总量。
子任务的**完整过程**（每一步消息）随会话落盘（会话文件里的 `task` 记录，旧版本
安全跳过）——事后排查"那个子任务为什么给了错结论"时有据可查。

安全性与主 agent 完全一致：**同一个权限门**——子 agent 的写入/命令照样弹同一个
确认框，计划模式照样锁死写入，esc 中断主轮时子 agent 立即跟着停。撞上步数上限或
中途出错时，报告会被显式标记为不完整（摘要行显示「未完成」），不会把半截调研当定论。

| 键 | 默认 | 说明 |
|---|---|---|
| `taskModel` | 会话当前模型 | 子 agent 用的模型 id（与会话同一个服务商）。调研型子任务换个便宜的模型很划算。也可用 `MOJOCODE_TASK_MODEL` 覆盖 |
| `taskMaxSteps` | 同 `maxSteps`（50） | 子 agent 单次任务的步数上限。调研型子任务给更小的值能更早止损 |

与模式无关、始终生效的硬约束：

- 所有路径经 `realpath` 解析后必须落在工作区内（防 symlink 逃逸）
- `.git/`、`.env*`、密钥文件、SSH 材料永远禁止读写
- 灾难性命令直接拒绝：`rm -rf`、`sudo`、`curl … | sh`、force push、hard reset 等

---

## 五、架构

核心原则：agent core 不 import UI 框架（SolidJS）。core 通过事件总线发事件、通过回调
等待授权决定，同一套循环同时驱动 TUI 和 headless 渲染器。

进程模型与 opencode 一致：TUI 是瘦客户端，默认自动拉起受管的 `mojocode serve` 子进程
（agent 核心与所有工具都在 server 侧），经 REST + SSE 通信；`-p` headless 保持单进程。

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
  server/      HTTP + SSE server（serve.ts）与线上协议（protocol.ts）
  client/      远程会话瘦客户端（SSE 状态镜像 + 串行化 RPC）
  i18n/        语言目录（en / zh-CN）
  ui/          OpenTUI + SolidJS(@opentui/solid)组件;kit.tsx 是渲染器适配层
```

渲染层是 [OpenTUI](https://github.com/anomalyco/opentui) + SolidJS(`@opentui/solid`,
与 opencode 完全同款:Zig 原生渲染核心 + Solid 细粒度响应式)。运行在 alternate
screen 全屏模式。`src/ui/kit.tsx` 以 Ink 形状的 API(Box/Text/useInput)包住
OpenTUI:组件层不直接触碰上游 0.x API,破坏性变更只改 kit 一处。TUI 模块按需
动态加载:Bun / 单二进制直接跑;npm + Node 需要 26.1+(缺 `--experimental-ffi`
时自动重启注入);更老的 Node 只影响 TUI,`-p` 与全部子命令照常。

容易踩的坑（都已处理，改代码时注意别退化）：

- **GLM 的 baseURL 是 `/api/paas/v4`**，绝不能再拼 `/v1`，否则 404。
- **模型 ID 一律不硬编码。** 三家迭代都快，预设只是起始默认值，`mojocode models` 看实时列表。
- **diff 里的语法高亮不能用 highlight.js 的默认配色**:那套配色是给白底设计的
  （字符串取红、数字与注释取绿），画在 diff 自己的红/绿底色上就成了「绿底红字」，
  语义正好反过来。`highlightDiffLine` 用一套避开红绿、亮度足够的配色，且必须覆盖
  默认主题里**所有**着色的键——漏掉的键会静默回落到默认值。
- **单行信息栏必须自己裁到宽度以内**:OpenTUI 的 flex 行超宽时收缩的是子节点
  本身,分隔符两侧的空格会被静默吃掉(渲染成 `full-access· kimi-k3 · …/demo·
  思考 max`),而不是优雅截断。Footer 因此先量宽再排版(`fitParts`):路径先
  动态收窄,窄到没信息量就让它独占一行,仍装不下才按优先级丢段。
- **时间线条目定稿后不可变**:App 的 `<For>` 按引用复用条目,Solid 细粒度更新下
  天然零重渲染;`renderMarkdownAnsi` 按 (key, width) 走 LRU 缓存(md-cache.ts)。
  别原位修改条目对象(要整条替换),也别在条目渲染路径里加未缓存的重计算。
- **Solid 纪律**:组件内不解构 props(会断开响应式);span 的样式只能经
  `style` prop 送达(直传 fg=/bg= 被上游静默忽略);裸 `solid-js` 会解析到
  非响应式的 SSR 桩,构建链里把它钉到 dist/solid.js 的三处配置都不能动
  (tsup.config.ts / vitest.solid.ts 有注释)。
- **OpenTUI 的 `<text>` 不解析 ANSI 字符串**——所有定稿格式化资产(markdown/
  高亮/diff/表格)输出的 ANSI 由 kit 的 `<Text>` 经 `ansi-spans.ts` 转成 span;
  SGR 39/49 的语义是「继承外层」,Diff 的背景高亮依赖这一点。
- **历史用 `result.responseMessages`**，不是 `result.response.messages`——
  后者只含最后一步，会悄悄丢掉前面的工具调用。
- **user/assistant/error/banner 与全部 notice 在 /focus 任何档位都不隐藏**
  (src/ui/focus.ts 的铁律,tests/focus.test.ts 锁死)。

---

## 六、开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # 核心测试(Node):沙箱逃逸、bash 拒绝列表、配置分层、权限门、i18n 对齐等
npm run test:ui     # UI 测试(需 Bun):OpenTUI 真渲染 + 模拟键盘,tests/ui/ 下
npm run dev         # 监听改动自动重新打包
```

**单二进制构建**（需要 [Bun](https://bun.sh)，仅构建用——日常开发与 npm 分发照旧走 Node）：

```bash
npm run build                                     # 先出 dist/cli.js
npm run build:bin -- --target=darwin-arm64 --no-archive   # 只编本机平台
npm run build:bin                                 # 全 6 平台 + tar.gz/zip + SHA256SUMS
```

产物在 `dist/bin/`。版本号在编译期注入（`$bunfs` 里读不到 package.json）——细节见
`scripts/build-binaries.ts` 头注释。

**发布**（两条线互不依赖，二进制靠 tag 触发 CI，npm 手动发）：

```bash
npm version minor -m "release: v%s"   # bump + commit + 打 v* tag
git push --follow-tags                # 触发 release.yml:测试 → build → 6 平台交叉编译
                                      # → 归档 + SHA256SUMS → 建【草稿】Release
# 到 GitHub Releases 页把草稿 Publish 出去 —— 不做这步,install.sh 会 404

npm login && npm publish              # prepublishOnly 跑 typecheck + test + test:ui + build
                                      # (所以本机必须有 Bun 才能发 npm)
```

---

## 常见问题

**Q：跑不起来，但不知道卡在哪一步**
`mojocode doctor`。它会逐项报出 Node 版本、配置文件解析、密钥来源、端点是否可达、
模型 id 是否还在服务商列表里、MCP 连接、会话目录是否可写，并对每个异常项给出修复命令。

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
