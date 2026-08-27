// @vitest-environment jsdom
/**
 * 会话时间线的用户消息图片展示:
 *  - UserEntry 渲染缩略图,点开大图(ImagePreview)。带了字节的图不会再在
 *    正文里留 `[image: …]` 标签(replay 侧决定),渲染层不做字符串剥离;
 *  - timelineStore 的提交暂存(stashPendingImages)在 turn-start 落地时
 *    缝到用户条目上——数量与 imageCount 对不上则只清不缝(引导注入的
 *    遗留暂存不能错缝到之后的纯文本消息)。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLocale } from '../../src/renderer/i18n/index.js';
import { TimelineItemView } from '../../src/renderer/components/TimelineItemView.js';
import { useTimelineStore } from '../../src/renderer/state/timelineStore.js';
import type { TimelineCtx } from '../../src/renderer/state/timelineReducer.js';

setLocale('zh-CN');

const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=', filename: 'clipboard-1.png' };

const ctx: TimelineCtx = {
  getConfig: () => ({ plan: false }),
} as unknown as TimelineCtx;

describe('UserEntry 附图渲染', () => {
  it('缩略图渲染在气泡上方;点缩略图开大图', () => {
    const { unmount } = render(
      <TimelineItemView
        item={{ key: 'u1', kind: 'user', text: '看这个', images: [IMG] }}
      />,
    );
    const bubble = document.querySelector('.entry-bubble')!;
    expect(bubble.textContent).toContain('看这个');
    const thumb = document.querySelector('img.entry-image-thumb')!;
    expect(thumb.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    // 缩略图行在气泡上方(entry-user 列内先图后泡)。
    const row = document.querySelector('.entry-images')!;
    expect(row.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看大图' }));
    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy();
    unmount();
  });

  it('纯图片消息(正文为空):只有缩略图行,不渲染空气泡', () => {
    const { unmount } = render(
      <TimelineItemView
        item={{ key: 'u3', kind: 'user', text: '', images: [IMG] }}
      />,
    );
    expect(document.querySelector('.entry-image-thumb')).toBeTruthy();
    expect(document.querySelector('.entry-bubble')).toBeNull();
    unmount();
  });

  it('无附图的用户消息渲染不变(占位标签原样保留)', () => {
    const { unmount } = render(
      <TimelineItemView item={{ key: 'u2', kind: 'user', text: '[image: shot.png]' }} />,
    );
    expect(document.querySelector('.entry-image-thumb')).toBeNull();
    expect(document.querySelector('.entry-bubble')!.textContent).toContain('[image: shot.png]');
    unmount();
  });
});

describe('timelineStore 提交暂存', () => {
  beforeEach(() => {
    useTimelineStore.setState({ byTask: {}, focusedTaskId: 't1', pendingImages: {}, items: [] });
  });

  it('turn-start 且张数/文本都匹配:暂存缝到用户条目并清空', () => {
    const store = useTimelineStore.getState();
    store.stashPendingImages('t1', '看图', [IMG]);
    store.applyEvent('t1', { type: 'turn-start', userText: '看图', imageCount: 1 }, ctx);

    const state = useTimelineStore.getState();
    const last = state.byTask['t1']!.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'user', text: '看图', images: [IMG] });
    expect(state.pendingImages['t1']).toBeUndefined();
  });

  it('张数不匹配(引导注入遗留):只清空不缝', () => {
    const store = useTimelineStore.getState();
    store.stashPendingImages('t1', '看图', [IMG]);
    store.applyEvent('t1', { type: 'turn-start', userText: '纯文本' }, ctx);

    const state = useTimelineStore.getState();
    const last = state.byTask['t1']!.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'user', text: '纯文本' });
    expect('images' in last).toBe(false);
    expect(state.pendingImages['t1']).toBeUndefined();
  });

  // inject 不发 turn-start,遗留暂存会活到下一条消息;张数可能凑巧相同,
  // 文本比对是「宁可不缝也不错缝」的那道闸。
  it('张数相同但文本不同:不缝(错缝防线)', () => {
    const store = useTimelineStore.getState();
    store.stashPendingImages('t1', '运行中粘的图', [IMG]);
    store.applyEvent('t1', { type: 'turn-start', userText: '后来的另一条', imageCount: 1 }, ctx);

    const state = useTimelineStore.getState();
    const last = state.byTask['t1']!.items.at(-1)!;
    expect('images' in last).toBe(false);
    expect(state.pendingImages['t1']).toBeUndefined();
  });

  it('暂存按任务隔离:别的任务的 turn-start 不消费', () => {
    const store = useTimelineStore.getState();
    store.stashPendingImages('t1', '看图', [IMG]);
    store.applyEvent('t2', { type: 'turn-start', userText: '别的任务', imageCount: 1 }, ctx);

    expect(useTimelineStore.getState().pendingImages['t1']).toEqual({ text: '看图', images: [IMG] });
  });

  it('dropPendingImages 回收(run RPC 失败时没有 turn-start 来消费)', () => {
    const store = useTimelineStore.getState();
    store.stashPendingImages('t1', '看图', [IMG]);
    store.dropPendingImages('t1');
    expect(useTimelineStore.getState().pendingImages['t1']).toBeUndefined();
  });

  // 桶被 LRU 淘汰 = 这个任务的 turn-start 永远不会来;不清就泄漏到窗口关闭。
  // (只认真被淘汰的 id:按「不在 byTask 里」一刀切会误伤上一条那种
  // 刚暂存、桶还没建起来的任务。)
  it('时间线桶被 LRU 淘汰的任务,其暂存一并回收', () => {
    const store = useTimelineStore.getState();
    // 先建桶再暂存:turn-start 自己就会清暂存,顺序反了这条会假阳性——
    // 清理必须由 LRU 淘汰独家完成。
    store.applyEvent('gone', { type: 'turn-start', userText: '开场' }, ctx);
    useTimelineStore.getState().stashPendingImages('gone', '旧图', [IMG]);
    expect(useTimelineStore.getState().byTask['gone']).toBeTruthy();
    for (const id of ['a', 'b', 'c']) {
      useTimelineStore.getState().applyEvent(id, { type: 'turn-start', userText: id }, ctx);
    }

    const state = useTimelineStore.getState();
    expect(state.byTask['gone']).toBeUndefined();
    expect(state.pendingImages['gone']).toBeUndefined();
  });
});
