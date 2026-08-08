export type TimelineItem =
  | { key: string; kind: 'user'; text: string }
  | {
      key: string;
      kind: 'assistant';
      text: string;
      /** 同一条流式回复的后续片段(段落增量提交):渲染时不再带 ● 前缀。 */
      continuation?: boolean;
    }
  /**
   * 一次思考。默认只渲染收尾的一行「已思考 8.2s」——整段思考常驻时间线
   * 会淹没真正的回复和工具记录;正文随条目留着,ctrl+r 展开详情时才摊开
   * (回放出来的历史思考没有耗时,只有正文)。
   */
  | { key: string; kind: 'reasoning'; durationMs?: number; text: string }
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
  /**
   * 一轮的收尾行(模型 · 耗时 · 本轮 token)。只在正常收尾(turn-end)时落,
   * 中断与出错各有自己的一行,不重复画。tokens 取会话累计量在本轮的增量,
   * 因此含工具与子 agent 折进来的开销。
   */
  | { key: string; kind: 'turn'; model: string; durationMs: number; tokens: number }
  | { key: string; kind: 'notice'; level: 'info' | 'warn'; message: string }
  | { key: string; kind: 'error'; message: string }
  | { key: string; kind: 'divider'; label: string }
  /** /focus 折叠档位下,一段被隐藏的工具调用的占位(见 src/ui/focus.ts)。 */
  | { key: string; kind: 'collapsed'; count: number }
  | {
      /**
       * 启动横幅。作为时间线的第一条条目固定在对话最顶部,随历史自然
       * 滚动——与 Claude Code 一致。字段是创建时的快照,之后改 model/
       * 权限档不回写(实时值在 Footer 常驻)。
       */
      key: string;
      kind: 'banner';
      providerLabel: string;
      model: string;
      root: string;
      mode: string;
      mcpSummary?: string;
    };

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
