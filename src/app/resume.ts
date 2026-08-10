import { fromLegacyMode, type PartialConfig, type Permissions } from '../config/schema.js';
import type { SessionState } from '../session/store.js';

/**
 * 恢复会话时并入配置层的覆盖项。
 *
 * 只还原两轴权限,**不还原 provider/model**:恢复的是对话内容,模型始终用
 * 当前配置解析出的那一个(全局/项目配置、env、CLI flags 照常分层)。会话
 * meta 里的 provider/model 只是创建时的记录,拿来当身份还原会把用户后来
 * 显式切换过的模型悄悄改回去。
 *
 * 优先级:CLI flags > 会话 state > env/配置文件(仅权限一项)。
 */
export function resumeOverrides(
  state: SessionState,
  flags: { permissions?: Permissions },
): PartialConfig {
  const overrides: PartialConfig = {};

  // 旧会话文件存的是单轴 permissionMode,一次性映射到两轴;plan/未知值映射
  // 为 undefined,天然被丢弃。
  const stored: Permissions | undefined =
    state.sandbox && state.approval
      ? { sandbox: state.sandbox, approval: state.approval }
      : state.permissionMode
        ? fromLegacyMode(state.permissionMode)
        : undefined;

  // 档位一律忠实还原,full-access 也不例外:恢复一个会话就该回到它当时的档位
  // (旧 yolo 经 fromLegacyMode 映射过来的同理)。
  if (!flags.permissions && stored) {
    overrides.sandbox = stored.sandbox;
    overrides.approval = stored.approval;
  }
  return overrides;
}
