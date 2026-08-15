import { t, type MessageKey } from '../../i18n/index.js';
import type { SlashCommand } from '../Input.js';
import type { GoalStopReason } from '../../core/events.js';
import type { ApprovalPresetId, ReasoningEffort, TimelineMode } from '../../config/schema.js';
import type { ReviewFailure } from '../../agent/review.js';

/**
 * 命令注册表:命令名/别名/描述、枚举取值 → 文案的映射,全部是纯数据,
 * 不依赖任何会话状态。命令的执行体在 src/ui/commands/ 的各 handler 文件
 * (见 index.ts 的 dispatch);这里只回答「有哪些命令、叫什么、菜单上写什么」。
 */

/** 每次渲染时重建,使 /setting 里的语言切换与配置中的语言设置都能生效。 */
/**
 * 把手打的别名(/model、/settings、/quit 这类,不经 Input 菜单的改写)
 * 归一为分发主名。别名的知识只住在 buildCommands 的表里:拦截表与
 * switch 都只见主名,给命令配别名时漏列任何一处都不再构成绕过。
 */
export function canonicalCommandName(name: string): string {
  return buildCommands().find((c) => c.aliases?.includes(name))?.name ?? name;
}

export function buildCommands(): SlashCommand[] {
  return [
    { name: 'help', description: t('cmd.help') },
    { name: 'init', description: t('cmd.init') },
    { name: 'review', description: t('cmd.review'), selectorTitle: t('reviewopt.selectorTitle') },
    { name: 'simplify', description: t('cmd.simplify') },
    { name: 'plan', description: t('cmd.plan') },
    { name: 'goal', description: t('cmd.goal') },
    { name: 'models', aliases: ['model'], description: t('cmd.models') },
    { name: 'provider', description: t('cmd.provider') },
    { name: 'approvals', description: t('cmd.approvals') },
    { name: 'think', description: t('cmd.think') },
    { name: 'setting', aliases: ['settings'], description: t('cmd.setting') },
    { name: 'focus', description: t('cmd.focus') },
    { name: 'compact', description: t('cmd.compact') },
    { name: 'new', description: t('cmd.new') },
    { name: 'clear', description: t('cmd.clear') },
    { name: 'mcp', description: t('cmd.mcp') },
    { name: 'skills', description: t('cmd.skills') },
    { name: 'doctor', description: t('cmd.doctor') },
    { name: 'cost', description: t('cmd.cost') },
    { name: 'resume', description: t('cmd.resume') },
    { name: 'fork', description: t('cmd.fork') },
    { name: 'exit', aliases: ['quit'], description: t('cmd.exit') },
  ];
}

/** `/approvals` 二级选择器里各预设的说明。 */
export const PRESET_DESCRIPTIONS: Record<ApprovalPresetId, MessageKey> = {
  'read-only': 'approvalopt.readOnly',
  ask: 'approvalopt.ask',
  auto: 'approvalopt.auto',
  'full-access': 'approvalopt.fullAccess',
};

/** 思考档位的选择器说明。/think 不进 BUSY_BLOCKED_COMMANDS:改档位对进行中
 * 的流无破坏,下一次请求才生效。 */
export const THINK_DESCRIPTIONS: Record<ReasoningEffort, MessageKey> = {
  auto: 'thinkopt.auto',
  off: 'thinkopt.off',
  low: 'thinkopt.low',
  medium: 'thinkopt.medium',
  high: 'thinkopt.high',
  max: 'thinkopt.max',
};

/** 运行中会和进行中的流互相踩踏的命令(改历史、换模型)。runCommand 入口
 * 已把别名归一为主名,这里只列主名。 */
export const BUSY_BLOCKED_COMMANDS = new Set([
  'new',
  'clear',
  'compact',
  'models',
  'provider',
  'resume',
  'fork',
  'init',
  'review',
  'simplify',
]);

