/**
 * `/review` 扩展:代码评审命令。
 *
 * 这是第一个用上**多级选择器**的命令——预设(未提交 / 基准分支 / 某个提交 /
 * 自定义)之后,base 与 commit 还要再从现算的分支、提交列表里挑一个。层数与
 * 取值全在这里,客户端只负责渲染与逐层回退;`/review base main` 这种直打
 * 形式和选择器走的是同一个 handler,选择器只是它的一种输入方式。
 *
 * 为什么它能拆出来而 `/simplify` 与 `task` 不能:评审是「组一段提示词、跑一轮」
 * ——`api.followUp` 就够了。`/simplify` 要编排四个并行子代理、合成工具事件、
 * 给失败的轴留位置,那是**宿主编排**,不是策略;子代理的发起权按调研的行业
 * 惯例(pi / opencode / Claude Code / Codex / Cline 无一例外)留在宿主。
 *
 * 收集器(`collectReviewTargets` / `collectReviewCommits` / `collectReviewSummary`)
 * 留在 `src/agent/review.ts`:`/simplify` 共用它们,且 git 要在**会话进程**里跑
 * ——`--attach` 时仓库在 server 那台机器上。扩展本来就跑在会话进程里,所以它
 * 直接调,不再需要 `reviewCommits` 这类 RPC(已随本次拆分退役)。
 */

import {
  collectReviewCommits,
  collectReviewSummary,
  collectReviewTargets,
  parseReviewArg,
  type ReviewScope,
  type ReviewFailure,
} from '../../agent/review.js';
import type {
  Extension,
  ExtensionAPI,
  ExtensionCommandOption,
} from '../../core/extension.js';
import { t, type MessageKey } from '../../i18n/index.js';
import { wrapSkillPrompt } from '../../skills/invocation.js';
import { buildReviewPrompt } from './prompt.js';

/**
 * 失败原因 → 提示文案与级别。穷举 Record:review.ts 新增失败原因时编译期
 * 就会提醒补文案。`/simplify` 有自己的一份(它的措辞不同),两处各自穷举
 * 比一张双列表更经得起拆分——命令搬走时只带走自己那一列。
 */
const FAILURE_NOTICES: Record<ReviewFailure, { key: MessageKey; level: 'info' | 'warn' }> = {
  'no-repo': { key: 'notice.reviewNoRepo', level: 'warn' },
  'clean-tree': { key: 'notice.reviewCleanTree', level: 'info' },
  'no-commits': { key: 'notice.reviewNoCommits', level: 'info' },
  'no-diff': { key: 'notice.reviewNoDiff', level: 'info' },
  'unknown-branch': { key: 'notice.reviewUnknownBranch', level: 'warn' },
  'same-branch': { key: 'notice.reviewSameBranch', level: 'warn' },
  'no-merge-base': { key: 'notice.reviewNoMergeBase', level: 'warn' },
  'unknown-commit': { key: 'notice.reviewUnknownCommit', level: 'warn' },
  'git-error': { key: 'notice.reviewGitError', level: 'warn' },
  'bad-arg': { key: 'notice.reviewUsage', level: 'warn' },
};

/** 带参数的预设(裸打不成范围,要么再开一层,要么预填输入框)。 */
const PARTIAL_ARGS = new Set(['base', 'commit', 'custom']);

