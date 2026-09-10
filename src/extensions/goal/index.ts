/**
 * `/goal` 扩展:给定一个完成条件,每轮收尾后由评估器判断是否达成,没达成
 * 就把评估理由当作下一轮的指令自动续跑,直到达成或触到安全边界。
 *
 * 这是第一个从核心搬出来的功能,也是钩子层的验收:它只用 `turn_end` +
 * `followUp`(评估后续跑)、`agent_end`(两轮之间被 esc 停下)、`session_start`
 * (从会话记录恢复)、`turn_start`(恢复来的目标真正开跑时重置统计),外加
 * 一条命令、一行状态与若干 notice。核心里不再有任何"目标"的概念。
 *
 * 与搬出来之前的一处语义差异:两轮之间(评估窗口)用户提交的消息不再"取代
 * 评估器的指令",而是作为轮内引导随下一轮一起喂给模型——链条期间 agent
 * 始终 isRunning,提交自然走 inject(见 loop.ts 的 run)。
 */

import { t, type MessageKey } from '../../i18n/index.js';
import { formatDuration, formatTokens, glyphs } from '../../ui/theme.js';
import type { Extension, ExtensionAPI } from '../../core/extension.js';
import { evaluateGoal, guidanceFor } from './evaluate.js';

/**
 * `/goal` 的取消词。它们是**参数**而不是命令别名(命令别名会进补全菜单,
 * 而 `/stop`、`/off` 单独成命令毫无意义),与 Claude Code 对齐。
 */
const GOAL_CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

/**
 * 目标循环停下来的原因。任何一种都会解除目标——留着的话,用户中断之后随口
 * 发的下一条消息会把自动循环又悄悄点着,而那正是最该避免的意外。
 */
type GoalStopReason =
  /** 评估器判定条件已达成。 */
  | 'met'
  /** 用户 `/goal clear`,或 `/new`、`/resume` 换掉了会话。 */
  | 'cleared'
  /** 被新设定(或恢复)的目标取代。 */
  | 'replaced'
  /** 触及自动续跑的轮数上限。 */
  | 'max-turns'
  /** 这一轮被 esc 中断,或两轮之间被 esc 停下。 */
  | 'aborted'
  /** 这一轮以错误收尾。 */
  | 'error'
  /** 评估器连续给不出可解析的判词——不能靠猜继续烧 token。 */
  | 'check-failed';

/** 穷尽 Record:新增停止原因时编译期就会提醒补文案。 */
const STOP_MESSAGES: Record<GoalStopReason, MessageKey> = {
  met: 'notice.goalStopMet',
  cleared: 'notice.goalStopCleared',
  replaced: 'notice.goalStopReplaced',
  'max-turns': 'notice.goalStopMaxTurns',
  aborted: 'notice.goalStopAborted',
  error: 'notice.goalStopError',
  'check-failed': 'notice.goalStopCheckFailed',
};

/** 连续这么多次判不出结果就停手,免得评估器坏掉时空转烧 token。 */
const MAX_PARSE_FAILURES = 2;

/** 会话记录里的形状(kind custom · type 'goal'):条件,或 null 表示已解除。 */
export const GOAL_ENTRY = 'goal';

interface GoalState {
  /** 用户写下的条件原文,也是第一轮的指令。 */
  condition: string;
  /** 本次监管的起点。恢复来的目标在真正开跑时重置。 */
  startedAt: number;
  /** 已跑完的轮数,含用户发起的第一轮。 */
  turns: number;
  /** 评估器最近一次的判词。`/goal` 展示它,也是下一轮指令的来源。 */
  lastReason: string;
  /** 开始监管那一刻 agent 的累计 token,用来算"本目标花了多少"。 */
  tokenBaseline: number;
  /** 评估器自身的消耗:它走的是另一个模型,不进 agent 的累计。 */
  evaluatorTokens: number;
  /** 从会话记录恢复而来、还没跑过任何一轮。恢复不自动开跑。 */
  restored: boolean;
}

function readCondition(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const condition = (data as { condition?: unknown }).condition;
  return typeof condition === 'string' && condition.trim() ? condition : undefined;
}

