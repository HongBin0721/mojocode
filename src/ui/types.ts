export type TimelineItem =
  | { key: string; kind: 'user'; text: string }
  | { key: string; kind: 'assistant'; text: string }
  | { key: string; kind: 'reasoning'; text: string }
  | {
      key: string;
      kind: 'tool';
      toolName: string;
      input: unknown;
      summary: string;
      output: unknown;
      isError: boolean;
      durationMs: number;
    }
  | { key: string; kind: 'notice'; level: 'info' | 'warn'; message: string }
  | { key: string; kind: 'error'; message: string }
  | { key: string; kind: 'divider'; label: string };

/** Plain `Omit` collapses a union to its common keys; this keeps each variant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A timeline item before the renderer assigns it a key. */
export type NewTimelineItem = DistributiveOmit<TimelineItem, 'key'>;

export interface ActiveToolCall {
  callId: string;
  toolName: string;
  input: unknown;
  startedAt: number;
}
