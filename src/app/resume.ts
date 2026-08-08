import { fromLegacyMode, type PartialConfig, type Permissions } from '../config/schema.js';
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

  // 档位一律忠实还原,full-access 也不例外:恢复一个会话就该回到它当时的档位,
  // 与 model/provider 同一条原则(旧 yolo 经 fromLegacyMode 映射过来的同理)。
  if (!flags.permissions && stored) {
    overrides.sandbox = stored.sandbox;
    overrides.approval = stored.approval;
  }
  return overrides;
}
