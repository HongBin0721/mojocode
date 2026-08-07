# 技术栈迁移评估：对齐 opencode 核心栈（Bun + OpenTUI）

> 状态：**P0 spike 完成（GO，见 §6）；P1 已交付（见 §7）;P2 已交付(见 §8);
> 进程模型迁移已交付(见 §9,推翻 §2.4);SolidJS 迁移已交付(见 §10,
> 推翻 §2.3)——与 opencode 的技术栈差异至此为零**。
> 分支 `spike/bun-opentui-migration`。
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

## 6. P0 spike 实测结果（2026-08-07，darwin-arm64 / Bun 1.3.14 / Node 24.18 与 26.7）

**结论：GO。** 四项验证全部通过，且两项发现比预期更有利。

### 6.1 P0-1 Bun 冒烟：通过，无 Bun 特有回归

- `bun dist/cli.js`：--help / doctor 全流程正常——provider HTTP 探测、
  **gopls LSP 真握手（子进程 spawn，108ms）**、会话存储均工作。
- `-p` 管道端到端（DeepSeek 真实调用）：stdout/stderr 分流正确，exit 0。
- TUI 在 PTY 下渲染完整（横幅+输入框），双 ctrl+c 正常退出（Node/Bun 行为一致）。
- vitest 622 用例：Bun 与 Node 失败集同构（本机全量跑均有超时型 flaky，
  单独跑同一用例两边一致失败/通过）——**零 Bun 特有失败**。

### 6.2 P0-2 OpenTUI 原型：通过，性能远超需求

- ScrollBox 时间线 + 底部 input：300 条流式追加（20ms/条）elapsed 6.9s
  ≈ 理论 6s，**无积压**；alternate screen 进出干净（?1049h/l 均确认）。
- 定量压测（createTestRenderer，追加一条的端到端耗时,含 React reconcile
  + yoga 布局 + native 渲染）:
  **N=300: 1.7ms · N=1000: 2.8ms · N=3000: 7.9ms**——线性增长,3000 条
  仍在 60fps 预算内。**虚拟化从"P2 必做"降级为"5k+ 条的优化项"**
  (mojocode 有 compaction,实际时间线极少到该量级)。
- **重大发现:OpenTUI 官方支持 Node runtime**。`@opentui/core` exports 带
  `node` 条件(index.node.js),原生层走 optionalDependencies 平台包
  (8 平台齐,含 win32-arm64)。实测 **Node 26.7 + `--experimental-ffi`
  完整跑通原型**,与 Bun 表现一致(Node ≤24 无 node:ffi,不可用)。
  ⇒ **渲染器迁移与 Bun 解耦**:P2 不再依赖 P1,可保 npm+Node 分发
  (engines ≥26.1 + bin 注入 flag),Bun 单二进制退为分发优化。
  Node 26 于 2026-10 转 LTS。

### 6.3 P0-3 UI 测试：通过，官方工具即 ink-testing-library 对等物

- `@opentui/core/testing` 的 `createTestRenderer`:mockInput.typeText/
  pressEnter 模拟键盘、waitForFrame 帧断言、captureCharFrame ≈ lastFrame(),
  2 个测试 180ms 跑完。13 个 UI 测试文件的迁移路径明确,风险 #2 解除。
- 两个必须记住的坑:
  1. **React 19 首次 commit 是异步的**——render 后要 `await setTimeout(0)`
     再 renderOnce(),否则 waitForFrame 见 scheduler 空闲会立即放弃;
  2. **stickyScroll 语义是"粘住当前所在的边"**,初始在顶部就粘顶;
     自动跟随底部要配 `stickyStart="bottom"`(用户上滚自动解粘,
     `_hasManualScroll` 路径)——这正是流式时间线要的语义。

### 6.4 P0-4 单二进制：通过

- `bun build --compile dist/cli.js`(Ink 版):**67MB**,热启动 **0.11s**
  (Node 版 0.41s,快约 4 倍),doctor 与 -p 全链路正常。
- OpenTUI 原型同样 compile 通过(**72MB**,原生 Zig dylib 自动打进 bunfs,
  PTY 下完整跑通)。
- 两个待处理小项:ink 动态 import `react-devtools-core` 需 stub 或装
  devDependency 才能 bundle;$bunfs 里读不到 package.json,版本号需
  build-time define 注入。

