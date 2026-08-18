/**
 * 计划步骤解析(设计稿的「执行计划」卡):从 exit_plan 的 markdown 正文里
 * 提取步骤行(`- [x]` / `- [ ]` / `1.` 编号行)。解析不出结构时返回
 * undefined——调用方回退整体 Markdown 渲染,绝不白屏。
 */

export interface PlanStep {
  text: string;
  done: boolean;
}

const CHECKBOX_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.+)$/;

export function parsePlanSteps(markdown: string): PlanStep[] | undefined {
  const lines = markdown.split('\n');
  const steps: PlanStep[] = [];
  let structured = 0;

  for (const line of lines) {
    const checkbox = CHECKBOX_RE.exec(line);
    if (checkbox) {
      steps.push({ text: checkbox[2]!.trim(), done: checkbox[1] !== ' ' });
      structured += 1;
      continue;
    }
    const numbered = NUMBERED_RE.exec(line);
    if (numbered) {
      steps.push({ text: numbered[1]!.trim(), done: false });
      structured += 1;
    }
  }

  // 至少两个结构化步骤才当成计划列表——单条命中多半是正文里顺带的列表。
  if (structured < 2) return undefined;
  return steps;
}
