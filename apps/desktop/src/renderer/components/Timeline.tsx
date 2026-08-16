/**
 * 时间线滚动区:定稿条目(items,不可变、memo)+ 尾部的活动区(流式文本、
 * 进行中的工具行)。自动粘底:用户上滚翻历史时暂停跟随,滚回底部恢复。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTimelineStore } from '../state/timelineStore.js';
import { formatDuration } from '../utils/format.js';
import { TimelineItemView } from './TimelineItemView.js';
import { Markdown } from './Markdown.js';

/** 进行中的工具行(含子 agent 进度贴条)。 */
function ActiveToolRow({ call }: { call: { callId: string; toolName: string; startedAt: number } }) {
  const progress = useTimelineStore((s) => s.taskProgress[call.callId]);
  const elapsed = Date.now() - call.startedAt;
  return (
    <div className="tool-card tool-active">
      <div className="tool-row">
        <span className="tool-name">{call.toolName}</span>
        {progress ? (
          <span className="tool-summary">
            {progress.steps} steps · {progress.currentTool ? `${progress.currentTool}…` : ''}
          </span>
        ) : null}
        <span className="tool-duration">{formatDuration(elapsed)}</span>
        <span className="spinner">⠋</span>
      </div>
      {progress?.recentCalls?.length ? (
        <div className="task-trace">
          {progress.recentCalls.map((recent, index) => (
            <div key={index} className="task-trace-row">
              ↳ {recent.toolName}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 流式活动区:正在生成的尾段 + 进行中的工具行。 */
function ActiveArea() {
  const activeText = useTimelineStore((s) => s.activeText);
  const textCommitted = useTimelineStore((s) => s.textCommitted);
  const activeReasoning = useTimelineStore((s) => s.activeReasoning);
  const activeTools = useTimelineStore((s) => s.activeTools);
  if (!activeText && !activeReasoning && activeTools.length === 0) return null;
  return (
    <div className="active-area">
      {activeReasoning ? <div className="active-reasoning">{activeReasoning.slice(-2000)}</div> : null}
      {activeTools.map((call) => (
        <ActiveToolRow key={call.callId} call={call} />
      ))}
      {activeText ? (
        <div className={`entry entry-assistant ${textCommitted ? 'entry-continuation' : ''}`}>
          {textCommitted ? null : <div className="entry-bullet">●</div>}
          <div className="entry-body">
            <Markdown text={activeText} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Timeline() {
  const items = useTimelineStore((s) => s.items);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items, pinned]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll}>
      {items.map((item) => (
        <TimelineItemView key={item.key} item={item} />
      ))}
      <ActiveArea />
      <div ref={bottomRef} />
    </div>
  );
}
