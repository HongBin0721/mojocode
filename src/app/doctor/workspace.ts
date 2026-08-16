import path from 'node:path';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';
import { fileExists, isWritable } from './util.js';

export async function workspaceChecks(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  // 目录不存在与目录不可写要分开说:`-C` 打错一个字时,"不可写"这句提示
  // 会把人引向权限问题,而真正的原因是路径根本不存在(loadRawConfig 对
  // 不存在的 root 是静默成功的,别处也不会兜出这个错)。
  const exists = await fileExists(root);
  const writable = exists && (await isWritable(root));
  checks.push({
    id: 'cwd',
    label: t('doctor.check.cwd'),
    level: writable ? 'ok' : exists ? 'warn' : 'fail',
    detail: root,
    ...(writable ? {} : { hint: exists ? t('doctor.cwdHint') : t('doctor.cwdMissing') }),
  });

  checks.push({
    id: 'git',
    label: t('doctor.check.git'),
    level: 'info',
    // worktree 里 .git 是文件而不是目录,所以只判断存在。
    detail: (await fileExists(path.join(root, '.git'))) ? t('doctor.gitRepo') : t('doctor.gitNone'),
  });

  const memoryFiles: string[] = [];
  for (const name of ['AGENTS.md', 'MOJOCODE.md', 'CLAUDE.md']) {
    if (await fileExists(path.join(root, name))) memoryFiles.push(name);
  }
  checks.push({
    id: 'memory',
    label: t('doctor.check.memory'),
    level: 'info',
    detail: memoryFiles.length > 0 ? memoryFiles.join(', ') : t('doctor.memoryNone'),
  });

  return checks;
}