/**
 * 压缩进度条的预估摘要总长(字符)。摘要提示词要的是分节的事实性散文,
 * 实测多落在 1500–4000 字符,取中偏上让条的走速与真实耗时大致相称。
 * 估算只影响观感:偏短=提前贴住 99%,偏长=收尾时从半程直接熄灯。
 */
export const COMPACT_EXPECTED_SUMMARY_CHARS = 3000;

/**
 * `/goal` 的取消词。它们是**参数**而不是命令别名(命令别名会进补全菜单,
 * 而 `/stop`、`/off` 单独成命令毫无意义),与 Claude Code 对齐。
 */
export const GOAL_CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

/** goal-stop 的原因 → 文案。穷尽 Record:新增停止原因时编译期就会提醒补文案。 */
export const GOAL_STOP_MESSAGES: Record<GoalStopReason, MessageKey> = {
  met: 'notice.goalStopMet',
  cleared: 'notice.goalStopCleared',
  replaced: 'notice.goalStopReplaced',
  'max-turns': 'notice.goalStopMaxTurns',
  aborted: 'notice.goalStopAborted',
  error: 'notice.goalStopError',
  'check-failed': 'notice.goalStopCheckFailed',
  'plan-mode': 'notice.goalStopPlanMode',
};

/** `/focus` 二级选择器里各档位的说明。 */
export const FOCUS_DESCRIPTIONS: Record<TimelineMode, MessageKey> = {
  full: 'focusopt.full',
  compact: 'focusopt.compact',
  result: 'focusopt.result',
};

/**
 * 罐装命令(/review、/simplify)失败原因 → 两命令各自的提示文案 + 级别。
 * 穷举 Record:review.ts 新增失败原因时编译期就会提醒两列一起补文案,级别
 * 只写一份。"没有可评审的内容"是信息,其余是警告。git-error 的 {message}
 * 填的是 stderr 摘要,仅供排查。unknown-* 四项两命令措辞相同,共用 review*
 * 的键,不为换个前缀在目录里抄一份。
 */
export const CANNED_FAILURE_NOTICES: Record<
  ReviewFailure,
  { review: MessageKey; simplify: MessageKey; level: 'info' | 'warn' }
> = {
  'no-repo': { review: 'notice.reviewNoRepo', simplify: 'notice.simplifyNoRepo', level: 'warn' },
  'clean-tree': { review: 'notice.reviewCleanTree', simplify: 'notice.simplifyCleanTree', level: 'info' },
  'no-commits': { review: 'notice.reviewNoCommits', simplify: 'notice.simplifyNoCommits', level: 'info' },
  'no-diff': { review: 'notice.reviewNoDiff', simplify: 'notice.simplifyNoDiff', level: 'info' },
  'unknown-branch': { review: 'notice.reviewUnknownBranch', simplify: 'notice.reviewUnknownBranch', level: 'warn' },
  'same-branch': { review: 'notice.reviewSameBranch', simplify: 'notice.reviewSameBranch', level: 'warn' },
  'no-merge-base': { review: 'notice.reviewNoMergeBase', simplify: 'notice.reviewNoMergeBase', level: 'warn' },
  'unknown-commit': { review: 'notice.reviewUnknownCommit', simplify: 'notice.reviewUnknownCommit', level: 'warn' },
  'git-error': { review: 'notice.reviewGitError', simplify: 'notice.simplifyGitError', level: 'warn' },
  'bad-arg': { review: 'notice.reviewUsage', simplify: 'notice.simplifyUsage', level: 'warn' },
};

/**
 * 流式预览占用的终端行数上限。全屏布局下这不再是防漏帧的硬约束,只是
 * 思考尾部的滚动窗口行数。正文的活动条目在时间线里完整生长,不裁剪;
 * 思考不同——定稿只留一行"已思考 8.2s",正文**只在流式期间出现过一次**,
 * 之后要 ctrl+r 才展开,而思考动辄几千行,完整摊开会把 scrollbox 内容撑到
 * 天上、reasoning-end 时又整体塌掉。留一个几行的尾部窗口原地刷新即可。
 */
export const REASONING_PREVIEW_ROWS = 5;
