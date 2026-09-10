/**
 * `/review` 的组稿:只属于评审的那部分。收集器与范围块留在 `src/agent/review.ts`
 * ——它们是 `/simplify` 也在用的机制库(与 `src/lsp/` / `src/mcp/` 同样的分工:
 * 机制在核心,策略在扩展)。
 */

import { scopeBlock, type ReviewScope, type ReviewSummary } from '../../agent/review.js';

/**
 * 组稿审查提示词(英文——喂给模型的文本按约定不本地化)。
 *
 * 只读条款是用户确认过的产品语义:评审轮不准改任何文件、不准跑改状态的
 * 命令(评审的产出是发现清单)。发现格式对齐
 * Codex review:按严重度排序、file:line 定位、最小具体修复、没有问题就明说。
 */
export function buildReviewPrompt(scope: ReviewScope, summary: ReviewSummary): string {
  return `Review the changes described below and report findings.

This is a read-only review. Do NOT modify, create or delete any file, do NOT
run any state-changing command (no commit, stash, checkout, rebase, branch or
worktree operations). Read the repository and report.

## Scope

${scopeBlock(scope, summary)}

## How to review

- Fetch the full diff yourself with the commands listed in the scope block.
  They are read-only and pre-approved. Diff file by file (\`... -- <path>\`) for
  large changes so no single output gets truncated.
- Read the code around each hunk — a hunk alone rarely shows whether the change
  is correct.
- Focus on real defects: bugs, logic errors, security issues, data races,
  error-handling gaps, broken tests, API misuse, performance regressions. Skip
  style nits and subjective preferences unless they hide a real problem.

## Output format

- Start with a one-paragraph summary of what the changes do.
- Then list findings, most severe first, one per line:
  [high|medium|low] path/to/file.ts:42 — what is wrong, why, and the smallest
  concrete fix.
  Cite only file:line references that exist in the diff or in files you read.
- If nothing worth reporting was found, say so explicitly; do not invent
  minor issues.`;
}
