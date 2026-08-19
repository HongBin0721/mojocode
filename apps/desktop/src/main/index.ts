/**
 * Electron main 入口:app 生命周期、窗口、TaskManager 编排。
 *
 * 进程模型:一个任务 = 一个受管 `mojocode serve --managed` sidecar,由
 * TaskManager(src/main/task-manager.ts)统一管理;`--attach <url>` 时唯一
 * 任务连接外部 server,token 取自 MOJOCODE_SERVER_TOKEN(缺失则报错退出——
 * 不接受明文无鉴权连接)。
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { resolveRuntime } from './resolve-runtime.js';
import { createTaskManager, type TaskManager } from './task-manager.js';
import { createGuiPrefs } from './gui-prefs.js';
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
let manager: TaskManager | undefined;
let quitting = false;

/** GUI 本机偏好(~/.mojocode/gui.json);同步读盘,窗口加载前就绪。 */
const guiPrefs = createGuiPrefs();

/**
 * 管理器就绪信号(deferred):bootstrap 创建 TaskManager 后兑现。IPC handler
 * 在 app ready 就注册,内部 await 它——renderer 加载完成早于首个 sidecar
 * 握手时,invoke 挂起而不是失败。
 */
let resolveManager: (m: TaskManager) => void = () => {};
const managerReady = new Promise<TaskManager>((resolve) => {
  resolveManager = resolve;
});

/**
 * 窗口视觉选项(仅 darwin):隐藏标题栏 + 红绿灯内嵌到内容区。底色是
 * 设计稿的不透明 --color-bg(#161826)——不开 vibrancy:半透明 tint 会让
 * 壁纸透进来把色板染偏,设计稿是纯色形态。非 darwin 保持原生框。
 */
function windowVisualOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hidden',
    // 44px 标题栏(设计稿):红绿灯垂直居中 (44-12)/2 = 16。
    trafficLightPosition: { x: 22, y: 16 },
    backgroundColor: '#161826',
  };
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // 三栏最紧凑 = 侧栏 264 + 中间区下限 360 + 右面板下限 240,留点余量。
    minWidth: 880,
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
  guiPrefs.flush();
  await manager?.disposeAll();
  manager = undefined;
  app.quit();
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

  const next = createTaskManager({
    runtime: resolveRuntime(),
    attach,
    target: {
      // 只推给活着的窗口;重载窗口(新 webContents)后靠 renderer 重新 subscribe 拿快照。
      send: (channel, ...args) => {
        const contents = mainWindow?.webContents;
        if (contents && !contents.isDestroyed()) contents.send(channel, ...args);
      },
    },
  });
  manager = next;
  // 先把首个任务建起来再兑现 managerReady:renderer 的 subscribe 是一次性的,
  // 若在任务就绪前返回,它拿到的是空的 live 列表,而此后没有任何东西会再触发
  // 一次全量同步(空闲会话不产生 bus 事件)。
  await next.createTask({ root });
  resolveManager(next);
};

app.whenReady().then(
  async () => {
    // IPC handler 必须此刻注册:renderer 加载完成可能早于首个 sidecar 握手
    // (spawn + MCP bootstrap 要几秒),晚注册的话 subscribe 会打到「No
    // handler registered」。handler 内部 await 管理器就绪。
    ipcMain.handle(IPC_CHANNELS.subscribe, async () => (await managerReady).subscribe());
    ipcMain.handle(IPC_CHANNELS.rpc, (_event, request, taskId) =>
      managerReady.then((m) =>
        m.dispatchRpc(request as RpcRequest, taskId as string | undefined),
      ),
    );
    ipcMain.handle(IPC_CHANNELS.taskCreate, (_event, opts) =>
      managerReady.then((m) => m.createTask(opts as { root: string; resume?: string; fork?: boolean })),
    );
    ipcMain.handle(IPC_CHANNELS.taskOpen, (_event, sessionId) =>
      managerReady.then((m) => m.openTask(String(sessionId))),
    );
    ipcMain.handle(IPC_CHANNELS.taskClose, (_event, taskId) =>
      managerReady.then((m) => m.closeTask(String(taskId))),
    );
    ipcMain.handle(IPC_CHANNELS.taskFocus, (_event, taskId) =>
      managerReady.then((m) => m.focusTask(String(taskId))),
    );
    // main 本地能力:Finder 显示 / 系统默认程序打开(右键菜单与 diff 菜单)。
    ipcMain.handle(IPC_CHANNELS.revealPath, (_event, path) => {
      shell.showItemInFolder(String(path));
    });
    ipcMain.handle(IPC_CHANNELS.openPath, async (_event, path) => {
      await shell.openPath(String(path));
    });
    // GUI 偏好:snapshot 是 preload 启动路径的 sendSync,必须先于窗口加载注册。
    ipcMain.on(IPC_CHANNELS.prefsSnapshot, (event) => {
      event.returnValue = guiPrefs.snapshot();
    });
    ipcMain.on(IPC_CHANNELS.prefsSet, (_event, key, value) => {
      guiPrefs.set(key as string, value as string);
    });
    // main 本地能力:目录选择器(添加/导入项目)。
    ipcMain.handle(IPC_CHANNELS.pickDirectory, async () => {
      if (!mainWindow) return undefined;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    });
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
  // Cmd+Q / 系统关机路径:先拦下,走统一 teardown(全部任务 dispose → quit)。
  if (quitting) return;
  event.preventDefault();
  void teardown();
});
