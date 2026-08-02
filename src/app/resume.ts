import {
  fromLegacyMode,
  isEphemeralPermissions,
  type PartialConfig,
  type Permissions,
} from '../config/schema.js';
import type { SessionMeta, SessionState } from '../session/store.js';

/**
 * 恢复会话时并入配置层的覆盖项。
 *
 * 优先级:CLI flags > 会话 meta/state > env/配置文件。会话身份压过 MOJOCODE_* 环境
 * 变量——恢复一个会话就应该回到它当时的模型,这与 Claude Code 的行为一致。
 *
 * model 属于 provider:用户显式换了 provider 时,沿用会话里的模型 id 只会 404,
 * 所以此时 meta 的 provider/model 一并放弃。
 */
export function resumeOverrides(
  meta: SessionMeta,
  state: SessionState,
  flags: { provider?: string; model?: string; permissions?: Permissions },
): PartialConfig {
  const overrides: PartialConfig = {};
  if (!flags.provider) {
    overrides.provider = meta.provider;
    if (!flags.model) overrides.model = meta.model;
  }

  // 旧会话文件存的是单轴 permissionMode,一次性映射到两轴;plan/未知值映射
  // 为 undefined,天然被丢弃。
  const stored: Permissions | undefined =
    state.sandbox && state.approval
      ? { sandbox: state.sandbox, approval: state.approval }
      : state.permissionMode
        ? fromLegacyMode(state.permissionMode)
        : undefined;

  // full-access 不该从会话记录里复活(见 bootstrap 的 snapshotState);这里再挡
  // 一道,因为磁盘上可能留有本规则生效之前写下的会话文件(旧 yolo 同理)。
  if (!flags.permissions && stored && !isEphemeralPermissions(stored)) {
    overrides.sandbox = stored.sandbox;
    overrides.approval = stored.approval;
  }
  return overrides;
}
