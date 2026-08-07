# 技术栈迁移评估：对齐 opencode 核心栈（Bun + OpenTUI）

> 状态：**评估与规划**，未实施。分支 `spike/bun-opentui-migration`。
> 日期：2026-08-07。数据来自本仓库统计与 npm/上游仓库实查，引用处已标注。

## 0. 目标栈是什么

opencode 的基础核心技术栈，按层拆开：

| 层 | opencode 的选择 | mojocode 现状 |
|---|---|---|
| 运行时 | Bun（编译进单二进制，用户无需安装） | Node ≥ 20 |
| 渲染引擎 | OpenTUI（Zig 原生核心 + FFI，alternate screen） | Ink 7（纯 JS，主屏 + `<Static>` 进 scrollback） |
| 组件框架 | SolidJS（`@opentui/solid`） | React 19 |
| 进程模型 | HTTP server + TUI 瘦客户端（REST + SSE） | 单进程，EventBus 连核心与渲染层 |
| 分发 | `bun build --compile` 每平台二进制；npm/brew/安装脚本都是壳 | npm 包，`dist/cli.js` + 系统 Node |

**一个关键修正**：此前认为"迁 Bun = 强制用户装 Bun"，实查后不成立——opencode 的
npm 包 `opencode-ai` 只是二进制分发壳，Bun runtime 打进了二进制里。代价从"用户
装 Bun"转移为"我们维护每平台构建产物"（约 50-100MB/平台）。

**一个不必照抄的层**：`@opentui/react` 是一等公民绑定（与 solid 同版本 0.5.1
同步发版）。**保留 React 即可对齐"基础核心栈"（Bun + OpenTUI），SolidJS 不是
必要条件**。迁 SolidJS 意味着 4574 行 UI 全部换范式且 React 心智全部作废，
收益只有包体积与细微性能——不建议。

## 1. 迁移面盘点（本仓库实测数据）

### 1.1 Ink 依赖面：窄得出乎意料

```
使用的 Ink API（全仓库）：
  Text ×14 文件、Box ×13、useInput ×6、useApp ×3、useStdout ×1、render ×1、Static ×1
受影响文件：15 个，共 4574 行
  App.tsx 1656 / Input.tsx 852 / cli.tsx 536 / Timeline.tsx 237 / AuthWizard.tsx 231
  / PermissionPrompt.tsx 202 / Diff.tsx 146 / Markdown.tsx 135 / Footer.tsx 126
  / TodoPanel.tsx 102 / StatusLine.tsx 86 / SessionPicker.tsx 85 / RewindPicker.tsx 76
  / GoalLine.tsx 62 / Header.tsx 42
```

API 面只有 7 个符号，且大都有 OpenTUI 对等物（Box/Text → BoxRenderable/
TextRenderable，useInput → keyboard 事件，render → OpenTUI render）。**真正没有
对等物的只有 `<Static>`** ——它是整个"时间线写进终端 scrollback"设计的载体，
迁移后由 ScrollBox + 自持滚动状态替代。这不是 API 换名，是渲染模型的更换，
也是本次迁移的核心重构点（详见 §2.2）。

App.tsx 的 1656 行里大部分是事件订阅、斜杠命令、状态管理——这些是纯 React
逻辑，保 React 的前提下**原样保留**；需要重写的是 JSX 原语层和与 `<Static>`/
清屏序列耦合的部分（resize 重放、staticEpoch、`\x1b[2J\x1b[3J` 各处）。

### 1.2 Node API 面：全部是 Bun 兼容的常规模块

```
node:path ×12 / node:fs/promises ×9 / node:url ×3 / node:process ×3 / node:os ×2
node:fs ×2 / node:crypto ×2 / node:zlib ×1 / node:util ×1 / node:child_process ×1
spawn/execa 使用者：tools/bash、tools/search、app/doctor、app/clipboard、
  app/file-index、lsp/manager、lsp/client、agent/prompt（8 个文件）
```

全部在 Bun 的 node: 兼容层覆盖范围内。风险不在"能不能跑"，在细节行为差异：
execa 的信号处理、LSP/MCP stdio 子进程的流语义、`child_process` kill 树。
这正是 P0 spike 要验证的第一项。

依赖里无 native addon（jpeg-js 是纯 JS），AI SDK / MCP SDK / zod / commander
均为纯 JS——Bun 兼容性预期良好，但以 spike 实测为准。

### 1.3 测试：最大的隐性成本

