/**
 * 时间线滚动区:定稿条目(items,不可变、memo)+ 尾部的活动区(流式文本、
 * 进行中的工具行)。自动粘底:用户上滚翻历史时暂停跟随,滚回底部恢复。
 * 空会话(还没有任何用户/助手条目)渲染 ZCode 式空状态:时段问候居中。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTimelineStore } from '../state/timelineStore.js';
import { useLocale, t } from '../i18n/index.js';
import { currentGreetingKey } from '../utils/greeting.js';
import { formatDuration } from '../utils/format.js';
import { TimelineItemView } from './TimelineItemView.js';
import { Markdown } from './Markdown.js';

/** 空状态:按时段问候(ZCode 同款),居中。 */
function EmptyState() {
  useLocale();
  return (
    <div className="empty-state">
      <div className="empty-greeting">{t(currentGreetingKey())}</div>
    </div>
  );
}

/** 进行中的工具行(含子 agent 进度贴条)。bash 显示「正在运行 <命令>」(设计稿)。 */
function ActiveToolRow({
  call,
}: {
  call: { callId: string; toolName: string; input: unknown; startedAt: number };
}) {
  useLocale();
  const progress = useTimelineStore((s) => s.taskProgress[call.callId]);
  const elapsed = Date.now() - call.startedAt;
  const command =
    call.toolName === 'bash'
      ? (call.input as { command?: string } | undefined)?.command
      : undefined;
  return (
    <div className="tool-card tool-active">
      <div className="tool-row">
        {command !== undefined ? (
          <span className="tool-name tool-running-label">
            {t('timeline.running')} <code>{command}</code>
          </span>
        ) : (
          <span className="tool-name">{call.toolName}</span>
        )}
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
  const activeText = useTimelineStore((s) => s.activeText);
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

  // 对话尚未开始(无用户/助手条目且无流式文本)→ 空状态问候。
  const empty =
    !activeText && items.every((item) => item.kind !== 'user' && item.kind !== 'assistant');
  // 空状态只留问候:banner 的信息(模型/目录/模式)已由顶栏与 Composer 承载。
  const visibleItems = empty ? items.filter((item) => item.kind !== 'banner') : items;

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll}>
      <div className="timeline-inner conv-col">
        {empty ? <EmptyState /> : null}
        {visibleItems.map((item) => (
          <TimelineItemView key={item.key} item={item} />
        ))}
        <ActiveArea />
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
