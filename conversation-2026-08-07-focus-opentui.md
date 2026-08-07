# 对话导出：输出折叠（/focus）评估 → opencode 技术栈调研 → 迁移 P0 spike

> 日期：2026-08-07。参与者：hongbin × Claude Code（Opus 5 / Fable 5）。
> 本文件是对话的整理导出，按轮次记录每个问题与结论。
> 相关产物：分支 `spike/bun-opentui-migration`、`docs/opentui-migration.md`。

---

## 1. 「评估输出折叠功能：开关隐藏任务过程时间线，只显示回答结果。先不改代码」

调研了 `src/ui/`（Timeline/App/types）、`src/core/events.ts`、`src/app/headless.ts`。结论：

- 值得做，纯渲染层策略，核心事件 / SessionStore / replayTimeline 都不用动。
- **硬约束：Ink `<Static>` 单向**——写进终端回滚缓冲后擦不掉。两种实现：
  - **A. 入口过滤**（在 `push()` 按开关丢弃）：~20 行，"从现在起生效"；
  - **B. 保数据 + 渲染期过滤**：切换时清屏 + `staticEpoch++` 重放，可追溯切换。
- 折叠范围需精确：`user/assistant/error/banner` 绝不隐藏；`exit_plan` 方案正文、
  `todo` 清单是结果不是噪音；建议三档 `full/compact/result` 而非布尔开关。
- 动态区（流式预览、进行中工具行、StatusLine）本来就不进回滚缓冲，不该动。
- 命名冲突：`/compact` 已被上下文压缩占用。

## 2. 「方案 B 会丢失会话吗？」

不丢。`resetTimeline` 只碰 React state 与屏幕，不碰 `agent.history` 与
SessionStore（对比 `/clear` 才会 `newSession()`）。真实代价是 `\x1b[3J` 清终端
回滚缓冲，以及：reasoning 正文本来就只存耗时无法还原；长会话重放有全量
renderMarkdownAnsi 的卡顿（需渲染缓存）。

## 3. 「折叠时要能看到思考过程和当前任务描述，能支持吗？」

能，零成本——这两样本来就在动态区：`activeReasoning` 5 行尾部窗口、工具行
`Task(描述)` + `recentCalls` 轨迹 + StatusLine。折叠动的是留痕（Static），
不是可见性（动态区），两者正交。折叠档反而应把预览从 5 行放大到 12 行。
发现 `task-progress.description` 字段现成但 UI 未用。

## 4. 「我倾向于可以随时切换开关」

定为方案 B。要点：

- `items` 本来就全量保留，B 的增量只是切换时重放；
- 切换时 `staticEpoch++` 是**正确性要求**（Static 内部记"已渲染到第 N 条"，
  不换 key 顺序会错乱）；
- `2J+3J` vs 只 `2J` 的 scrollback 取舍；resizing 期间忽略切换；
- markdown 渲染按 `item.key + columns` 缓存；
- ctrl+o 会话内二态切换，`/timeline <mode>` 写 config（仿 statusBar 范式）。

## 5. 「开始规划任务吧」

产出 10 任务分解（T1 config → T10 测试），三档过滤矩阵、依赖图、
待定项（3J 清 scrollback）。

## 6. 「需求与 Claude Code 的 /focus 一样，重新调研规划」

实查本地 Claude Code 2.1.224 二进制 + 社区资料：

- `/focus`（v2.1.110+）与 ctrl+o 互为反向：精简阅读视图 vs verbose 全量。
- **二进制原话**：“Focus view needs the fullscreen renderer. Run /tui fullscreen
  to switch (this restarts and resumes your session)”——Claude Code 在滚动渲染器
  下直接不提供 focus，且切换渲染器要重启会话。印证了 `<Static>` 单向的判断。
