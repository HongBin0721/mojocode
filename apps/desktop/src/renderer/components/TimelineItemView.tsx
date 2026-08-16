/**
 * 单条时间线条目:按 kind 分发(M3 会给 tool 的 diff 输出加 DiffView、
 * 给 exit_plan 加 PlanCard)。
 */

import React, { memo } from 'react';
import type { TimelineItem } from '@core/types';
import { extractPlan, extractTodos } from '@core/timeline-data';
import { Markdown } from './Markdown.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { ToolCard } from './ToolCard.js';
import { TurnLine } from './TurnLine.js';
import { TodoList } from './TodoList.js';

export const TimelineItemView = memo(function TimelineItemView({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="entry entry-user">
          <div className="entry-role">›</div>
          <div className="entry-body">
            {item.text.split('\n').map((line, index) => (
              <div key={index}>{line || ' '}</div>
            ))}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className={`entry entry-assistant ${item.continuation ? 'entry-continuation' : ''}`}>
          {item.continuation ? null : <div className="entry-bullet">●</div>}
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
      return (
        <div className="banner">
          <span className="banner-title">{item.providerLabel}</span>
          <span className="banner-model">{item.model}</span>
          <span className="banner-root" title={item.root}>
            {item.root}
          </span>
          <span className="banner-mode">{item.mode}</span>
          {item.mcpSummary ? <span className="banner-mcp">MCP {item.mcpSummary}</span> : null}
        </div>
      );
    default:
      return null;
  }
});
