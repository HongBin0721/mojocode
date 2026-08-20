/**
 * renderer 侧的共享动作:把「守卫 + IPC + store 同步」收拢成一份,组件只做
 * 接线。收录标准是「≥2 个调用点共享、且跨 store 编排」的任务生命周期动作;
 * 单调用点的 RPC 走 bridge/invoke.ts 的 rpcCall/rpcFire。换会话三连已退役
 * ——新任务/打开历史一律走 TaskManager 的 task:* 通道。
 */

import { bridgeApi } from '../utils/host.js';
import { t } from '../i18n/index.js';
import { pushNotice } from './noticeStore.js';
import { describeError } from '../bridge/invoke.js';
import { useDesktopStore } from './desktopStore.js';
import { useProjectsStore } from './projectsStore.js';
import { useTimelineStore } from './timelineStore.js';
import { useUiStore } from './uiStore.js';

/** 聚焦换源(两个 store 必须成对,漏一处就镜像漂移)。 */
function setFocusedBoth(taskId: string): void {
  useDesktopStore.getState().setFocused(taskId);
  useTimelineStore.getState().setFocused(taskId);
}

function report(key: Parameters<typeof t>[0], error: unknown): void {
  pushNotice('error', `${t(key)}: ${describeError(error)}`);
}

/** 打开项目:侧栏过滤视角切到该 root,并落到任务工作区视图。 */
export function openProject(root: string): void {
  useProjectsStore.getState().select(root);
  useUiStore.getState().navigate('task');
}

/** 聚焦一个任务:store 镜像换源 + 通知 main(重推该任务的回放)。 */
export function focusTask(taskId: string): void {
  setFocusedBoth(taskId);
  void bridgeApi()
    .focusTask(taskId)
    .catch((error: unknown) => report('notice.focusFailed', error));
}

/** 打开任务(活跃直接聚焦,休眠以 --resume 复活)。 */
export function openTask(sessionId: string): void {
  // 乐观聚焦:活跃任务立即换源;休眠任务等 createTask 返回后再聚焦正式 id。
  const { runtimes } = useDesktopStore.getState();
  if (runtimes[sessionId]) {
    focusTask(sessionId);
    return;
  }
  void bridgeApi()
    .openTask(sessionId)
    .then(setFocusedBoth)
    .catch((error: unknown) => report('notice.taskOpenFailed', error));
}

/**
 * 新建任务(在指定 root;缺省当前聚焦任务的 root)。多 sidecar 语义:聚焦
 * 任务运行中也可新建——它转入后台缓冲继续跑,容量满且全在运行时 server 拒
 * 绝并以 toast 呈现(旧的 running 守卫是单任务时代的残留,已随并行移除)。
 */
export function newTask(root?: string): void {
  const state = useDesktopStore.getState();
  const targetRoot = root ?? state.snapshot?.root;
  if (!targetRoot) return;
  void bridgeApi()
    .createTask({ root: targetRoot })
    .then(setFocusedBoth)
    .catch((error: unknown) => report('notice.taskCreateFailed', error));
}

/** fork 会话为新任务(右键菜单):以历史副本拉新 sidecar 并聚焦。 */
export function forkTask(root: string, sessionId: string): void {
  void bridgeApi()
    .createTask({ root, resume: sessionId, fork: true })
    .then(setFocusedBoth)
    .catch((error: unknown) => report('notice.forkFailed', error));
}

/** 重启任务(断线横幅):main 侧先清残骸再 --resume 重拉同一会话。 */
export function restartTask(taskId: string): void {
  void bridgeApi()
    .openTask(taskId)
    .then(setFocusedBoth)
    .catch((error: unknown) => report('notice.restartFailed', error));
}

/** 兼容旧名(⌘N / CollapsedOverlay / 空态按钮的调用点)。 */
export const newSession = newTask;
