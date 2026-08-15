import { t, type MessageKey } from '../../i18n/index.js';
import { parseReviewArg, type ReviewStartResult } from '../../agent/review.js';
import { parseSimplifyArg } from '../../agent/simplify.js';
import { canEverWrite } from '../../config/schema.js';
import { CANNED_FAILURE_NOTICES } from './registry.js';
import type { CommandContext, CommandHandler } from './types.js';
import type { ReviewPickerRow } from '../ReviewPicker.js';

/** 罐装命令(/review、/simplify):公共执行出口与两个命令分支。 */

/**
 * 罐装命令(/review、/simplify)的公共执行出口:占住 busy 门 → RPC →
 * 失败 reason 映射本地化提示(按命令取 CANNED_FAILURE_NOTICES 的对应列)。
 * 两命令只差 RPC 调用、文案列与传输错误文案。
 *
 * submitPending 与 handleSubmit 同一语义:本地进程内的启动在 agent.run
 * 之前还有收集 git 摘要的异步窗口(最多四条串行子进程),期间 isRunning
 * 仍为 false——不占住的话,第二个罐装命令能穿过 BUSY_BLOCKED 拦截,撞上
 * loop.ts 的防重入兜底退化成轮中注入,整份罐装提示词被灌进第一个命令的
 * 流里,且后到者的 finally 还会提前清掉 running。远程侧无此窗口
 * (callDeferred 同步置乐观 run 标志),两条路共用这份保险。
 */
const launchCanned = (
  ctx: CommandContext,
  invoke: () => Promise<ReviewStartResult>,
  column: 'review' | 'simplify',
  transportErrorKey: MessageKey,
) => {
  ctx.submitGate.beginCanned();
  ctx.setRunning(true);
  void invoke()
    .then((result) => {
      if (result.ok) return;
      // reason 经 JSON 线路到达,防御性取列:伪造的 reason 不该掀翻 TUI。
      const entry = CANNED_FAILURE_NOTICES[result.reason];
      const messageKey = entry?.[column];
      if (!entry || !messageKey) return;
      ctx.push({
        kind: 'notice',
        level: entry.level,
        message: t(messageKey, {
          branch: result.branch ?? '',
          sha: result.sha ?? '',
          message: result.detail ?? '',
        }),
      });
    })
    // 失败以 reason 返回,但 RPC 本身会 reject(传输层错误),未捕获的
    // rejection 会掀掉整个 TUI——与 /init 同一条教训。
    .catch((err: Error) => {
      ctx.push({ kind: 'notice', level: 'warn', message: t(transportErrorKey, { message: err.message }) });
    })
    .finally(() => {
      ctx.submitGate.endCanned();
      ctx.setRunning(false);
    });
};

/**
 * `/review <范围>` 的执行出口:预设选择器直选、第二级选择器(base/commit)
 * 挑完、手打/回退重发走的是同一条路。display 统一按 `/review <范围>` 重组
 * ——picker 路径没有"用户原文"可用,直打路径与原文等价。
 *
 * App 的 ReviewPicker 浮层直接调用它(onPick)。
 */
export const launchReview = (ctx: CommandContext, scopeArg: string) =>
  launchCanned(
    ctx,
    () => ctx.session.startReview(scopeArg, { display: `/review ${scopeArg}` }),
    'review',
    'notice.reviewFailed',
  );

/**
 * `/simplify <目标>` 的执行出口:与 launchReview 同一条路。display 不在
 * UI 侧组装——裸命令不带尾随空格的规则由 server 侧(startSimplify 的
 * 缺省值)唯一一份持有,本地与远程两条路都经它落到 turn-start。
 */
const launchSimplify = (ctx: CommandContext, targetArg: string) =>
  launchCanned(ctx, () => ctx.session.startSimplify(targetArg), 'simplify', 'notice.simplifyFailed');