### 6.5 对规划的修订

- **P1 与 P2 的依赖关系解除**(§6.2):两条独立可交付的线——
  P1「Bun 单二进制分发」(维持 Ink)与 P2「OpenTUI 渲染器」(可跑在
  Node 26+ 或 Bun 上)。先后皆可,亦可只做其一。
- P2 的虚拟化工作量下调;测试重建工作量下调(官方 testing 可用)。
- 风险表 #2(测试)解除;#4(Bun 子进程)解除;#1(0.x API)与
  #3(scrollback 取舍)不变,仍是 P2 动工前的决策点。
- spike 产物在 scratchpad(prototype/stress/ui.test/perf.test/proto-bin),
  未入库;本仓库工作树未被 spike 污染。

## 7. P1 交付记录（2026-08-07,Bun 1.3.14）

按 §6.5 修订后的独立路线交付:**npm 包保持纯 JS 不动**(dist/cli.js + 系统
Node,零变化),单二进制作为并行分发线新增。最终形态与 §1.4 的「npm 壳」设想
不同——经权衡选择两线并存,npm 用户无感知。

### 落地内容

- **版本注入**(`src/config/version.ts`):`MOJOCODE_BUILD_VERSION` 由
  `--define` 编译期替换,`typeof` 守卫让 Node/tsup 路径零影响;
  `packageRoot()` 二进制模式退回 `dirname(process.execPath)`;新增
  `isCompiledBinary()`。
- **构建脚本**(`scripts/build-binaries.ts`,`npm run build:bin`):
  `Bun.build()` compile API 交叉编译 6 平台(darwin-arm64/x64、
  linux-x64/arm64/x64-musl、windows-x64),入口复用 tsup 产物 dist/cli.js;
  tar.gz/zip 归档(内含平名 `mojocode(.exe)`)+ SHA256SUMS。
  **§6.4 的 devtools 坑实测修正**:`--external react-devtools-core` 不可行
  ——compile 单文件打包会内联动态 import,external 变成启动期顶层依赖直接
  崩;必须用 onResolve/onLoad plugin 替换成空模块。
- **doctor 运行时感知**(`src/app/doctor.ts`):`node` 检查在
  `process.versions.bun` 存在时显示 Bun 版本、跳过 Node 最低版本判断
  (runtime 打包在二进制里,系统 Node 无关);`install` 检查标注单二进制;
  升级提示指向 GitHub Releases 而非 `npm i -g`。check id 契约未动。
- **install.sh**:平台探测(含 musl)→ Releases 下载 → sha256 校验 →
  `~/.local/bin`。Windows 手动下载 zip。
- **CI**(从零新建 `.github/workflows/`):`test.yml` = Node 20/24 矩阵
  (typecheck + vitest)+ bun-smoke(编 linux-x64 断言注入版本、doctor
  --json 断言 Bun runtime、`bun x vitest run` 全量);`release.yml` =
  `v*` tag 全平台编译挂 Releases 草稿。npm 发布仍手动。

### 实测数据(darwin-arm64)

- 二进制 64.8MB(tar.gz 22.4MB),单平台编译 0.1-0.2s,6 平台全量 + 归档
  约 40s(首次含下载各平台 bun runtime)。
- `--version` 正确输出注入版本(裸 dist/cli.js 在 $bunfs 下会退化成
  0.0.0-dev,已由 CI 断言锁住)。
- doctor 无凭据环境按设计 exit 1(API key fail),CI smoke 用假 key +
  `--offline` 取 exit 0。

## 8. P2 交付记录(2026-08-07,OpenTUI 0.5.1 / Bun 1.3.14)

渲染器迁移完成:Ink 7 全部移除,TUI 运行在 OpenTUI alternate-screen 全屏,
`/focus` 三档折叠随本阶段一并落地。核心与 `-p` headless 零改动。

### 架构落点