export const goalExtension: Extension = {
  id: 'goal',
  setup(api: ExtensionAPI): void {
    let goal: GoalState | undefined;
    /** 最近一次 usage 事件报出的会话累计 token。 */
    let cumulative = 0;
    let parseFailures = 0;
    /**
     * 进行中的那次评估调用。停止目标时必须把它掐掉:请求还在飞的话,碰上一个
     * 卡住的 goalModel 端点,链条就一直停在 turn_end 钩子里,只剩 ctrl+c 能救。
     */
    let evaluation: AbortController | undefined;

    const maxTurns = (): number => api.config.goalMaxTurns;

    /**
     * 记下会话累计 token。累计值变小意味着 agent 那边把计数清零了(`/new`、
     * `/resume`)——基线不跟着回落的话,spend 会一直被夹成 0。
     */
    const observeSpend = (total: number): void => {
      if (total < cumulative && goal) goal.tokenBaseline = total;
      cumulative = total;
    };
    const spend = (state: GoalState): number =>
      // 夹一下兜底:计数清零与下一次 usage 事件之间仍有一段基线偏高的窗口。
      Math.max(0, cumulative - state.tokenBaseline) + state.evaluatorTokens;

    const showStatus = (evaluating = false): void => {
      if (!goal) {
        api.setStatus(undefined);
        return;
      }
      if (goal.restored) {
        api.setStatus(`${glyphs.goal} ${t('goal.pending')}`);
        return;
      }
      const progress = t('goal.progress', { turn: goal.turns, max: maxTurns() });
      api.setStatus(`${glyphs.goal} ${progress}${evaluating ? ` · ${t('goal.evaluating')}` : ''}`, {
        since: goal.startedAt,
      });
    };

    /** 尽力而为的落盘:状态是附属信息,失败不打扰用户(与 state 记录同理)。 */
    const persist = (condition: string | null): void => {
      void api.appendEntry(GOAL_ENTRY, condition ? { condition } : null).catch(() => {});
    };

    /**
     * 解除目标。每条离开目标的路径都要报一个停止原因——用户得知道循环为什么
     * 停了。persist:false 用在会话切换与"紧接着就要写新目标"的场合。
     */
    const stop = (reason: GoalStopReason, options?: { persist?: boolean }): void => {
      if (!goal) return;
      const state = goal;
      goal = undefined;
      // 在途的评估请求就此作废:结果已经没人要了。
      evaluation?.abort();
      evaluation = undefined;
      api.notify(
        reason === 'met' ? 'info' : 'warn',
        // 八条文案共用一个参数袋:t() 忽略多余参数,各条只取自己关心的。
        t(STOP_MESSAGES[reason], {
          condition: state.condition,
          detail: state.lastReason,
          turns: state.turns,
          elapsed: formatDuration(Date.now() - state.startedAt),
          tokens: formatTokens(spend(state)),
        }),
      );
      api.setStatus(undefined);
      if (options?.persist !== false) persist(null);
    };

    /**
     * 设定(或恢复)目标。恢复来的 `restored` 为真——不自动开跑,等用户下一条
     * 消息才开始监管;打开一个旧会话就凭空烧掉一轮 token 是不可接受的。
     */
    const start = (condition: string, restored: boolean): void => {
      // 旧目标也得有交代,否则用户只看见"已设定 B",永远不知道 A 被丢了。
      // 不落盘:新目标的记录紧随其后,前面多一条 null 只是噪音。
      if (goal) stop('replaced', { persist: false });
      goal = {
        condition,
        startedAt: Date.now(),
        turns: 0,
        lastReason: '',
        tokenBaseline: cumulative,
        evaluatorTokens: 0,
        restored,
      };
      parseFailures = 0;
      api.notify(
        'info',
        restored
          ? t('notice.goalRestored', { condition })
          : t('notice.goalSet', { condition, max: maxTurns() }),
      );
      showStatus();
      if (!restored) persist(condition);
    };

    const statusText = (): string => {
      if (!goal) return t('notice.goalNone');
      if (goal.restored) return t('notice.goalStatusIdle', { condition: goal.condition });
      return t('notice.goalStatus', {
        condition: goal.condition,
        turns: goal.turns,
        max: maxTurns(),
        elapsed: formatDuration(Date.now() - goal.startedAt),
        tokens: formatTokens(spend(goal)),
        reason: goal.lastReason || '—',
      });
    };

    api.onEvent((event) => {
      if (event.type === 'turn-end' || event.type === 'step-end') {
        observeSpend(event.usage.cumulativeTotalTokens);
      } else if (event.type === 'aborted' && evaluation) {
        // 两轮之间按 esc:此刻 run() 正 await 在我们的 turn_end 钩子里,
        // 而 `turn_end` 的 outcome 说的是**上一轮**(它正常收尾了),看不出
        // 用户已经喊停。不掐掉在飞的评估的话,碰上一个卡住的 goalModel 端点
        // 整条链就停在这里,esc 像被吞了,只剩 ctrl+c 能救。
        stop('aborted');
      }
    });

    // 会话就位:从新会话的记录恢复目标;没有就把旧目标(属于换掉的那个会话)
    // 解除——否则它会悄悄接管新会话的轮次。两条路都不落盘:记录属于旧会话。
    api.on('session_start', () => {
      const last = api.entries(GOAL_ENTRY).at(-1);
      const condition = readCondition(last?.data);
      if (condition) start(condition, true);
      else if (goal) stop('cleared', { persist: false });
    });

    // 恢复来的目标在用户真正开跑时才开始计时、计轮、记基线。
    api.on('turn_start', ({ subagent }) => {
      if (subagent || !goal?.restored) return;
      goal.restored = false;
      goal.startedAt = Date.now();
      goal.turns = 0;
      goal.tokenBaseline = cumulative;
      goal.evaluatorTokens = 0;
      parseFailures = 0;
      showStatus();
    });

    api.on('turn_end', async (input) => {
      if (input.subagent || !goal) return;
      const state = goal;
      state.turns += 1;

      // 被 esc 掐了,或以致命错误收尾。两种情况都不能续跑——对着一个 401
      // 或被中断的会话一轮接一轮地重试毫无意义。
      if (input.outcome !== 'completed') {
        stop(input.outcome === 'aborted' ? 'aborted' : 'error');
        return;
      }

      showStatus(true);
      const controller = new AbortController();
      evaluation = controller;
      const result = await evaluateGoal({
        model: api.model(api.config.goalModel),
        condition: state.condition,
        history: api.history(),
        signal: controller.signal,
      });
      if (evaluation === controller) evaluation = undefined;
      // 评估期间目标被解除(/goal clear、计划模式)或换掉了:结果作废。
      if (goal !== state) return;
      state.evaluatorTokens += result.tokens;

      if (!result.verdict) {
        parseFailures += 1;
        if (parseFailures >= MAX_PARSE_FAILURES) {
          stop('check-failed');
          return;
        }
      } else {
        parseFailures = 0;
        state.lastReason = result.verdict.reason;
        if (result.verdict.met) {
          stop('met');
          return;
        }
        api.notify(
          'info',
          t('notice.goalNotMet', {
            reason: result.verdict.reason,
            turn: state.turns,
            max: maxTurns(),
          }),
        );
      }

      if (state.turns >= maxTurns()) {
        stop('max-turns');
        return;
      }
      showStatus();
      api.followUp(guidanceFor(state.condition, state.lastReason));
    });

    // 两轮之间被 esc 停下:排好的续跑没有发生,目标也不能留着。
    api.on('agent_end', ({ subagent, aborted }) => {
      if (subagent || !goal || !aborted) return;
      stop('aborted');
    });

    api.on('session_shutdown', () => {
      evaluation?.abort();
    });

    api.registerCommand('goal', {
      description: t('cmd.goal'),
      argumentHint: '<condition> | clear',
      handler: (args) => {
        const arg = args.trim();
        // 裸 /goal 报状态、`/goal clear` 取消:这两支任何时候都可用——clear
        // 正是停下循环的手段,拦忙就没法停了。
        if (!arg) {
          api.notify('info', statusText());
          return;
        }
        if (GOAL_CLEAR_WORDS.has(arg.toLowerCase())) {
          if (goal) stop('cleared');
          else api.notify('info', t('notice.goalNone'));
          return;
        }
        // 这一支会发起一轮,运行中拒绝(客户端不替扩展拦忙)。
        if (api.isRunning()) {
          api.notify('warn', t('notice.busyCommand', { name: 'goal' }));
          return;
        }
        start(arg, false);
        // 空闲:立即开一轮,条件原文就是第一轮的指令(进历史、进时间线)。
        api.followUp(arg);
      },
    });
  },
};
