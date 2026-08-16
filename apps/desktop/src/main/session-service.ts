/**
 * 会话服务:把「拉起/连接 server + connectRemote + 退出收尾」收拢成一件事,
 * main/index.ts 只管窗口与 app 生命周期。
 *
 * spawn 与 connect 的参数以依赖注入(spawnServer / connect),测试与将来的
 * 多会话标签(一 sidecar 一会话)都不必改这里。
 */

import { connectRemote, type RemoteSession } from '@core/remote';
import type { ServerRuntime } from './resolve-runtime.js';
import { spawnManagedServer, type SpawnedServer } from './spawn-server.js';

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

export type SpawnFn = (runtime: ServerRuntime, serveArgs: string[]) => Promise<SpawnedServer>;
export type ConnectFn = (options: { url: string; token: string; ownsServer: boolean }) => Promise<RemoteSession>;

export async function startDesktopSession(options: {
  root: string;
  attach: AttachOptions | undefined;
  runtime: ServerRuntime;
  spawnServer?: SpawnFn;
  connect?: ConnectFn;
}): Promise<DesktopSession> {
  const spawnServer = options.spawnServer ?? defaultSpawn;
  const connect = options.connect ?? defaultConnect;

  let spawned: SpawnedServer | undefined;
  let url: string;
  let token: string;
  if (options.attach) {
    url = options.attach.url;
    token = options.attach.token;
  } else {
    spawned = await spawnServer(options.runtime, ['--cwd', options.root]);
    url = spawned.url;
    token = spawned.token;
  }

  const session = await connect({ url, token, ownsServer: spawned !== undefined });
  return {
    session,
    spawned,
    dispose: async () => {
      await session.dispose(); // ownsServer 时发 shutdown(限时,见 remote.ts)。
      if (spawned) await spawned.waitExit();
    },
  };
}

const defaultSpawn: SpawnFn = (runtime, serveArgs) =>
  spawnManagedServer({
    nodeBin: runtime.nodeBin,
    cliJs: runtime.cliJs,
    serveArgs,
    runAsNode: runtime.runAsNode,
  });

const defaultConnect: ConnectFn = (options) => connectRemote(options);
