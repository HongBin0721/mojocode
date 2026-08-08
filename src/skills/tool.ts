/**
 * `skill` 工具:模型自主加载技能的入口。
 *
 * 三层渐进披露的枢纽:L1(name+description 列表)挂在工具 description 上,
 * 常驻上下文但每技能只占几十 token;L2(SKILL.md 正文)在 execute 时现读
 * 现返;L3(技能目录里的 references/ 等)靠激活时登记的只读扩根,模型
 * 后续用 read/glob 自取。工具 description 属于可缓存前缀——技能列表变化
 * 时由 bootstrap 整个重建工具(digest 对比),而不是在这里动态拼。
 */

import { tool } from 'ai';
import { z } from 'zod';
import { truncate } from '../tools/context.js';
import { readSkillBody, type SkillIndex, type SkillMeta } from './discovery.js';
import type { SkillManager } from './manager.js';
import { substituteArgs } from './substitute.js';

export interface SkillForkResult {
  result: string;
  steps: number;
  tokens: number;
  incomplete?: string;
}

export interface SkillToolDeps {
  manager: SkillManager;
  /**
   * 激活:登记技能目录为只读扩根;主 agent 且技能带 allowed-tools 时做
   * 一次性的会话预授权确认。由 bootstrap 注入(它才够得着 gate 与扩根集合)。
   */
  activate: (meta: SkillMeta) => Promise<void>;
  /**
   * `context: fork` 的执行通道(task.ts 的 runTaskSubagent 闭包)。子 agent
   * 语境下为 undefined——fork 技能退化为内联返回正文,守住一层递归的约束。
   */
  runFork?: (opts: {
    meta: SkillMeta;
    prompt: string;
    toolCallId: string;
    abortSignal?: AbortSignal;
  }) => Promise<SkillForkResult>;
  /**
   * 本轮由用户斜杠调用发起的技能名。disable-model-invocation 的技能只有
   * 出现在这个集合里才允许 execute——用户点名要跑,模型只是代为触发。
   */
  pendingUserSkills: Set<string>;
}

/** L1 列表:仅模型可自主调用的技能。description 截断防单个技能撑爆前缀。 */
export function skillToolDescription(index: SkillIndex): string {
  const lines = index.skills
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => `- ${skill.name}: ${clip(skill.description, 200)}`);
  return (
    'Load a skill: a reusable instruction package provided by the user or the project. ' +
    'Call this when a listed skill matches the task at hand, BEFORE attempting the task ' +
    'yourself — the skill contains the proven procedure. The result is the skill body; ' +
    'follow it. The skill directory becomes readable, so files it references can be ' +
    'read directly.\n\nAvailable skills:\n' +
    (lines.length > 0 ? lines.join('\n') : '(none)')
  );
}

function clip(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

export function createSkillTool(deps: SkillToolDeps) {
  return tool({
    description: skillToolDescription(deps.manager.current()),
    inputSchema: z.object({
      name: z.string().describe('Skill name, exactly as listed.'),
      arguments: z
        .string()
        .optional()
        .describe('Arguments for the skill, substituted into $ARGUMENTS/$0..$N placeholders.'),
    }),
    execute: async ({ name, arguments: args }, { toolCallId, abortSignal }) => {
      // TTL 现查:工具 description 里的列表最多旧 15s,execute 用的必须是磁盘现状。
      const index = await deps.manager.list();
      const meta = index.skills.find((skill) => skill.name === name);
      if (!meta) {
        const known = index.skills
          .filter((skill) => !skill.disableModelInvocation)
          .map((skill) => skill.name);
        throw new Error(
          `Unknown skill "${name}". Available skills: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
        );
      }
      if (meta.disableModelInvocation && !deps.pendingUserSkills.has(meta.name)) {
        throw new Error(
          `The skill "${name}" can only be invoked by the user (via /${name}). ` +
            'Do not reproduce its behavior another way; suggest the user run it.',
        );
      }

      await deps.activate(meta);
      const body = await readSkillBody(meta);
      const prompt = substituteArgs(body, args ?? '');

      if (meta.context === 'fork' && deps.runFork) {
        const fork = await deps.runFork({ meta, prompt, toolCallId, abortSignal });
        return {
          name: meta.name,
          result: truncate(fork.result),
          steps: fork.steps,
          tokens: fork.tokens,
          ...(fork.incomplete ? { incomplete: fork.incomplete } : {}),
        };
      }

      return {
        name: meta.name,
        path: meta.file,
        // 与所有工具一样封顶;正文超长的技能本该把细节拆进 L3 文件。
        content: truncate(prompt),
      };
    },
  });
}
