import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../config/schema.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';
import { fileExists, firstExisting, formatBytes, isWritable } from './util.js';

export async function sessionChecks(dir: string, config?: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const exists = await fileExists(dir);
  // 目录还没建过很正常,此时看祖先能不能写。必须一路往上找到真正存在的那一层:
  // 全新安装时 ~/.mojocode 连同 sessions/ 整棵都还没有(第一次存会话或
  // `mojocode auth` 才创建),只看父目录会 ENOENT,把干净的新装误判成"不可写"
  // ——那会让第一次跑 doctor 的人直接看到一条异常加退出码 1。
  const target = exists ? dir : await firstExisting(path.dirname(dir));
  const writable = await isWritable(target);
  checks.push({
    id: 'sessionsDir',
    label: t('doctor.check.sessionsDir'),
    level: writable ? 'ok' : 'fail',
    detail: `${dir}${exists ? '' : ` · ${t('doctor.willBeCreated')}`}`,
    ...(writable ? {} : { hint: t('doctor.sessionsDirHint', { path: target }) }),
  });

  let count = 0;
  let bytes = 0;
  if (exists) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) count += 1;
        if (!file.endsWith('.jsonl') && !file.endsWith('.meta.json')) continue;
        const stat = await fs.stat(path.join(dir, file)).catch(() => undefined);
        bytes += stat?.size ?? 0;
      }
    } catch {
      // 目录读不动的情况上面那条检查已经报了。
    }
  }
  checks.push({
    id: 'sessionsUsage',
    label: t('doctor.check.sessionsUsage'),
    level: 'info',
    detail: t('doctor.sessionsUsage', {
      n: String(count),
      size: formatBytes(bytes),
      days: String(config?.cleanupPeriodDays ?? 30),
    }),
  });

  return checks;
}
