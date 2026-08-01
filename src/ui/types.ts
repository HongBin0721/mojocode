export type TimelineItem =
  | { key: string; kind: 'user'; text: string }
  | {
      key: string;
      kind: 'assistant';
      text: string;
      /** 同一条流式回复的后续片段(段落增量提交):渲染时不再带 ● 前缀。 */
      continuation?: boolean;
    }
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

/** 普通 `Omit` 会把联合类型折叠成公共键;这个写法保留每个变体。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 渲染器分配 key 之前的时间线条目。 */
export type NewTimelineItem = DistributiveOmit<TimelineItem, 'key'>;

export interface ActiveToolCall {
  callId: string;
  toolName: string;
  input: unknown;
  startedAt: number;
}
