import type { AgentEvent, PermissionAsker, PermissionDecision } from '../core/events.js';
import type { PermissionMode } from '../config/schema.js';
import type { Session } from './bootstrap.js';
import { t } from '../i18n/index.js';

export interface HeadlessOptions {
  /** Emit newline-delimited JSON events instead of prose. */
  json: boolean;
  stream: NodeJS.WriteStream;
  /** Where progress/tool lines go, so stdout stays pipeable. */
  errStream: NodeJS.WriteStream;
}

/**
 * Non-interactive rendering for `kdg -p "..."`.
 *
 * Assistant text goes to stdout so `kdg -p ... | less` works; everything else
 * (tool calls, notices, errors) goes to stderr.
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
 * Permission policy for non-interactive runs: there is nobody to ask, so
 * anything that would prompt is denied with an explanation the model can act on.
 * `--yolo` / `--accept-edits` are the escape hatches.
 */
export function headlessAsker(mode: PermissionMode): PermissionAsker {
  return async (request): Promise<PermissionDecision> => ({
    type: 'deny',
    reason:
      `no interactive terminal to approve "${request.title}" (permission mode: ${mode}). ` +
      'Re-run with --accept-edits to allow file edits, or --yolo to allow everything.',
  });
}

/** Errors are not JSON-serialisable by default; unwrap the useful bits. */
function serializable(event: AgentEvent): unknown {
  if (event.type === 'error') {
    return { type: 'error', message: event.error.message, recoverable: event.recoverable };
  }
  return event;
}
