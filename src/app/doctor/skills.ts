import { discoverSkills, promptLocations, skillLocations } from '../../skills/discovery.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';
import { fileExists } from './util.js';

/**
 * 技能发现体检:数量、来源分布、解析失败。纯文件系统,不触发激活,
 * 也不影响会话状态——doctor 里的重扫与 SkillManager 的缓存互不相干。
 */
export async function skillsChecks(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let index: Awaited<ReturnType<typeof discoverSkills>>;
  try {
    index = await discoverSkills(root);
  } catch (err) {
    return [
      {
        id: 'skills.count',
        label: t('doctor.check.skillsCount'),
        level: 'warn',
        detail: (err as Error).message,
      },
    ];
  }

  const userInvocable = index.skills.filter((s) => s.userInvocable).length;
  const modelInvocable = index.skills.filter((s) => !s.disableModelInvocation).length;
  checks.push({
    id: 'skills.count',
    label: t('doctor.check.skillsCount'),
    level: 'info',
    detail:
      index.skills.length > 0
        ? t('doctor.skillsCount', {
            n: index.skills.length,
            user: userInvocable,
            model: modelInvocable,
          })
        : t('doctor.skillsNone'),
  });

  // 来源分布:只列真实存在的目录,`~/.claude/skills` 一类的缺席是常态。
  //
  // 按 `<kind>:<source>` 计数而不是只按 source:提示词模板与技能共用 source
  // 名(两者都可能是 `project`),只按 source 分的话项目 prompts 目录里的模板
  // 会被记到项目 skills 目录名下——数量对得上,归属是错的。
  const kindOf = (skill: (typeof index.skills)[number]): string =>
    skill.kind === 'prompt' ? 'prompt' : 'skill';
  const bySource = new Map<string, number>();
  for (const skill of index.skills) {
    const key = `${kindOf(skill)}:${skill.source}`;
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }
  const sourceLines: string[] = [];
  const locations = [
    ...skillLocations(root).map((l) => ({ ...l, kind: 'skill' })),
    ...promptLocations(root).map((l) => ({ ...l, kind: 'prompt' })),
  ];
  for (const location of locations) {
    if (!(await fileExists(location.dir))) continue;
    sourceLines.push(`${location.dir}: ${bySource.get(`${location.kind}:${location.source}`) ?? 0}`);
  }
  if (sourceLines.length > 0) {
    checks.push({
      id: 'skills.sources',
      label: t('doctor.check.skillsSources'),
      level: 'info',
      detail: sourceLines.join('\n'),
    });
  }

  if (index.failures.length > 0) {
    checks.push({
      id: 'skills.parse',
      label: t('doctor.check.skillsParse'),
      level: 'warn',
      detail: index.failures.map((f) => `${f.file}: ${f.reason}`).join('\n'),
    });
  }

  return checks;
}
