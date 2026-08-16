import { globalConfigPath, projectConfigPath } from '../../config/paths.js';
import { permissionsLabel, type Config } from '../../config/schema.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck, DoctorInput } from './types.js';
import { fileExists } from './util.js';

/** config 分节:配置文件在哪、加载成没成、加载期提示。 */
export async function configChecks(input: DoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const globalFile = input.globalConfigFile ?? globalConfigPath();
  const projectFile = input.projectConfigFile ?? projectConfigPath(input.root);

  for (const [id, file] of [
    ['configGlobal', globalFile],
    ['configProject', projectFile],
  ] as const) {
    const exists = await fileExists(file);
    checks.push({
      id,
      label: t(id === 'configGlobal' ? 'doctor.check.configGlobal' : 'doctor.check.configProject'),
      level: 'info',
      detail: `${file}${exists ? '' : ` · ${t('doctor.notPresent')}`}`,
    });
  }

  if (input.configError) {
    checks.push({
      id: 'configLoad',
      label: t('doctor.check.configLoad'),
      level: 'fail',
      detail: input.configError,
      hint: t('doctor.configLoadHint'),
    });
    return checks;
  }

  checks.push({
    id: 'configLoad',
    label: t('doctor.check.configLoad'),
    level: 'ok',
    detail: input.sources.length > 0 ? input.sources.join(', ') : t('cli.defaultsOnly'),
  });

  input.warnings.forEach((warning, i) => {
    checks.push({
      id: `configWarning${i}`,
      label: t('doctor.check.configWarning'),
      level: 'warn',
      detail: warning,
    });
  });

  return checks;
}

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