- **已知缺陷** [issue #50894]（High severity）：focus 连工具调用之间的
  assistant 文本一起隐藏，用户错过答案与警告且无从知晓。根因是靠语义猜
  "状态更新 vs 答案"。**mojocode 有 `kind` 标签不用猜**——assistant 恒可见
  应成为铁律并用测试锁死。
- 方案修订：连续隐藏段折叠成 `⋯ N 个工具调用已折叠` 占位行（须丢弃尾部
  未闭合段，Static append-only 语义）；命名对齐 `/focus`。

## 7. 「这个项目能不能也做成 fullscreen？」

- Ink 7.1.1 内置 `render({ alternateScreen: true })`，但那只是工作量的 1/4：
  alt screen 无 scrollback，`<Static>` 必须废掉，需自建受控 viewport、
  VT mouse tracking 滚轮、虚拟化。
- 连带损失：退出后终端不留会话、shift 才能选择复制、Windows conhost 滚轮。
- **关键判断：/focus 不需要 fullscreen**（Claude Code 绑定两者是历史原因）。
- 建议两阶段：先滚动模式 /focus（~40 行拿 95%），fullscreen 独立立项。
- 用户实测确认：Claude Code `/tui` 切到 default 后 `/focus` 即报需要全屏。

## 8. 「opencode 是怎么做的？它也是输入框在底部？」

- opencode TUI = SolidJS + OpenTUI，**默认 alternate screen 全屏接管**——
  输入框在底部是全屏布局的自然结果。
- 折叠功能叫 `/details`，随时可切，正因为全屏可整屏重画。
- 滚动自己实现（`scroll_speed`、`scroll_acceleration`）。
- 实证警告：Claude Code 切 alt screen 后的无障碍投诉
  [issue #67289]（“Removing scroll-back is disabling, not merely
  inconvenient”）被 Closed as not planned。
- OpenTUI 的 split-footer 模式 ≈ mojocode 现状（底部固定区 + scrollback），
  但同样救不了追溯折叠。

## 9. 「OpenTUI 是什么？」

Anomaly（opencode 团队）自研的终端 UI 框架：Zig 原生渲染核心 + FFI，
React/Solid 双绑定，Yoga 布局，自带 ScrollBox/Code(tree-sitter)/Diff，
无 Ink 的 30fps 上限。当时判断（后被 P0 spike 部分推翻）：依赖
`bun-ffi-structs` 需要 Bun、0.5.1 太早，对 mojocode 门票太贵。

## 10. 「OpenTUI 是开源的吗？」

MIT，monorepo（core/react/solid/keymap/ssh/...），
github.com/anomalyco/opentui。不迁移也可参考其 split-footer 实现思路。

## 11. 「opencode 用的技术方案是什么？」

汇总：HTTP server + TUI 瘦客户端（REST + SSE），TUI 只管表现层；
SolidJS + OpenTUI（Zig FFI）；alternate screen + 自实现滚动；
`/details` 折叠。与 mojocode 逐层对比（进程模型 / UI 框架 / 屏幕模式 /
滚动 / 折叠）。

## 12. 「新建分支，把技术栈迁移到与 opencode 一样的基础核心栈，评估并规划」

建分支 `spike/bun-opentui-migration`，提交 `docs/opentui-migration.md`
（commit 2529f97）。核心发现与决策：

- **用户不需要装 Bun**：opencode 的 npm 包是壳，`bun build --compile`
  单二进制内含 runtime——反对理由被推翻，代价转为多平台构建矩阵。
- **不必迁 SolidJS**：`@opentui/react` 是一等绑定，App.tsx 的状态逻辑可保留。
- **Ink 依赖面窄**：全仓 7 个 API 符号、15 文件 4574 行；唯一无对等物的是
  `<Static>`，替换它就是迁移主体。
- 迁移面数据：node: 内置模块 10 类、8 文件用子进程、13 个 UI 测试文件
  依赖 ink-testing-library（当时判断为最大隐性成本）。
- 规划 P0 spike → P1 runtime → P2 渲染器 → P3 收尾，明确不做：SolidJS、
  client-server 分离。总量 9-15 人天。真正的分叉点（scrollback 取舍）在
  P2 动工前。

## 13. 「开始」——P0 spike 实施（结论 GO，commit a0a819b）

| 项 | 结果 |
|---|---|
| P0-1 Bun 冒烟 | brew 装 Bun 1.3.14；doctor 全流程（gopls LSP 子进程握手 108ms）、`-p` 真实调用、PTY 下 TUI 起停均正常；622 测试 Bun/Node 失败集同构（均为本机超时型 flaky），**零 Bun 特有回归** |
| P0-2 OpenTUI 原型 | ScrollBox 时间线 + 底部 input：300 条流式无积压、alt screen 进出干净；压测 **300/1000/3000 条 = 1.7/2.8/7.9ms/条**，虚拟化降为 5k+ 条可选项 |
| P0-3 UI 测试 | 官方 `createTestRenderer` ≈ ink-testing-library（mockInput/waitForFrame/captureCharFrame），2 测试 180ms。坑①React 19 异步 commit 需先让出事件循环；坑②`stickyScroll` 粘"当前所在边"，跟底要配 `stickyStart="bottom"` |
| P0-4 单二进制 | Ink 版 67MB / OpenTUI 版 72MB（Zig dylib 自动打包），热启动 **0.11s（Node 版 0.41s）**，`-p` 全链路可用。小坑：react-devtools-core 动态 import 需 stub；$bunfs 读不到 package.json 需 build-time 注入版本 |

**改变格局的发现：OpenTUI 官方支持 Node**——exports 带 `node` 条件，实测
**Node 26.7 + `--experimental-ffi` 完整跑通**（Node ≤24 不可用；26 于
2026-10 转 LTS）。⇒ P2 渲染器迁移与 Bun 解耦，P1 与 P2 成为两条独立可
交付的线，可只做其一。

## 当前状态与待决事项

- 分支 `spike/bun-opentui-migration`：2529f97（评估规划）+ a0a819b（spike 报告），工作树干净；spike 产物在 scratchpad 未入库。
- **唯一开放决策**：P2 动工前的 scrollback 取舍（全屏后终端原生回滚消失）。
- 候选下一步：A）P1 Bun 单二进制分发（1-2 天，低风险）；B）P2 OpenTUI
  渲染器 + /focus（5-8 天，主体工程）；C）暂停消化。

## 参考链接

- https://github.com/anthropics/claude-code/issues/50894 （focus 隐藏 assistant 文本缺陷）
- https://github.com/anthropics/claude-code/issues/67289 （alt screen 破坏 tmux scrollback，无障碍回归）
- https://github.com/anthropics/claude-code/issues/61569 （fullscreen 渲染器 SSH 退化）
- https://github.com/anomalyco/opentui / https://opentui.com/docs/core-concepts/renderer/
- https://opencode.ai/docs/tui/ （/details、scroll_speed）
- https://deepwiki.com/anomalyco/opencode/5.1-tui-architecture
