/**
 * 非末次 todo 调用的一行差分:「✓ 完成 X」/「+ 新增 X」/「清单已更新」。
 * 完整清单只在最后一次调用处渲染(TodoPanel 亦常驻),避免同一份清单在
 * 时间线上被重印多遍(见 utils/timeline-groups.ts)。
 */

import React from 'react';
import { useLocale, t } from '../i18n/index.js';

/** 一个桶的文案:首条内容 + 「等 N 项」计数。 */
function segment(key: 'todo.updateCompleted' | 'todo.updateAdded', bucket: string[]): string {
  return (
    t(key, { content: bucket[0]! }) +
    (bucket.length > 1 ? t('todo.updateMore', { count: bucket.length - 1 }) : '')
  );
}

export function TodoUpdateLine({ completed, added }: { completed: string[]; added: string[] }) {
  useLocale();
  const done = completed.length > 0;
  // 同一次更新可能既完成又新增:两个桶都报,漏掉哪个这步的记录都不完整。
  const segments: string[] = [];
  if (done) segments.push(segment('todo.updateCompleted', completed));
  if (added.length > 0) segments.push(segment('todo.updateAdded', added));
  return (
    <div className={`todo-update ${done ? 'todo-update-done' : ''}`}>
      <span className="todo-update-mark" aria-hidden>
        {done ? '✓' : '+'}
      </span>
      {segments.length > 0 ? segments.join(' · ') : t('todo.updated')}
    </div>
  );
}
