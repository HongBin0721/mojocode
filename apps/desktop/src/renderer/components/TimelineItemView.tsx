/**
 * 单条时间线条目:按 kind 分发。用户消息是右对齐气泡(ZCode 形态),助手
 * 消息平铺 markdown,工具折叠卡,diff/plan/todo 各有专门渲染。
 */

import React, { memo } from 'react';
import type { TimelineItem } from '@core/types';
import { extractPlan, extractTodos } from '@core/timeline-data';
import { Markdown } from './Markdown.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { ToolCard } from './ToolCard.js';
import { TurnLine } from './TurnLine.js';
import { TodoList } from './TodoList.js';
import { localizeMode } from '../utils/mode-label.js';
import { useLocale } from '../i18n/index.js';

/** banner 单独成组件:它是唯一要跟随语言重渲染的分支(模式 pill 走
 * localizeMode),locale 订阅只挂在这里——挂在外层会让长会话的每一条
 * 时间线项都进 i18n 的 listener 集合,memo 形同虚设。 */
function BannerItem({ item }: { item: Extract<TimelineItem, { kind: 'banner' }> }) {
  useLocale();
  return (
    <div className="banner">
      <span className="banner-title">{item.providerLabel}</span>
      <span className="banner-model">{item.model}</span>
      <span className="banner-root" title={item.root}>
        {item.root}
      </span>
      <span className="banner-mode">{localizeMode(item.mode)}</span>
      {item.mcpSummary ? <span className="banner-mcp">MCP {item.mcpSummary}</span> : null}
    </div>
  );
}

export const TimelineItemView = memo(function TimelineItemView({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="entry entry-user">
          <div className="entry-bubble">
            {item.text.split('\n').map((line, index) => (
              <div key={index}>{line || ' '}</div>
            ))}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className={`entry entry-assistant ${item.continuation ? 'entry-continuation' : ''}`}>
          <div className="entry-body">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case 'reasoning':
      return <ReasoningBlock durationMs={item.durationMs} text={item.text} />;
    case 'tool': {
      const plan = extractPlan(item);
      if (plan) {
        return (
          <div className="plan-card">
            <div className="plan-title">PLAN</div>
            <Markdown text={plan} />
          </div>
        );
      }
      const todos = extractTodos(item);
      if (todos) return <TodoList todos={todos} />;
      return (
        <ToolCard
          toolName={item.toolName}
          input={item.input}
          summary={item.summary}
          output={item.output}
          isError={item.isError}
          durationMs={item.durationMs}
        />
      );
    }
    case 'turn':
      return (
        <TurnLine
          model={item.model}
          durationMs={item.durationMs}
          tokens={item.tokens}
          inputTokens={item.inputTokens}
          cachedTokens={item.cachedTokens}
        />
      );
    case 'notice':
      return <div className={`notice notice-${item.level}`}>{item.message}</div>;
    case 'error':
      return <div className="entry-error">{item.message}</div>;
    case 'divider':
      return <div className="divider">{item.label}</div>;
    case 'collapsed':
      return (
        <div className="divider">⋯ {item.count}</div>
      );
    case 'banner':
      return <BannerItem item={item} />;
    default:
      return null;
  }
});
