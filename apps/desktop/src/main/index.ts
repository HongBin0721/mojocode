/**
 * Electron main 入口:app 生命周期、窗口、与 server 的编排。
 *
 * 进程模型(与 TUI 一致):本进程拉起受管 `mojocode serve --managed` 子进程,
 * 经 connectRemote 建立镜像,再由 bridge(src/main/bridge.ts)把镜像暴露给
 * renderer。`--attach <url>` 时连接外部 server,token 取自
 * MOJOCODE_SERVER_TOKEN(缺失则报错退出——不接受明文无鉴权连接)。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createBridge, type Bridge } from './bridge.js';
import { buildReplayItems } from './replay.js';
import { resolveRuntime } from './resolve-runtime.js';
import { startDesktopSession, type DesktopSession } from './session-service.js';
import { IPC_CHANNELS, type RpcRequest } from '../shared/ipc.js';

/**
 * out/main 的目录:兼容 cjs(__dirname)与 esm(import.meta.url)两种产物
 * 格式——electron-vite 对 type:module 包的 main 输出格式随版本演进,这里
 * 不赌其中一种。
 */
const appDir =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

/** 从 argv 捞一个选项值(Electron 会把自己的开关混进 argv,不能按位置取)。 */
const argvValue = (flag: string): string | undefined => {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i]!.startsWith(`${flag}=`)) return argv[i]!.slice(flag.length + 1);
  }
  return undefined;
};

let mainWindow: BrowserWindow | undefined;
let desktop: DesktopSession | undefined;
let bridge: Bridge | undefined;
let quitting = false;

/**
 * 桥就绪信号(deferred):bootstrap/切换工作区创建桥后兑现。切换工作区会
 * 重置 deferred——期间到达的 subscribe/rpc 挂起等新桥,而不是打在已 dispose
 * 的旧桥上(handler 体内读的是 let,调用时自然取到当前的 promise)。
 */
let resolveBridge: (b: Bridge) => void = () => {};
let bridgeReady = new Promise<Bridge>((resolve) => {
  resolveBridge = resolve;
});

/**
 * 窗口视觉选项(ZCode 桌面端同款,仅 darwin):隐藏标题栏 + 红绿灯内嵌到
 * 内容区(22,23),底色透明 + under-window vibrancy——内容层的
 * --color-background-alt 半透明 tint 压在毛玻璃上。非 darwin 保持原生框。
 */
function windowVisualOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 22, y: 23 },
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
  };
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'mojocode',
    show: false,
    ...windowVisualOptions(),
    webPreferences: {
      preload: join(appDir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('ready-to-show', () => mainWindow?.show());
  // 用户关窗 = 退出整个 app(桌面工具形态,不留 dock)。
  mainWindow.on('closed', () => {
    mainWindow = undefined;
    void teardown();
  });
};

const teardown = async (): Promise<void> => {
  if (quitting) return;
  quitting = true;
  bridge?.dispose();
  bridge = undefined;
  await desktop?.dispose();
  desktop = undefined;
  app.quit();
};

/** 拉起 session + 桥(bootstrap 与切换工作区共用),就绪后兑现 deferred。 */
const startBridge = async (
  root: string,
  attach?: { url: string; token: string },
): Promise<Bridge> => {
  desktop = await startDesktopSession({ root, attach, runtime: resolveRuntime() });
  const current = desktop;
  const next = createBridge({
    target: {
      // 只推给活着的窗口;重载窗口(新 webContents)后靠 renderer 重新 subscribe 拿快照。
      send: (channel, ...args) => {
        const contents = mainWindow?.webContents;
        if (contents && !contents.isDestroyed()) contents.send(channel, ...args);
      },
    },
    session: current.session,
    replay: async () => buildReplayItems(current.session),
  });
  next.setConnection('connected');
  bridge = next;
  resolveBridge(next);
  return next;
};

/**
 * 切换工作区:停掉当前受管 sidecar,以新 root 重新拉起,再强推整套镜像
 * (subscribe() 的 target.send 路径:state/replay/connection/sessions)。
 * attach 模式(不拥有 server)与运行中的轮直接拒绝。
 */
let switching = false;
const switchWorkspace = async (root: string): Promise<void> => {
  if (switching) throw new Error('正在切换项目,稍候再试');
  const current = desktop;
  if (!current?.spawned) throw new Error('attach 模式不支持切换项目');
  if (current.session.snapshot.agent.isRunning) throw new Error('先结束或中断当前这轮');
  switching = true;
  try {
    bridge?.setConnection('connecting');
    bridge?.dispose();
    bridge = undefined;
    bridgeReady = new Promise<Bridge>((resolve) => {
      resolveBridge = resolve;
    });
    desktop = undefined;
    await current.dispose();
    const next = await startBridge(root);
    await next.subscribe();
  } catch (error) {
    // 半途失败(新 sidecar 起不来):没有可用会话,提示后整体退出。
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('切换项目失败', message);
    await teardown();
    throw error;
  } finally {
    switching = false;
  }
};

const bootstrap = async (): Promise<void> => {
  const attachUrl = argvValue('--attach');
  const root = argvValue('--root') ?? process.cwd();

  createWindow();
  if (!mainWindow) return;

  let attach: { url: string; token: string } | undefined;
  if (attachUrl) {
    const token = process.env.MOJOCODE_SERVER_TOKEN;
    if (!token) {
      throw new Error('--attach 需要 MOJOCODE_SERVER_TOKEN 环境变量携带 Bearer token');
    }
    attach = { url: attachUrl, token };
  }

  // electron-vite:dev 用 HMR server,build 加载产物。
  if (!process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadFile(join(appDir, '../renderer/index.html'));
  } else {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  }

  await startBridge(root, attach);
};

app.whenReady().then(
  async () => {
    // IPC handler 必须此刻注册:renderer 加载完成可能早于 server 握手(spawn
    // + MCP bootstrap 要几秒),晚注册的话 subscribe 会打到「No handler
    // registered」。handler 内部 await 桥就绪——invoke 挂起而不是失败,
    // renderer 侧无需重试。
    ipcMain.handle(IPC_CHANNELS.subscribe, async () => (await bridgeReady).subscribe());
    ipcMain.handle(IPC_CHANNELS.rpc, (_event, request) =>
      bridgeReady.then((b) => b.dispatchRpc(request as RpcRequest)),
    );
    // main 本地能力:目录选择器(添加项目)与工作区切换(sidecar 重启)。
    ipcMain.handle(IPC_CHANNELS.pickDirectory, async () => {
      if (!mainWindow) return undefined;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle(IPC_CHANNELS.switchWorkspace, (_event, root) => switchWorkspace(String(root)));
    try {
      await bootstrap();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox('mojocode 启动失败', message);
      await teardown();
    }
  },
  () => app.quit(),
);

// 所有窗口关闭即退出(桌面工具语义,macOS 也不留 dock)。
app.on('window-all-closed', () => {
  void teardown();
});

app.on('before-quit', (event) => {
  // Cmd+Q / 系统关机路径:先拦下,走统一 teardown(bridge → session → quit)。
  if (quitting) return;
  event.preventDefault();
  void teardown();
});
