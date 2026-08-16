import os from 'node:os';
import process from 'node:process';
import { APP_NAME } from '../../config/paths.js';
import { REPO_URL, isCompiledBinary, nodeMinMajor, packageRoot } from '../../config/version.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';
import { NETWORK_TIMEOUT_MS, compareVersions } from './util.js';

const REGISTRY_URL = `https://registry.npmjs.org/${APP_NAME}/latest`;

export async function envChecks(opts: {
  version: string;
  offline: boolean;
  fetchImpl?: typeof fetch;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const latest = opts.offline ? undefined : await latestVersion(opts.fetchImpl);
  const outdated = latest !== undefined && compareVersions(latest, opts.version) > 0;
  checks.push({
    id: 'version',
    label: t('doctor.check.version'),
    level: outdated ? 'warn' : 'ok',
    detail:
      opts.version +
      (opts.offline
        ? ''
        : latest === undefined
          ? ` · ${t('doctor.latestUnknown')}`
          : outdated
            ? ` · ${t('doctor.updateAvailable', { latest })}`
            : ` · ${t('doctor.upToDate')}`),
    ...(outdated
      ? {
          hint: isCompiledBinary()
            ? t('doctor.updateHintBinary', { url: `${REPO_URL}/releases` })
            : t('doctor.updateHint', { name: APP_NAME }),
        }
      : {}),
  });

  // 单二进制里 runtime 是打包进来的 Bun,系统装没装 Node、装的多老都无关紧要;
  // `process.versions.node` 此时只是 Bun 的兼容层版本号,最低版本检查不适用。
  const bunVersion = process.versions.bun;
  if (bunVersion !== undefined) {
    checks.push({
      id: 'node',
      label: t('doctor.check.runtime'),
      level: 'ok',
      detail: `Bun v${bunVersion} · Node compat v${process.versions.node}`,
    });
  } else {
    const major = Number(process.versions.node.split('.')[0]);
    // 下限取自 package.json 的 engines.node(与 CI/README 同源),不再写死——
    // 曾写死 20 而 floor 已抬到 22,给必崩的运行时开了绿灯。
    const required = nodeMinMajor();
    const tooOld = Number.isFinite(major) && major < required;
    checks.push({
      id: 'node',
      label: t('doctor.check.node'),
      level: tooOld ? 'fail' : 'ok',
      detail: `v${process.versions.node}`,
      ...(tooOld ? { hint: t('doctor.nodeTooOld', { required: String(required) }) } : {}),
    });
  }

  checks.push({
    id: 'platform',
    label: t('doctor.check.platform'),
    level: 'info',
    detail: `${process.platform} ${process.arch} · ${os.release()} · TERM=${process.env.TERM ?? '?'}`,
  });

  checks.push({
    id: 'install',
    label: t('doctor.check.install'),
    level: 'info',
    // 单二进制模式下 packageRoot() 已退回二进制所在目录,补一个标注说明形态。
    detail: packageRoot() + (isCompiledBinary() ? ` · ${t('doctor.installBinary')}` : ''),
  });

  return checks;
}

async function latestVersion(fetchImpl?: typeof fetch): Promise<string | undefined> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(REGISTRY_URL, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === 'string' ? json.version : undefined;
  } catch {
    // 没网、被墙、registry 抽风——都不该让体检失败,版本行降级为"未知"。
    return undefined;
  }
}
