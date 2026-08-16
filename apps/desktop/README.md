# mojocode 桌面客户端(GUI)

mojocode 的 Electron 桌面前端,与 TUI 并存:agent core、工具、权限体系全部
住在 `mojocode serve --managed` 子进程里,GUI 只是一个薄客户端(REST + SSE,
与 TUI 的远程模式同一条协议)。本目录是**独立包**(不进根 workspaces),
不影响根目录的构建、测试与发布。

## 架构

```
mojocode serve 子进程(agent core + tools + MCP + store)
   ↑ SSE/fetch(connectRemote,Electron main)   ↓ POST /call、/permission
Electron main(spawn-server / RemoteSession 镜像 / bridge / replay)
   ↑ contextBridge(preload,类型化 API)
Renderer(React + zustand:timelineReducer → 组件)
```

- `src/shared/` — IPC 契约(通道、RpcRequest 判别联合、preload API 形状)
- `src/main/` — 进程编排:spawn-server(握手协议镜像自 `src/app/server-launch.ts`)、
  session-service、bridge(事件批量合并 / 状态去重推送 / 权限往返 / RPC 白名单)、
  resolve-runtime(dev 用系统 node,打包用 ELECTRON_RUN_AS_NODE)
- `src/preload/` — contextBridge 暴露 `window.mojocode`
- `src/renderer/` — React 界面(bridge/client.ts 订阅 → zustand store)
- `tests/` — bridge / reducer / 组件测试(独立 vitest 配置)

跨包引用:`@core/*` alias 直接编译仓库根 `src/` 里的纯模块(白名单见
`tsconfig.json` 的 paths 与 `electron.vite.config.ts` 的同名 alias)。renderer
侧新增 `@core/*` 引用前必须确认目标无 Node 依赖(浏览器构建会直接报错——
这本身就是护栏)。

## 开发

前置(每次拉取根仓库新代码后):

```bash
npm run build        # 仓库根目录:sidecar 跑的是 dist/cli.js
```

本目录:

```bash
npm install          # 首次
npm run dev          # 打开窗口,自动拉起受管 server
npm run typecheck    # 两个 tsc project(main/preload/shared + renderer)
npm test             # vitest(bridge / reducer / 组件)
npm run build        # 三端产物 → out/
```

dev 模式的热更边界:renderer 走 vite HMR(改组件/样式即时生效);**main 与
preload 的源码改动当前不会触发自动重建**(electron-vite 的 watch 未覆盖,
产物仍是旧的),改完这两处必须重启 `npm run dev`。preload 加载的是
`out/preload/index.js`,排查下行推送问题时先确认产物时间戳。

常用环境变量:

- `MOJOCODE_CLI_JS` — 覆盖 CLI 入口路径(默认:向上找到仓库根的 `dist/cli.js`)
- `MOJOCODE_NODE_BIN` — 覆盖跑 CLI 的 Node 可执行文件(默认:dev 用系统 node)
- `MOJOCODE_SERVER_TOKEN` — `--attach` 模式的 Bearer token

命令行参数:`mojocode-desktop --root <dir>` 指定工作区(默认 `process.cwd()`);
`--attach <url>` 连接已有 server(token 必须经 `MOJOCODE_SERVER_TOKEN` 提供)。

## 约束

- 不改 agent core、不改 TUI。server 侧只允许只读扩展(如 `listSessions`)。
- token/url 永不进 renderer(state 快照已是脱敏产物);renderer 无 Node 访问
  (contextIsolation + sandbox,preload 只暴露类型化 API)。
- 版本要求:Electron ≥ 37(内嵌 Node ≥ 22,与 CLI 的 engines 对齐);dev 模式
  要求系统 node ≥ 22。
- 打包:electron-builder 骨架(files: out/ + extraResources 携带 `dist/` 与
  `node_modules` 的运行时依赖,`ELECTRON_RUN_AS_NODE=1 process.execPath` 充当
  Node)已验证可行路径,配置在正式分发时落地,当前仅 dev 模式。

## 已实现(M1–M4 + Codex 对齐 M-A/B/C + ZCode 对齐 M-D)

- M1 Electron 壳 + IPC 桥(状态/事件/连接/权限通道,RPC 白名单)
- M2 时间线(timelineReducer 移植自 TUI 的 timeline-controller)+ Composer
  (多行/图片粘贴/中断)+ 中英切换
- M3 审批卡(diff 视图、四档决策、plan 方案卡)
- M4 侧栏(会话列表/resume/new)+ `listSessions` server 扩展 + `--attach`
- M-A Codex 式布局:三层侧栏(项目→环境→thread)、Toolbar(模型/权限徽章 +
  菜单)、`Shift+Tab` 权限循环(复用根 schema 的 nextCycleStep,零新逻辑)、
  `/` 命令菜单(内置 + 技能)
- M-B 代码评审面板(`Cmd/Ctrl+Option+B`):pending 变更列表(git status)+
  按需 diff(带行号)+ **点击行评论**(转 run RPC,运行中注入当前轮);
  server 侧新增只读 `workspaceStatus`/`fileDiff` RPC(src/agent/workspace.ts)
- M-C 时间线 write/edit 卡走 DiffView;窄窗(<960px)面板转覆盖式抽屉
- M-D ZCode 桌面端视觉/布局对齐(规格提取自 ZCode 3.7.7 产物):
  - 窗口:mac 隐藏标题栏 + 红绿灯内嵌 (22,23) + 透明底 + under-window
    vibrancy(`<html>.platform-darwin`);preload 暴露 `platform`
  - 设计令牌全面换为 ZCode 语义命名(--color-*:neutral 灰阶 + sky 品牌,
    层级用白色低透明度叠层表达),仅深色;14px 滚动条/圆角体系(气泡 12、
    输入块 16、菜单 12)
  - 布局:删 Toolbar——权限档/模型选择器迁入 Composer 工具栏,语言/连接
    状态迁入侧栏底部 Settings 菜单;侧栏 264px 可拖宽(264~50vw,双击复位,
    localStorage 持久化)、⌘B 折叠(收起时主区顶部补拖拽浮层)
  - 消息形态:用户消息右对齐气泡(右上 2px 尾巴),助手平铺;流式文本
    fade-in(0.9s ZCode 缓动);会话列宽度改容器查询(<864 全宽 / ≥864
    max-w-4xl / ≥1136 max-w-6xl 居中)
  - 空状态:时段问候(5/9/12/14/18/23 六档)+ 右下 M 水印(底部渐隐)
  - 审批卡:ZCode 编号选项制——数字键直选、↑↓/Tab 移动高亮、Enter 确认,
    「需要权限」标题 + mono 命令行 + 底部键位提示;plan 仍两键
  - Composer:rounded-2xl 外框(focus-within 抬边框换底色)+ 内嵌 textarea
    卡 + 品牌色发送/停止钮;拖入图片变附件(品牌色边框 + 覆盖 pill)


