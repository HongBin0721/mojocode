/**
 * 会话服务:把「拉起/连接 server + connectRemote + 退出收尾」收拢成一件事,
 * main/index.ts 只管窗口与 app 生命周期。
 *
 * spawn 与 connect 的参数以依赖注入(spawnServer / connect),测试与将来的
 * 多会话标签(一 sidecar 一会话)都不必改这里。
 */

import { connectRemote, type RemoteSession } from '@core/remote';
import { t } from '@core/i18n';
import type { ServerRuntime } from './resolve-runtime.js';
import { spawnManagedServer, type ServerExitInfo, type SpawnedServer } from './spawn-server.js';

export interface AttachOptions {
  url: string;
  token: string;
}

export interface DesktopSession {
  session: RemoteSession;
  /** attach 模式没有(不拥有 server,退出不发 shutdown)。 */
  spawned: SpawnedServer | undefined;
  dispose(): Promise<void>;
}

export type SpawnFn = (
  runtime: ServerRuntime,
  serveArgs: string[],
  onExit?: (info: ServerExitInfo) => void,
) => Promise<SpawnedServer>;
export type ConnectFn = (options: {
  url: string;
  token: string;
  ownsServer: boolean;
  lostMessage?: string;
}) => Promise<RemoteSession>;

export async function startDesktopSession(options: {
  root: string;
  attach: AttachOptions | undefined;
  runtime: ServerRuntime;
  /** 追加到 serve 的参数(TaskManager 用:`--resume <id>` / `--fork-session`)。 */
  serveExtraArgs?: string[];
  spawnServer?: SpawnFn;
  connect?: ConnectFn;
}): Promise<DesktopSession> {
  const spawnServer = options.spawnServer ?? defaultSpawn;
  const connect = options.connect ?? defaultConnect;

  // sidecar 意外退出的上报链:spawn 的 onExit → notifyServerExit(立即断线,
  // 死因进错误横幅)。计划内退出两道闸都拦:dispose 先置 disposing(此时
  // session.dispose 可能还没把 remote 标成 closed),notifyServerExit 自身
  // 在 closed 后也是无操作。
  let disposing = false;
  let sessionRef: RemoteSession | undefined;
  const onServerExit = (info: ServerExitInfo): void => {
    if (disposing) return;
    const cause = info.code !== null ? `code ${info.code}` : `signal ${info.signal ?? '?'}`;
    // 全量尾部倒给主进程 stderr(dev 的 electron-vite 终端 / 打包态的系统日志),
    // 横幅只带最后几行——50 行塞进时间线没人读。
    process.stderr.write(
      `[mojocode desktop] server process exited unexpectedly (${cause})\n${
        info.stderrTail.length ? `${info.stderrTail.join('\n')}\n` : ''
      }`,
    );
    const tail = info.stderrTail.slice(-8).join('\n');
    sessionRef?.notifyServerExit(
      `${t('notice.serverExitedApp', { code: cause })}${tail ? `\n${tail}` : ''}`,
    );
  };

  let spawned: SpawnedServer | undefined;
  let url: string;
  let token: string;
  if (options.attach) {
    url = options.attach.url;
    token = options.attach.token;
  } else {
    spawned = await spawnServer(
      options.runtime,
      ['--cwd', options.root, ...(options.serveExtraArgs ?? [])],
      onServerExit,
    );
    url = spawned.url;
    token = spawned.token;
  }

  const session = await connect({
    url,
    token,
    ownsServer: spawned !== undefined,
    // 断线文案用 GUI 措辞:「重启 TUI」在这里指错了对象。
    lostMessage: t('notice.serverLostApp'),
  });
  sessionRef = session;
  return {
    session,
    spawned,
    dispose: async () => {
      disposing = true;
      await session.dispose(); // ownsServer 时发 shutdown(限时,见 remote.ts)。
      if (spawned) await spawned.waitExit();
    },
  };
}

const defaultSpawn: SpawnFn = (runtime, serveArgs, onExit) =>
  spawnManagedServer({
    nodeBin: runtime.nodeBin,
    cliJs: runtime.cliJs,
    serveArgs,
    runAsNode: runtime.runAsNode,
    onExit,
  });

const defaultConnect: ConnectFn = (options) => connectRemote(options);