// 代码评审(/review):二级选择器选范围,server 侧组稿罐装提示词后
// 以一轮对话跑只读评审(见 bootstrap.startReview)。评审天然兼容只读
// 沙箱——它本来就不改文件,所以没有 /init 那道 canEverWrite 前置闸。
// 代码评审(/review):预设选择器(Codex 式)选四个预设之一,base/commit
// 再经第二级选择器挑分支/提交,custom 预填输入框补焦点文本;直打
// `/review base main` 这类(含回退重发)直接开跑。评审天然兼容只读沙箱。
export const review: CommandHandler = async (ctx, arg) => {
  const { session, push } = ctx;
  // 计划模式按设计必须以 exit_plan 收尾,而评审轮的产出是发现清单——
  // 两条指令会把模型夹住。检查放在最前:裸命令、开选择器、预填之前
  // 统统先拦。
  if (ctx.planActive()) {
    push({ kind: 'notice', level: 'warn', message: t('notice.reviewPlanMode') });
    return;
  }
  // 裸 /review:非 git 仓库时选择器返回空表、回退成裸提交,这里再拉
  // 一次 targets 把"没有仓库"和"用法不对"区分开;拉取失败如实报告——
  // 吞成 undefined 会退化成误导性的用法提示(base 二级路径同理)。
  if (!arg) {
    const targets = await session.reviewTargets().catch((err: Error) => err);
    if (targets instanceof Error) {
      push({ kind: 'notice', level: 'warn', message: t('notice.reviewFailed', { message: targets.message }) });
      return;
    }
    push({
      kind: 'notice',
      level: 'warn',
      message: !targets.isRepo ? t('notice.reviewNoRepo') : t('notice.reviewUsage'),
    });
    return;
  }
  // 预设的裸关键字:开第二级选择器或预填输入框,不直接成范围。
  if (arg === 'base' || arg === 'commit') {
    let rows: ReviewPickerRow[] = [];
    if (arg === 'base') {
      // catch 到的错误要如实报告:吞成空表会把传输失败误报成"没有分支"。
      const targets = await session.reviewTargets().catch((err: Error) => err);
      if (targets instanceof Error) {
        push({ kind: 'notice', level: 'warn', message: t('notice.reviewFailed', { message: targets.message }) });
        return;
      }
      if (!targets.isRepo) {
        push({ kind: 'notice', level: 'warn', message: t('notice.reviewNoRepo') });
        return;
      }
      rows = targets.branches.map((b) => ({ value: b.name, head: b.name, detail: b.subject }));
    } else {
      const commits = await session.reviewCommits().catch((err: Error) => err);
      if (commits instanceof Error) {
        push({ kind: 'notice', level: 'warn', message: t('notice.reviewFailed', { message: commits.message }) });
        return;
      }
      rows = commits.map((c) => ({
        value: c.sha,
        head: c.sha,
        detail: `${c.subject}${c.date ? ` · ${c.date}` : ''}`,
      }));
    }
    if (rows.length === 0) {
      // 提交列表为空分两种:非仓库(reviewCommits 对非仓库静默给空表)
      // 与真空仓——再探一次 targets 区分,别把"不是仓库"误报成"没有提交"。
      if (arg === 'commit') {
        const targets = await session.reviewTargets().catch(() => undefined);
        if (targets && !targets.isRepo) {
          push({ kind: 'notice', level: 'warn', message: t('notice.reviewNoRepo') });
          return;
        }
      }
      push({
        kind: 'notice',
        level: 'warn',
        message: arg === 'base' ? t('notice.reviewNoBranches') : t('notice.reviewNoCommits'),
      });
      return;
    }
    ctx.setReviewPicker({
      kind: arg,
      title: t(arg === 'base' ? 'reviewpick.branchTitle' : 'reviewpick.commitTitle'),
      rows,
    });
    return;
  }
  if (arg === 'custom') {
    // 预填焦点文本的半成品:尾随空格保持命令菜单关闭,用户补完再提交。
    ctx.setPrefill({ text: '/review custom ' });
    return;
  }
  if (!parseReviewArg(arg)) {
    push({ kind: 'notice', level: 'warn', message: t('notice.reviewUsage') });
    return;
  }
  launchReview(ctx, arg);
};

// 代码清理(/simplify,对齐 Claude Code):审查变更代码的清理机会并直接
// 应用修复——复用已有实现、化简、效率、抽象层级四个维度;正确性 bug 归
// /review,这一轮明确不找。范围语法与 /review 共享,裸命令默认未提交
// 改动,其余任意文本(路径/焦点)作为清理目标。要写文件:计划模式与
// read-only+never 提前拦下,别白烧注定写不出的一轮(read-only+on-request
// 放行,写入逐次升级确认)。
export const simplify: CommandHandler = (ctx, arg) => {
  if (ctx.planActive()) {
    ctx.push({ kind: 'notice', level: 'warn', message: t('notice.simplifyPlanMode') });
    return;
  }
  if (!canEverWrite(ctx.perms(), false)) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.simplifyReadonly', { mode: ctx.modeLabel() }),
    });
    return;
  }
  // 裸命令合法(默认未提交改动),只有半截关键字(base/commit/custom)不成目标。
  if (!parseSimplifyArg(arg)) {
    ctx.push({ kind: 'notice', level: 'warn', message: t('notice.simplifyUsage') });
    return;
  }
  launchSimplify(ctx, arg);
};
