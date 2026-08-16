import { globalConfigPath, projectConfigPath } from '../../config/paths.js';
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
