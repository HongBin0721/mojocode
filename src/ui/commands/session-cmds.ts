import { t } from '../../i18n/index.js';
import { INIT_PROMPT } from '../../agent/init.js';
import { formatDoctor } from '../../app/doctor.js';
import { formatCommandLabel } from '../Input.js';
import { buildResumeItems, sessionBanner } from '../timeline-controller.js';
import { buildCommands } from './registry.js';
import type { CommandHandler } from './types.js';

/** 会话级命令:help / exit / new / clear / init / compact / fork / resume / mcp / skills / doctor / cost。 */

export const help: CommandHandler = (ctx) => {
  ctx.push({
    kind: 'notice',
    level: 'info',
    message: buildCommands()
      .map((c) => `${formatCommandLabel(c)} — ${c.description}`)
      .join('\n'),
  });
};

// (/quit 别名已在 dispatch 入口归一为 exit。)
export const exit: CommandHandler = (ctx) => {
  ctx.exit();
};

// 与 Claude Code 一致:两者都丢弃当前对话、换新的会话文件;
// /clear 额外清掉终端屏幕与回滚缓冲,/new 保留已滚出的历史。
export const newSession: CommandHandler = async (ctx) => {
  try {
    await ctx.session.newSession();
  } catch (err) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.newSessionFailed', { message: (err as Error).message }),
    });
    return;
  }
  // 清空时间线,只留横幅,回到和启动时一致的界面。全屏渲染下
  // /clear 与 /new 的屏幕表现相同(没有终端回滚缓冲可清),差异
  // 只剩语义上的会话文件切换,都由上面的 newSession 完成。
  ctx.setItems([ctx.bannerItem()]);
  ctx.setUsage((prev) => ({ ...prev, used: ctx.session.agent.contextUsage.used, total: 0 }));
};

// `/init` 是唯一发起完整 agent 轮的命令:时间线上只回显 `/init`
// (turn-start 的 display),完整指令进历史喂模型。轮结束后刷新
// 环境信息,让刚生成的 AGENTS.md 立刻进入系统提示词。
export const init: CommandHandler = (ctx) => {
  ctx.setRunning(true);
  void ctx.session.agent
    .run(INIT_PROMPT, { display: '/init' })
    .then(() => ctx.session.refreshEnvironment())
    // run() 自己消化模型错误,但 refreshEnvironment 是新的一环:
    // 不接住的话 rejection 会掀掉整个 TUI(Node ≥20 视为致命)。
    .catch((err: Error) => {
      ctx.push({ kind: 'notice', level: 'warn', message: t('notice.initFailed', { message: err.message }) });
    })
    .finally(() => ctx.setRunning(false));
};

export const compact: CommandHandler = async (ctx) => {
  ctx.setWork({ phase: 'compacting', since: Date.now() });
  ctx.setRunning(true);
  await ctx.session.agent.compact().catch((err: Error) => {
    ctx.push({ kind: 'error', message: t('notice.compactFailed', { message: err.message }) });
  });
  ctx.setRunning(false);
  ctx.endWork();
};

// 与 Claude Code 一致:把当前对话分叉进一个新会话 id 并切换过去。
// 屏幕上什么都不变——历史、todos、权限全部照旧,只是从此写入新文件;
// 源会话停在分叉点,之后可用 /resume 回去走另一条线。
export const fork: CommandHandler = async (ctx) => {
  const fromId = ctx.session.store.id;
  try {
    const forked = await ctx.session.forkSession();
    ctx.push({
      kind: 'notice',
      level: 'info',
      message: t('notice.forked', { id: forked.id, from: fromId.slice(0, 8) }),
    });
  } catch (err) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.forkFailed', { message: (err as Error).message }),
    });
  }
};

export const resume: CommandHandler = async (ctx, arg) => {
  const { session } = ctx;
  // 无参提交(如本工作区没有其他会话,选择器空表单直接回车)。
  if (!arg) {
    ctx.push({ kind: 'notice', level: 'info', message: t('cli.noSessions') });
    return;
  }
  try {
    await session.resumeSession(arg);
  } catch (err) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.resumeFailed', { message: (err as Error).message }),
    });
    return;
  }
  // provider/model 不会被恢复改写(始终沿用当前模型),照样同步一遍镜像信号。
  ctx.setItems([sessionBanner(session), ...buildResumeItems(session)]);
  // 同步 UI 状态:上下文用量取恢复历史的估算(lastInputTokens 已随
  // setHistory 作废),下一轮 step-end 会带回真实值。todos 由订阅自动更新。
  ctx.setProviderLabel(session.provider.label);
  ctx.setModel(session.provider.model);
  ctx.setThink(session.provider.reasoningEffort);
  ctx.setUsage({ ...session.agent.contextUsage, total: 0 });
};

// 重载磁盘扩展(一方扩展不动);装不上的扩展的提示由会话直接上 bus。
export const reload: CommandHandler = async (ctx) => {
  try {
    const result = await ctx.session.reloadExtensions();
    ctx.push({
      kind: 'notice',
      level: result.failed.length > 0 ? 'warn' : 'info',
      message: t('notice.reloaded', {
        loaded: result.loaded.length > 0 ? result.loaded.join(', ') : '-',
        failed: result.failed.length,
      }),
    });
  } catch (err) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.reloadFailed', { message: (err as Error).message }),
    });
  }
};

// 强制重扫技能目录并列出(名字、参数提示、描述)。
export const skills: CommandHandler = async (ctx) => {
  try {
    const list = await ctx.session.refreshSkills();
    ctx.push({
      kind: 'notice',
      level: 'info',
      message:
        list.length > 0
          ? t('notice.skillsList', {
              list: list
                .map(
                  (s) =>
                    `/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ''} — ${s.description}`,
                )
                .join('\n'),
            })
          : t('notice.skillsNone'),
    });
  } catch (err) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.skillsFailed', { message: (err as Error).message }),
    });
  }
};

// 体检读的是会话此刻的配置(含 /approvals、/models 改过的值),MCP 直接
// 采信已连上的状态——重新连一遍会把每个 stdio server 的子进程再拉起
// 一份。`/doctor offline` 跳过联网那两项(端点探测、版本比对)。
export const doctor: CommandHandler = async (ctx, arg) => {
  const offline = arg.trim() === 'offline';
  ctx.push({ kind: 'notice', level: 'info', message: t('notice.doctorRunning') });
  try {
    // 体检读的是会话此刻的配置,MCP 采信已连上的状态,已拉起的 LSP 不再
    // 重复握手。
    const report = await ctx.session.doctor({ offline });
    ctx.push({
      kind: 'notice',
      level: report.healthy ? 'info' : 'warn',
      // 不上色:notice 整段由 Timeline 按 level 着色,再嵌一层 ANSI
      // 会和它打架;✓ / ! / ✗ 三个符号已经能区分轻重。
      message: formatDoctor(report).trimEnd(),
    });
  } catch (err) {
    ctx.push({ kind: 'error', message: (err as Error).message });
  }
};

export const cost: CommandHandler = (ctx) => {
  ctx.push({
    kind: 'notice',
    level: 'info',
    message:
      `${t('notice.costSession', { total: ctx.usage().total })}\n` +
      `${t('notice.costContext', { used: ctx.usage().used, window: ctx.usage().window })}\n` +
      t('notice.costTranscript', { path: `~/.mojocode/sessions/${ctx.session.store.id}.jsonl` }),
  });
};
