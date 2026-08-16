import { permissionsLabel, type Config } from '../../config/schema.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';

/** permissions 分节:纯看配置,不碰外部世界。 */
export function permissionChecks(config: Config): DoctorCheck[] {
  const perms = { sandbox: config.sandbox, approval: config.approval };
  const dangerous = config.sandbox === 'danger-full-access';
  const rules = config.permissions;
  return [
    {
      id: 'mode',
      label: t('doctor.check.mode'),
      level: dangerous ? 'warn' : 'ok',
      detail:
        `${config.sandbox} · ${config.approval} (${permissionsLabel(perms)})` +
        (config.plan ? ` · ${t('doctor.planOn')}` : ''),
      ...(dangerous ? { hint: t('doctor.dangerHint') } : {}),
    },
    {
      id: 'rules',
      label: t('doctor.check.rules'),
      level: 'info',
      detail:
        `allowBash ${rules.allowBash.length} · denyBash ${rules.denyBash.length} · ` +
        `allowWrite ${rules.allowWrite.length} · denyPath ${rules.denyPath.length} · ` +
        `allowNet ${rules.allowNet.length}`,
    },
  ];
}
