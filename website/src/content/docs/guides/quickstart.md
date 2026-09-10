---
title: 快速开始
description: 从安装到第一次对话。
---

这一页带你从安装走到第一次有用的对话。

## 环境要求

运行时要求取决于装法:

| 安装方式 | 交互 TUI | `-p` 与子命令 |
|---|---|---|
| 单二进制 | 自带运行时,**不需要 Node** | 同左 |
| npm / 源码 | Node **≥ 26.1**(渲染器需要原生 FFI,启动时自动补 `--experimental-ffi`) | Node **≥ 22** |

两个门槛不一样:`node >= 22` 是整个 CLI 的硬下限,装得上只代表 `-p` 与子命令能跑;TUI 另外需要 26.1+ 的原生 FFI。Node 在 22 到 25 之间时直接运行 `mojocode` 不会崩,会打印一行提示让你装单二进制或升级 Node,`-p` 照常可用。

可选依赖:装了 [ripgrep](https://github.com/BurntSushi/ripgrep) 代码搜索快 10 到 100 倍,没有则自动降级(`brew install ripgrep`)。

## 安装

### 方式 A:单二进制(推荐)

自带运行时,启动比 Node 版快约 4 倍。macOS / Linux 一行装好:

```bash
curl -fsSL https://raw.githubusercontent.com/HongBin0721/mojocode/main/install.sh | sh
```

装到 `~/.local/bin/mojocode`。脚本自动识别平台,Alpine 切 musl 产物,用 `SHA256SUMS` 校验后才落盘。两个环境变量可调:

| 变量 | 作用 |
|---|---|
| `MOJOCODE_INSTALL_DIR` | 安装目录,默认 `~/.local/bin` |
| `MOJOCODE_VERSION` | 锁定版本,形如 `v0.6.0`,默认 latest |

Windows 到 [Releases](https://github.com/HongBin0721/mojocode/releases) 页下载 `mojocode-windows-x64.zip` 解压使用。

卸载:删掉 `~/.local/bin/mojocode`;配置与会话在 `~/.mojocode/`,可一并删除。

### 方式 B:npm 全局安装

```bash
npm install -g mojocode
```

npm 只分发 JS 产物,不含渲染器运行时:交互 TUI 需要本机 Node ≥ 26.1,Node 22 到 25 上只有 `mojocode -p` 与各子命令可用(CI、脚本场景够用)。想在旧 Node 上用 TUI 请改用方式 A。

卸载:`npm uninstall -g mojocode`。

### 方式 C:从源码

```bash
git clone https://github.com/HongBin0721/mojocode.git
cd mojocode
npm install
npm run build       # 打包到 dist/
npm link            # 把 mojocode 命令挂到 PATH
```

验证:

```bash
mojocode --version
```

## 配置 API 密钥

三种方式任选其一。

### 交互式向导(推荐)

```bash
mojocode auth            # 别名:mojocode login
```

流程:↑/↓ 选服务商 → 粘贴密钥(掩码显示,界面上有各平台申请密钥的网址)→ 自动调用该平台的 `/models` 接口验证 → 保存到 `~/.mojocode/config.json`(文件权限 0600)→ 可选设为默认服务商 → 可继续配置下一家。

没配置任何密钥时直接运行 `mojocode` 也会自动进入这个向导。

### 环境变量

共用机器上更安全,写进 `~/.zshrc`:

```bash
export DEEPSEEK_API_KEY=sk-...      # DeepSeek:      platform.deepseek.com
export MOONSHOT_API_KEY=sk-...      # Kimi 开放平台:  platform.moonshot.cn(按量付费)
export KIMI_CODE_API_KEY=sk-kimi-.. # Kimi Code 订阅: kimi.com/code(包月)
export ZHIPU_API_KEY=...            # GLM:           open.bigmodel.cn
```

:::note[Kimi 有两套产品]
开放平台(`kimi` 预设,api.moonshot.cn,按量付费)和 Kimi Code 订阅(`kimi-coding` 预设,api.kimi.com/coding/v1,包月)。两边密钥互不通用,按你买的是哪种选对应预设。全部预设见[模型与服务商](/config/providers/)。
:::

### 直接写配置文件

`~/.mojocode/config.json`:

```json
{ "providers": { "glm": { "apiKey": "..." } } }
```

## 验证连通

```bash
mojocode doctor                     # 一次性体检:环境、配置、密钥、端点连通、MCP、会话存储
mojocode providers                  # 列出内置服务商,✓ 表示密钥已就位
mojocode models --provider glm      # 拉取你的密钥实际可用的模型列表
```

`doctor` 是排障的第一站:每一项标成 ✓ / ! / ✗,异常项直接给出修复命令,密钥只显示打码后的头尾。存在异常项时退出码为 1,可以放进 CI 当门禁。

```bash
mojocode doctor --offline           # 跳过联网检查
mojocode doctor --json              # 结构化输出,字段 id 稳定
mojocode doctor -C ~/某项目          # 体检指定工作区
```

## 第一次对话

```bash
cd ~/你的项目
mojocode
```

进入全屏 TUI 后直接打字提需求,agent 会自主读代码、改文件、跑命令。几个马上用得到的键:

| 按键 | 作用 |
|---|---|
| `esc` | 中断正在执行的任务 |
| `ctrl+c` 两次 | 退出(时间线会以纯文本写回终端) |
| 输入 `/` | 弹出命令菜单 |
| 输入 `@` | 文件模糊补全,提交时文件内容自动附给模型 |

:::caution[没有权限确认]
mojocode 没有权限系统:工具能碰到进程能碰到的任何路径,`bash` 会直接执行。第一次建议在不重要的目录或一次性的工作副本里跑。原因与拦截方式见[没有权限系统](/features/permissions/)。
:::

下一步:[TUI 交互](/guides/tui/)了解全部命令与快捷键,或直接看[配置总览](/config/overview/)。
