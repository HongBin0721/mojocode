import { t } from '../../i18n/index.js';
import type { ReviewStartResult } from '../../agent/review.js';
import { parseSimplifyArg } from '../../agent/simplify.js';
import { SIMPLIFY_FAILURE_NOTICES } from './registry.js';
import type { CommandContext, CommandHandler } from './types.js';

/**
 * 罐装命令 `/simplify`:启动闸门 + 命令分支。
 *
 * `/review` 已搬进扩展(`src/extensions/review/`)——它只是「组一段提示词、
 * 跑一轮」,`api.followUp` 就够;`/simplify` 留在核心是因为它要编排四个并行
 * explore 子代理、合成工具事件、给失败的轴留位置,那是宿主编排而不是策略,
 * 而子代理的发起权按行业惯例留在宿主。
 */

/**
 * `/simplify` 的执行出口:占住 busy 门 → RPC → 失败 reason 映射本地化提示。
 *
 * submitPending 与 handleSubmit 同一语义:本地进程内的启动在 agent.run
 * 之前还有收集 git 摘要与跑四个子代理的异步窗口,期间 isRunning 仍为
 * false——不占住的话,第二个罐装命令能穿过 BUSY_BLOCKED 拦截,撞上 loop.ts
 * 的防重入兜底退化成轮中注入,整份罐装提示词被灌进第一个命令的流里,且
 * 后到者的 finally 还会提前清掉 running。远程侧无此窗口(callDeferred 同步
 * 置乐观 run 标志),两条路共用这份保险。
 */
const launchSimplify = (ctx: CommandContext, targetArg: string) => {
  ctx.submitGate.beginCanned();
  ctx.setRunning(true);
  void ctx.session
    .startSimplify(targetArg)
    .then((result: ReviewStartResult) => {
      if (result.ok) return;
      // reason 经 JSON 线路到达,防御性取值:伪造的 reason 不该掀翻 TUI。
      const entry = SIMPLIFY_FAILURE_NOTICES[result.reason];
      if (!entry) return;
      ctx.push({
        kind: 'notice',
        level: entry.level,
        message: t(entry.key, {
          branch: result.branch ?? '',
          sha: result.sha ?? '',
          message: result.detail ?? '',
        }),
      });
    })
    // 失败以 reason 返回,但 RPC 本身会 reject(传输层错误),未捕获的
    // rejection 会掀掉整个 TUI——与 /init 同一条教训。
    .catch((err: Error) => {
      ctx.push({
        kind: 'notice',
        level: 'warn',
        message: t('notice.simplifyFailed', { message: err.message }),
      });
    })
    .finally(() => {
      ctx.submitGate.endCanned();
      ctx.setRunning(false);
    });
};

// 代码清理(/simplify,对齐 Claude Code):审查变更代码的清理机会并直接
// 应用修复——复用已有实现、化简、效率、抽象层级四个维度;正确性 bug 归
// /review,这一轮明确不找。范围语法与 /review 共享,裸命令默认未提交
// 改动,其余任意文本(路径/焦点)作为清理目标。
export const simplify: CommandHandler = (ctx, arg) => {
  // 裸命令合法(默认未提交改动),只有半截关键字(base/commit/custom)不成目标。
  if (!parseSimplifyArg(arg)) {
    ctx.push({ kind: 'notice', level: 'warn', message: t('notice.simplifyUsage') });
    return;
  }
  launchSimplify(ctx, arg);
};