```
tests/ 共 43 个文件；其中 13 个依赖 ink-testing-library（app-*.tsx、input、
markdown、permission、highlight 等全部 UI 测试）
```

- **核心逻辑测试（30 个）不受影响**：核心不 import React（CLAUDE.md 首要原则），
  这些测试继续用 vitest 在 Node 下跑即可——核心保持 runtime 无关，是本次迁移
  最重要的护城河。
- **UI 测试（13 个）需要整体换方案**。OpenTUI 的测试工具链成熟度未知
  （0.5.1，无 ink-testing-library 那样的成品），P0 必须先验证"能否驱动
  一个 OpenTUI 组件树并断言输出帧"，验证不过则 UI 测试降级为快照/e2e
  （PTY 驱动真进程），成本显著上升。

### 1.4 构建与分发

现状 `tsup → dist/cli.js`（deps external）+ 系统 Node。目标形态照抄 opencode：

- `bun build --compile` 出 darwin-arm64/x64、linux-x64/arm64（glibc+musl）、
  win32-x64 二进制；OpenTUI 的原生层已按平台发包
  （`@opentui/core-darwin-arm64` 等 8 个平台包，0.5.1 齐全，含 win32-arm64）
- npm 包转为 postinstall 拉二进制的壳（或 optionalDependencies 平台包模式）
- GitHub Releases + 安装脚本；CI 出多平台产物

这一层是纯工程活，无技术风险，但**长期维护成本从零涨到实打实的多平台
构建矩阵**。

## 2. 分层评估

### 2.1 运行时迁 Bun：低风险，独立可交付

Bun 只影响进程边界（子进程、fs、信号），核心 agent 循环全是纯 JS。
且**这一步可以独立于 OpenTUI 交付**：Ink 在 Bun 上能跑，先迁 runtime
不动 UI，产出"单二进制分发的 mojocode"就已经是用户可感的改进
（免 Node 安装、启动更快）。失败了也可整体回退，不连累渲染层。

### 2.2 渲染器迁 OpenTUI：高风险高收益，本次迁移的实体

收益（全部来自 alternate screen + 自持滚动）：
- `/focus` / `/details` 式折叠**随时双向切换**成为平凡功能——屏幕整个归
  程序画，重画即切换（此前调研的结论：滚动模式下这做不到，见
  `focus-mode-research` 记忆与 Claude Code issue #50894/#67289）
- resize 不再需要 App.tsx:733-770 那套 200ms settle 清屏重放——整块删除
- 输入框、状态栏、todo 面板真正固定，不再受动态区高度预算约束
  （RESERVED_ROWS 一族常量作废）
- ScrollBox/Code/Diff 组件开箱即用，可替换自研 Diff.tsx/highlight.ts 一部分

代价：
- **终端原生 scrollback 没了**（vim/htop 语义）。退出后终端不留会话痕迹、
  tmux copy-mode 失效、复制要按 shift。Claude Code 切全屏后的无障碍投诉
  （#67289，Closed as not planned）就是前车之鉴。**缓解**：退出时把时间线
  以纯文本 dump 回主屏（OpenTUI 退出恢复原 scrollback，dump 会接在原历史
  之后）；`-p` headless 模式完全不走 OpenTUI，管道语义不变。
- `<Static>` 的"只渲染一次"性能模型换成"每帧重画视口"——需要虚拟化
  （只渲染可见条目）+ markdown 渲染缓存（按 item key + 宽度记忆化），
  否则长会话每帧全量 renderMarkdownAnsi 会卡死。ScrollBox 是否内建虚拟化
  是 P0 验证项。
- 0.5.1 的 API 稳定性风险：锁死版本 + 薄适配层（自建 `src/ui/kit.ts` 包一层
  Box/Text/useInput 的等价物，UI 组件只 import kit，不直接 import OpenTUI），
  上游破坏性变更时只改一处。

### 2.3 组件框架：保 React（明确不迁 SolidJS）

理由见 §0。`@opentui/react` 与 solid 绑定同仓同版发布，不是二等公民。

### 2.4 client-server 分离：不在本次范围

opencode 的进程分离服务于"多客户端"（TUI/IDE/Web 共用一个 server）。
mojocode 的 EventBus 契约（core 不知道渲染层是谁）已经拿到了同样的解耦
收益，且 headless 模式复用同一循环。没有多客户端需求前，引入 REST+SSE
只增加延迟与运维面。**列为远期可选，不随本次迁移。**

## 3. 风险清单（按杀伤力排序）