- **适配层 `src/ui/kit.tsx`**:Ink 形状的 Box/Text/useInput/useApp/render 包住
  OpenTUI。组件层只改 import,JSX/键盘逻辑原样保留;上游 0.x 破坏性变更
  收敛到一个文件。三个抹平的语义差异:
  1. `<text>` 不解析 ANSI(探针①实测)→ `ansi-spans.ts` SGR 解析器把
     markdown/高亮/diff/表格的 ANSI 输出转 `<span>`;39/49 =「继承外层」,
     与 chalk 嵌套语义一致,Diff 背景高亮直接存活;
  2. 嵌套 `<Text>` 按 context 自动降为 `<span>`(上游 #438);
  3. **同批可打印字符合并为一次 input 派发**(Ink 的 stdin-chunk 语义)——
     OpenTUI 逐字符同步连发会让闭包旧 state 覆盖前字,快速输入丢字(实测)。
- **时间线**:`<Static>` → `<scrollbox stickyScroll stickyStart="bottom">`;
  粘底跟随、上滚解粘。布局必须 flexGrow+flexShrink+flexBasis:0+minHeight:0
  四件套(Yoga 裸默认 shrink=0,内容超高会把底部输入区顶出屏幕,探针②)。
  性能:TimelineEntry memo + renderMarkdownAnsi 按 (key,width) LRU(md-cache)。
- **删除清单全量执行**:staticEpoch、resize 200ms settle 重放、4 处
  `\x1b[2J\x1b[3J\x1b[H`、RESERVED_ROWS 高度预算——共约 120 行 hack 消失,
  resize 由渲染器天然处理。
- **运行时门 `src/app/runtime.ts` + tsup `splitting:true`**:TUI 是
  `import('./ui/tui.js')` 懒加载 chunk,dist/cli.js 零 FFI 引用;Bun 直跑,
  Node≥26.1 自动重执行注入 `--experimental-ffi`,老 Node 得到指引,
  `-p`/子命令保持 Node 20。
- **退出 dump `src/ui/transcript.ts`**:alt screen 内容随退出消失,时间线
  以带色纯文本写回主屏,接在原生 scrollback 之后(实测含 CJK 完好)。
- **/focus**(`src/ui/focus.ts`):full/compact/result,ctrl+o 循环、
  `/focus <mode>` 落盘。铁律——user/assistant/error/banner 与全部 notice
  任何档位不隐藏(/doctor 等命令的回执正是 info 提示)(Claude Code #50894 的教训),tests/focus.test.ts 锁死。

### 测试与工具链

- 双测试线:`npm test` = Node 跑核心 34 文件 521 用例;`npm run test:ui` =
  `bun --bun x vitest`(必须 `--bun`,否则 shebang 落回 Node)跑 tests/ui
  15 文件 155 用例——13 个旧 ink 测试全部移植(唯一删除项:resize 重放
  测试,机制已不存在),harness 为 tests/support/otui.tsx。
- 三个踩过的坑:① vitest 需 `resolve.conditions: ['bun']` 才拿到
  @opentui 的 bun 实现;② `ssr.resolve.conditions` 是整组替换,丢掉
  module/import 会把依赖解析进 CJS;③ zod 的「命名空间再导出 z」绑定在
  该组合下丢失,alias 到 index.cjs 解决(见 vitest.ui.config.ts 注释)。
- 交叉编译:8 个 `@opentui/core-<platform>` 以 `--force` 装成 devDeps
  (CI `npm ci --force`);Bun 按 target 消除平台死分支,linux 目标另需
  define `process.env.OPENTUI_LIBC` 钉死 libc,否则 glibc+musl 双库同捆
  (+18MB,实测)。

### 实测数据(darwin-arm64)

- 二进制 74.3MB(P1 Ink 版 64.8MB,+9.5MB = OpenTUI 原生库 + web-tree-sitter);
  linux-x64 119MB。6 平台全部编译、归档、校验通过。
- PTY 全链路:alt screen 进出干净、CJK 输入渲染正确、双 ctrl+c 退出、
  ctrl+o 档位切换、退出 dump 落主屏——npm+Bun 与单二进制两条路径均验证。
- `-p` 真实调用在系统 Node 22 正常(cli 主包无 FFI 依赖)。

### 遗留与观察项

- CJK 上游缺陷(#799 折行、#479 滚动乱码)在探针与冒烟中未复现,但上游
  自认宽字符模型未完工——真实长会话使用中留意,必要时 `OPENTUI_FORCE_WCWIDTH`。
- 文本选择复制:鼠标被 TUI 接管,原生拖选需 shift/option(README 已注明);
  OSC52 集成留作后续。
- 消息导航(opencode 的按消息跳转)未做,scrollbox 子项已按条目建模,
  后续可加。

## 9. 进程模型迁移交付记录(2026-08-08)

§2.4 当时把 client-server 分离列为「不在本次范围」;应后续决策,本阶段把进程
模型也对齐 opencode:**TUI 默认是瘦客户端**,启动时拉起受管 `serve --managed`
子进程(agent 核心、工具、MCP、LSP、会话存储全在 server 侧),经 REST + SSE
通信。`-p` headless 刻意保持单进程(管道语义、零 HTTP 开销);
`MOJOCODE_NO_SERVER=1` 是单进程逃生口(UI 测试也走它的路径)。

### 架构落点

- **窄腰接口 `src/app/session-handle.ts`**:枚举 TUI 真正消费的 Session 成员
  (从 App.tsx 实测 122 处访问收敛而来)。本地 `Session` 结构性满足;
  远程会话由 `src/client/remote.ts` 镜像。App.tsx 只动了 11 处:
  `switch`/`inject`/`steer` 一律 `await`(类型 `T | Promise<T>`),
  `/think` 的直接改字段收编为 `session.setReasoningEffort()`,
  `/doctor`、`/model` 列表收编为 `session.doctor()` / `session.listModels()`
  (凭据只存在于 server 侧,顺带清掉了 UI 对 `session.lsp` 的触碰)。
- **协议 `src/server/protocol.ts`**:三类下行消息——AgentEvent 原样转发
  (error 的 Error 拆装)、state 快照(client 一切同步读取的数据源,
  变化检测剔除 elapsedMs/sentAt 等易变字段)、call-result(长任务回执)。
  provider/config 过线前抹除全部凭据。
- **server `src/server/serve.ts`**:node:http,零新依赖,无 FFI(Node ≥ 20)。
  只绑 127.0.0.1 + 全请求 Bearer token(能执行 bash 的 localhost 服务必须挡
  浏览器盲发 POST);token 经环境变量传子进程,不走 argv。授权走
  PermissionBroker:gate 的 ask 落在 server,请求经 bus 事件(SSE)到达
  client,决定经 `POST /permission` 回来——与本地模式的 emit→ask 顺序同构。
- **client `src/client/remote.ts`** 的四个关键设计,都是踩过再修的:
  1. `run`/`goalRun`/`compact` 是 **deferred**:POST 立即 ack,完成经 SSE
     call-result 兑现 promise——长连接会被 undici 的 300s 超时斩断;
  2. `connectRemote` 必须**等首条 SSE 连接就位才返回**——早返回时紧跟的
     事件广播给零个客户端,永久丢失(实测:permission 往返在快路径下 100%
     超时,debug 脚本因多了 300ms 延迟而侥幸通过);
  3. 所有 RPC 经**内部队列串行化**:App 存在 `goal.set` 紧跟 `goal.run`
     这类顺序依赖,两条 fetch 并发可能乱序;
  4. **乐观运行标志**:ack 与 state 推送之间 isRunning 镜像滞后一个来回,
     期间 esc 会误开回退选择器;ack 即置位,首见 server 报 running 或任务
     完成时清除。
- **受管子进程生命周期**(`src/app/server-launch.ts` + serve 的 --managed):
  stdout 单行 JSON 握手;stderr 握手前透传(配置警告、MCP 失败)、握手后
  存尾部环形缓冲;退出三重保障——TUI dispose 发 shutdown RPC、父进程退出
  即 stdin EOF、**ppid 看门狗兜底**(实测 Bun 下父进程被 SIGKILL 后 stdin
  'end' 不触发,留过孤儿)。
- **外部接入**:`mojocode serve` 独立运行打印地址与 token,
  `MOJOCODE_SERVER_TOKEN=<t> mojocode --attach <url>` 连接;attach 的 TUI
  退出不关别人的 server(ownsServer 区分)。

### 测试与验证

- `tests/server.test.ts`(Node 车道,10 用例):真 HTTP + 真 SSE + 假 Session,
  覆盖镜像初始化与凭据抹除、事件过线与 Error 复原、state 推送驱动 todos、
  deferred ack/完成、授权往返、回退链路、ProviderSwitchError 类型复原、
  401 鉴权、调用顺序保序。全量回归:核心 549 + UI 167 全绿,typecheck 干净。
- PTY 端到端(Bun,真实 DeepSeek 往返):TUI 自动拉起受管 server → 流式
  回复经 SSE 渲染 → footer 上下文计数(step-end)→ 双 ctrl+c 退出 →
  时间线 dump + resume 提示(会话 id 来自 server 侧 store)→ 无孤儿进程。
  期间发现并修复上文的 SSE 时序与孤儿两个 bug。
- 冒烟脚本教训:expect 用 `sleep` 等待时不读 PTY,缓冲区憋满会让 TUI 阻塞、
  日志只剩尾巴——要用超时匹配块持续排水。

### 代码审查后的修复(2026-08-08)

client-server 层被审出 6 处真问题,均已修复并补了回归:

- **提交路径的未捕获 rejection**(最严重):`handleSubmit` 的 void 异步 IIFE 里,
  `inject`/`steer`/`run` 变成 RPC 之后任何 server 抖动都会 reject,Node ≥20
  直接掀掉 TUI。`/init`、`/plan`、`/goal` 三处早有 `.catch`,唯独这条主路径
  在方法转异步时被漏掉;`/think` 的 `setReasoningEffort` 同理。
- **乐观运行标志会永久锁死**:标志原先在 ack 的 `.then` 里置位,而 server 的
  `Agent.run` 有立即返回路径——call-result 可能先于 ack 落地,于是
  「finally 清标志 → ack 置回 true」再无人清除,isRunning 恒真、会话废掉。
  改为发起前同步置位。回归测试手写了一个**故意乱序回执**的最小 server
  (环回下真 server 复现不出这个顺序)。
- **授权请求只广播一次**:没有客户端在场的那一刻(断线、`--attach` 连上
  跑到一半的 server)请求就永远丢了,gate 那边一直 await = 整轮挂死。
  server 侧改为新连接重放待决请求,client 侧补了 asker 注册前的排队。
- **MCP 凭据未抹除**:`mcpServers.*.env` / `.headers` 是 GITHUB_TOKEN、
  Authorization 的常规落点,原先原样过线(`serve --host <非环回>` 是支持用法)。
- **dispose 可能卡住**:shutdown 走同一条串行队列且 fetch 无超时,前面排着
  慢调用时用户面对的是冻住的终端;改为 2s 超时后放手(还有 stdin EOF 与
  ppid 看门狗兜底)。
- **每条事件都全量序列化配置**:变化检测省的只是广播,`computeState +
  snapshotKey` 本身挂在 text-delta 上就是每轮几千次全量 stringify;
  纯流式事件现在直接跳过重算。

最后一处缺口(断线丢事件)随后以 **SSE 标准的断点续传**彻底修复:每条
event / call-result 帧带单调递增 `id:`,server 维护重放环形缓冲(1000 条 /
4MB 双重封顶——delta 多而小、工具输出可能巨大,单一上限都不够),重连的
client 以 `Last-Event-ID` 无缝续上。这同时治了一个比丢时间线更严重的连带
问题:断线窗口里落地的 call-result 一旦丢失,client 侧 pending 的 run
promise 永不 settle,状态行常亮。只有缓冲滚过头 server 才发 `gap` 认输,
client 那时才告警「记录不完整」并刷新镜像;待决授权请求仅在非无缝路径
重放(无缝续上时确认框还在屏幕上,再发一遍会让用户被问两次)。两条路径
(无缝 / gap)的回归测试都做了双向验证(打掉机制 → 超时失败;恢复 → 通过)。

### 与 opencode 的剩余差异(§10 之前)

至此三层对齐:渲染引擎(OpenTUI)、分发(Bun 单二进制)、进程模型
(server + 瘦客户端)。剩余差异:组件框架(React)与消息级导航等功能项。

## 10. 组件框架迁移交付记录(React → SolidJS,2026-08-08)

§0 当时判定"保 React 即可对齐基础核心栈";应后续决策,本阶段把最后一层也
对齐:全部 UI 迁至 `@opentui/solid` + solid-js 1.9.12(opencode 同款同版),
React/`@opentui/react` 依赖清零。核心零改动(它本来就不认识 UI 框架)。

### 工具链(最曲折的部分)

- **Solid JSX 必须走 babel**(dom-expressions 的 universal 变换,esbuild
  编译不了):tsup 用 esbuild-plugin-solid,vitest 两条车道共用自写的
  `vitest.solid.ts` 内联插件——**刻意不用 vite-plugin-solid**,它测试模式
  注入 jsdom + 往 SSR 解析集塞 `browser` 条件,Bun fork worker 启动即崩。
- **solid-js 的 server 桩陷阱**(全程最隐蔽的坑):裸 `solid-js` 在 Node 的
  `node` 条件与 Bun 的 `worker` 条件下都解析到 dist/server.js——SSR 桩,
  onMount/createEffect 全是空实现,**首帧正常、事件订阅静默失效**。上游
  `@opentui/solid` 的 bun 变体依赖官方 Bun 加载器插件在运行期偷换文件内容,
  我们的分发产物不带那层。解法三件套:tsup 的 renderChunk 把产物里的说明符
  改写为 `solid-js/dist/solid.js`(用户 esbuild 插件排在 tsup 的 external
  插件之后,onResolve 层面改写轮不到);`noExternal: ['@opentui/solid']` 把
  **node 变体**(预钉客户端构建)冻进 TUI chunk;vitest 两个别名钉到同一
  文件。双实例 = 信号建在 A、效果建在 B,更新永不追踪——单实例是响应式
  能工作的前提。
- tsconfig:`jsx: preserve` + `jsxImportSource: "@opentui/solid"`。

### 移植与踩坑

kit 保持 Ink 形状 API,组件层 JSX 结构基本原样,状态机械转换
(useState→createSignal、useRef→普通变量、useMemo→createMemo/函数、
React.memo→删除)。五个 Solid 特有的坑,全部实测踩到再修:

1. **`children()` 助手是急切求值**:嵌套 `<Text>` 在外层 Provider 挂载前就
   运行,读到 context=false 渲染成 `<text>`,被外层拒收崩溃。解法:children
   解析挪进 Provider 内的独立组件(React 天然延迟渲染,没这问题)。
2. **span(TextNode)样式只认 `style` prop**:上游 setProperty 对 TextNode
   只处理 href/style 两个键,直接的 fg=/bg= **静默忽略**——文本落回默认白。
   最初的断言(fg.r > 120)被白色 255 假阳性糊弄,后来收紧为"红高绿低"。
3. **effect 在两次 set 之间同步运行**:粘贴图片时"图片入 map"与"占位符入
   文本"分开提交,修剪 effect 在间隙里把刚存的图片当"无占位符"清掉
   (React 的自动批处理掩盖了这个时序)。解法:`batch()`。
4. **props 不可解构 / 派生值必须是函数**:全部组件按此纪律重写;
   `useTerminalSize` 改为返回 getter 对象,解构即失去响应。
5. **`/lang` 没有"整树重渲染"可用**:静态文案(占位符、提示、footer 标签)
   创建后不会随 locale 变。解法:信号全部活在组件外层,JSX 体经
   `<Show keyed>` 按 locale 重挂载——文案重新求值,状态一个不丢。

收益兑现:React 时代的 flushSync/valueRef/cursorRef 旧闭包补丁全部删除
(处理器读信号永远是当前值);TimelineEntry 的 React.memo 删除(条目不可变
+ `<For>` 按引用复用,细粒度更新天然零重渲染);测试 harness 删掉 act() 与
异步首帧等待(Solid 首帧同步)。

### 验证

- 549 核心 + 171 UI 测试全绿(18 个 UI 测试文件全部移植,net 数量还多了
  kit-smoke 一个);typecheck 干净;dist 产物零 React 引用,solid-js 22 处
  import 全部钉在客户端构建。
- PTY 端到端两条路径(npm+Bun 与 74→77MB 单二进制):真实 DeepSeek 往返、
  流式渲染、思考行、双 ctrl+c、退出 dump、resume 提示、无孤儿 server。
- 至此与 opencode 的技术栈差异为**零**(运行时、渲染引擎、组件框架、进程
  模型、分发全部同款);剩余差异只在功能项(消息级导航等)。