export const reviewExtension: Extension = {
  id: 'review',
  setup(api: ExtensionAPI): void {
    /**
     * 选择器取值。第一层是四个预设(顺序与 Codex 一致),base / commit 标
     * `expands` 再开一层,custom 标 `prefill` 让用户补焦点文本。
     *
     * 非 git 仓库时第一层返回空表:客户端对空表回退成提交裸命令,由 handler
     * 分清"不是仓库"与"用法不对"——这个判断留在一处,别让客户端猜。
     */
    const options = async (path: string[]): Promise<ExtensionCommandOption[]> => {
      const [level] = path;
      if (level === 'base') {
        const targets = await collectReviewTargets(api.root);
        // 单行渲染(不给 title):分支名 + 该分支最新提交标题,与原来的
        // ReviewPicker 同一形态;两行渲染留给上一层的四个预设。
        return targets.branches.map((branch) => ({ value: branch.name, label: branch.subject }));
      }
      if (level === 'commit') {
        const commits = await collectReviewCommits(api.root);
        return commits.map((commit) => ({
          value: commit.sha,
          label: `${commit.subject}${commit.date ? ` · ${commit.date}` : ''}`,
        }));
      }
      const targets = await collectReviewTargets(api.root);
      if (!targets.isRepo) return [];
      return [
        {
          value: 'base',
          title: t('reviewopt.baseTitle'),
          label: t('reviewopt.baseDesc'),
          expands: true,
        },
        {
          value: 'uncommitted',
          title: t('reviewopt.uncommittedTitle'),
          label: t('reviewopt.uncommittedDesc'),
        },
        {
          value: 'commit',
          title: t('reviewopt.commitTitle'),
          label: t('reviewopt.commitDesc'),
          expands: true,
        },
        {
          value: 'custom',
          title: t('reviewopt.customTitle'),
          label: t('reviewopt.customDesc'),
          prefill: true,
        },
      ];
    };

    /**
     * 裸命令与半截关键字的解释。这些参数到达 handler 有两条路:用户手打,
     * 或者某一层选择器为空、客户端回退成提交已选的层。两种情形要说的话是
     * 同一句——"这一层为什么没有东西可选"。空表与手打的区别在于:真的空
     * 才报"没有分支/没有提交",非空说明用户只是打了半截命令,报用法。
     */
    const explainPartial = async (arg: string): Promise<void> => {
      // 两次 git 都要跑时并发跑:它们互不依赖,串起来就是白等一趟子进程。
      // 提交列表只有 `commit` 这一支用得上,所以守卫留着——并行不该变成
      // 给另外三条路凭空多跑一次 git。
      const [targets, commits] = await Promise.all([
        collectReviewTargets(api.root),
        arg === 'commit' ? collectReviewCommits(api.root) : undefined,
      ]);
      if (!targets.isRepo) {
        api.notify('warn', t('notice.reviewNoRepo'));
        return;
      }
      if (arg === 'base' && targets.branches.length === 0) {
        api.notify('warn', t('notice.reviewNoBranches'));
        return;
      }
      if (commits?.length === 0) {
        api.notify('warn', t('notice.reviewNoCommits'));
        return;
      }
      api.notify('warn', t('notice.reviewUsage'));
    };

    /** 收集摘要并排一轮评审。失败只出提示,不开轮。 */
    const launch = async (scope: ReviewScope, arg: string): Promise<void> => {
      const collected = await collectReviewSummary(api.root, scope);
      if (!collected.ok) {
        const entry = FAILURE_NOTICES[collected.reason];
        api.notify(
          entry.level,
          t(entry.key, {
            branch: collected.branch ?? '',
            sha: collected.sha ?? '',
            message: collected.detail ?? '',
          }),
        );
        return;
      }
      // display 按 `/review <范围>` 重组:选择器路径没有"用户原文"可用,
      // 直打路径与原文等价。followUp 而不是 run——它排在用户那一轮之后
      // 作为**新的一轮**,不会被当成轮内引导混进用户的提问里(这正是原来
      // 客户端要用 cannedLaunchPending 闸门挡住的那件事)。
      const display = `/review ${arg}`;
      api.followUp(wrapSkillPrompt(display, buildReviewPrompt(scope, collected.summary)), { display });
    };

    api.registerCommand('review', {
      description: t('cmd.review'),
      selectorTitle: t('reviewopt.selectorTitle'),
      options,
      /**
       * **同步返回,git 在后台跑。** `runCommand` 是即时 RPC,而客户端的
       * RPC 是串行队列:在 handler 里 await 几秒的 git(大仓库、`--attach`
       * 跨网络)会把用户随后的每一条 run/abort/switch 都堵在后面,请求本身
       * 还要冒 HTTP 超时的风险。收集完再 `followUp` 语义不变——它本来就排在
       * 用户那一轮之后作为新的一轮。
       */
      handler: (args) => {
        const arg = args.trim();
        if (arg === '' || PARTIAL_ARGS.has(arg)) {
          void explainPartial(arg);
          return;
        }
        const scope = parseReviewArg(arg);
        if (!scope) {
          api.notify('warn', t('notice.reviewUsage'));
          return;
        }
        void launch(scope, arg);
      },
    });
  },
};