| # | 风险 | 概率 | 缓解 |
|---|---|---|---|
| 1 | OpenTUI 0.x API 破坏性变更 | 高 | 锁版本；kit.ts 适配层；订阅上游 release |
| 2 | UI 测试无成熟方案 | 中高 | P0 先验证；不过则 PTY e2e 兜底，接受成本 |
| 3 | scrollback 丢失的体验/无障碍反弹 | 中 | 退出 dump 时间线；保留 `-p`;必要时保留 Ink 渲染器为 fallback（双渲染器,即 Claude Code 模式) |
| 4 | Bun 子进程细节差异咬到 LSP/MCP/bash 工具 | 中 | P0 全量跑 43 个测试 + doctor 实测 |
| 5 | Windows（conhost 滚轮、conpty） | 中 | 官方 win32 包已有；标注 Windows Terminal 为支持目标，conhost 尽力而为 |
| 6 | 双倍分发体积（~60MB vs ~2MB） | 已确定 | 接受（opencode/bun 生态常态） |

## 4. 分阶段规划

**总原则：每阶段独立可交付、可回退；核心（src/agent、src/tools、src/permissions、
src/config、src/session、src/mcp、src/lsp）保持 runtime 与渲染器双重无关。**

### P0 — Spike（1-2 天，本分支）
1. `bun run dist/cli.js` 全功能冒烟：TUI 起停、bash 工具、LSP 诊断、MCP stdio、
   `-p` 管道、`bun x vitest run` 或 Node 下 43 测试全绿
2. OpenTUI 最小原型：`@opentui/react` 渲染"ScrollBox 时间线 + 底部输入框"，
   验证——流式追加是否掉帧、滚动到底部跟随、ScrollBox 有无虚拟化、
   alternate screen 退出是否干净恢复
3. UI 测试可行性：能否 headless 驱动 OpenTUI 组件树断言帧内容
4. `bun build --compile` 出 darwin-arm64 二进制，体积与启动时间实测
5. **产出 go/no-go 报告补进本文档**。任一致命项不过 → 收缩为"仅 P1
   （Bun 单二进制）+ 滚动模式 /focus 路线 A"

### P1 — 运行时迁移（1-2 天）
- 修补 Bun 差异；构建链 tsup → `bun build`；CI 加 bun 矩阵
- 分发：`--compile` 多平台产物 + npm 壳
- **此阶段结束用户拿到：单二进制 mojocode，UI 与今天完全相同**

### P2 — 渲染器迁移（5-8 天，主体工程）
- `src/ui/kit.ts` 适配层（Box/Text/输入/焦点的稳定内部 API）
- 时间线：`<Static>` → ScrollBox + 虚拟化 + markdown 记忆化；
  删除 resize 重放、staticEpoch、清屏序列全家
- 逐组件迁移（依赖序）：theme/markdown-ansi（无 UI，直接复用）→ 叶子组件
  （Header/StatusLine/GoalLine/TodoPanel/Footer）→ Diff/Markdown →
  Timeline → PermissionPrompt/Pickers → Input（852 行，最难：粘贴、
  多行、补全、快捷键全在这）→ App 装配
- 退出时时间线 dump 回主屏
- UI 测试按 P0 结论重建
- **`/focus` 三档折叠在此阶段顺带完成**（全屏下即"过滤 + 重画"，
  此前滚动模式方案里的 collapseItems 谓词、"assistant 永不隐藏"铁律、
  占位行设计全部照搬,Static 尾部约束作废）

### P3 — 收尾（2-3 天）
- doctor 增加渲染器/平台检查项；README 与安装文档改写；
  Windows Terminal 实测；性能基线（长会话 5k 条目滚动帧率）

### 明确不做
- SolidJS 迁移；client-server 分离；Ink 双渲染器并存（除非 P0 触发风险 3 缓解）

## 5. 结论

- **可行**，且比一周前的判断更可行：分发问题已被 opencode 的单二进制模式
  解决，React 绑定使 UI 逻辑层大部分可保留。
- **总成本约 9-15 人天**，其中值得单独拿走的是 P1（1-2 天就能交付单二进制
  分发,不依赖后续阶段)。
- **最大的不可逆代价**是放弃终端原生 scrollback,换来 /focus、固定布局与
  resize 简化。这是价值观选择而不是技术优劣:opencode 选了全屏,Claude Code
  默认保 scrollback、全屏可选。若对此仍有犹豫,P0/P1 全部工作在两条路线下
  通用,真正的分叉点在 P2 动工前。
