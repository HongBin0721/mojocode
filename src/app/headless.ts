import type { AgentEvent, PermissionAsker, PermissionDecision } from '../core/events.js';
import type { PermissionMode } from '../config/schema.js';
import type { Session } from './bootstrap.js';
import { t } from '../i18n/index.js';

export interface HeadlessOptions {
  /** 输出以换行分隔的 JSON 事件,而不是普通文本。 */
  json: boolean;
  stream: NodeJS.WriteStream;
  /** 进度/工具行的输出目标,使 stdout 保持可用于管道。 */
  errStream: NodeJS.WriteStream;
}

/**
 * `kdg -p "..."` 的非交互式渲染。
 *
 * assistant 文本输出到 stdout,保证 `kdg -p ... | less` 可用;其他内容
 * (工具调用、通知、错误)都输出到 stderr。
 */
export function renderHeadless(session: Session, options: HeadlessOptions): void {
  const { stream, errStream, json } = options;

  session.bus.on((event: AgentEvent) => {
    if (json) {
      errStream.write(`${JSON.stringify(serializable(event))}\n`);
      if (event.type === 'text-delta') stream.write(event.text);
      return;
    }

    switch (event.type) {
      case 'text-delta':
        stream.write(event.text);
        break;
      case 'text-end':
        stream.write('\n');
        break;
      case 'tool-start':
        errStream.write(`  · ${event.toolName}\n`);
        break;
      case 'tool-end':
        errStream.write(`    ${event.isError ? '✗' : '⎿'} ${event.summary}\n`);
        break;
      case 'compaction':
        errStream.write(`  · ${t('headless.compacted', { n: event.removedMessages })}\n`);
        break;
      case 'notice':
        errStream.write(`  ${event.level === 'warn' ? '!' : '·'} ${event.message}\n`);
        break;
      case 'error':
        errStream.write(`  ✗ ${event.error.message}\n`);
        break;
      case 'aborted':
        errStream.write(`  ! ${t('headless.interrupted')}\n`);
        break;
      case 'turn-end':
        errStream.write(
          `  · ${t('headless.turnEnd', {
            tokens: event.usage.cumulativeTotalTokens,
            reason: event.finishReason,
          })}\n`,
        );
        break;
      default:
        break;
    }
  });
}

/**
 * 非交互运行的权限策略:没有人可以询问,所以任何需要确认的操作都会被
 * 拒绝,并附上模型可据此行动的解释。`--yolo` / `--accept-edits` 是逃生门。
 */
export function headlessAsker(mode: PermissionMode): PermissionAsker {
  return async (request): Promise<PermissionDecision> => ({
    type: 'deny',
    reason:
      `no interactive terminal to approve "${request.title}" (permission mode: ${mode}). ` +
      'Re-run with --accept-edits to allow file edits, or --yolo to allow everything.',
  });
}

/** Error 默认无法 JSON 序列化;把有用的部分拆出来。 */
function serializable(event: AgentEvent): unknown {
  if (event.type === 'error') {
    return { type: 'error', message: event.error.message, recoverable: event.recoverable };
  }
  return event;
}
