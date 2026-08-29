/**
 * 单条时间线条目:按 kind 分发。用户消息是右对齐气泡(ZCode 形态),助手
 * 消息平铺 markdown,工具折叠卡,diff/plan/todo 各有专门渲染。
 */

import React, { memo, useState } from 'react';
import type { TimelineImage, TimelineItem } from '@core/types';
import { extractPlan, extractTodos } from '@core/timeline-data';
import { imageDataUri } from '../utils/image.js';
import { ImagePreview } from './overlays/ImagePreview.js';
import { Markdown } from './Markdown.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { ToolCard } from './ToolCard.js';
import { TurnLine } from './TurnLine.js';
import { TodoList } from './TodoList.js';
import { localizeMode } from '../utils/mode-label.js';
import { parsePlanSteps } from '../utils/plan-steps.js';
import { t, useLocale } from '../i18n/index.js';
import { CheckCircleIcon, CircleDashedIcon, SparkleIcon } from './icons.js';

/** 计划卡:解析出步骤列表按设计稿渲染(勾/虚线圈);解析不出回退 Markdown。 */
function PlanCard({ plan }: { plan: string }) {
  useLocale();
  const steps = parsePlanSteps(plan);
  return (
    <div className="plan-card">
      <div className="plan-title">{t('plan.title')}</div>
      {steps ? (
        <div className="plan-steps">
          {steps.map((step, index) => (
            <div key={index} className={`plan-step ${step.done ? 'plan-step-done' : ''}`}>
              {step.done ? (
                <CheckCircleIcon size={14} weight="fill" />
              ) : (
                <CircleDashedIcon size={14} />
              )}
              <span>{step.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <Markdown text={plan} />
      )}
    </div>
  );
}

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

/**
 * 用户消息的随附图:缩略图行 + 大图预览。单独成组件是为了把 useLocale 的
 * 订阅关在这里——挂到 UserEntry 上,长会话里每一条用户消息(绝大多数没有
 * 图、没有任何随语言变的字符)都会进 i18n 的 listener 集合,正是本文件
 * BannerItem 处注释禁止的那件事。
 */
function UserImages({ images }: { images: TimelineImage[] }) {
  useLocale();
  const [preview, setPreview] = useState<TimelineImage | null>(null);
  return (
    <>
      <div className="entry-images">
        {images.map((image, index) => (
          <button
            key={index}
            type="button"
            className="entry-image-button"
            aria-label={t('image.viewFull')}
            onClick={() => setPreview(image)}
          >
            <img className="entry-image-thumb" src={imageDataUri(image)} alt={image.filename ?? ''} />
          </button>
        ))}
      </div>
      {preview ? <ImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

/**
 * 用户条目:随附图缩略图(在气泡上方)+ 文本气泡。text 一律是"用户当时输入
 * 的原文"——带了字节的图不会再在正文里留 `[image: …]` 标签(replay 侧决定),
 * 所以这里不做任何字符串剥离。
 */
function UserEntry({ item }: { item: Extract<TimelineItem, { kind: 'user' }> }) {
  const images = item.images;
  return (
    <div className="entry entry-user">
      {images?.length ? <UserImages images={images} /> : null}
      {item.text ? (
        <div className="entry-bubble">
          {item.text.split('\n').map((line, index) => (
            <div key={index}>{line || ' '}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const TimelineItemView = memo(function TimelineItemView({
  item,
  thoughtMs,
  thoughtText,
}: {
  item: TimelineItem;
  /** 渲染期分组把「微思考」并进工具卡 meta(见 utils/timeline-groups.ts)。 */
  thoughtMs?: number;
  thoughtText?: string;
}) {
  switch (item.kind) {
    case 'user':
      return <UserEntry item={item} />;
    case 'assistant':
      return (
        <div className={`entry entry-assistant ${item.continuation ? 'entry-continuation' : ''}`}>
          {/* 22px sparkle 头像方块(设计稿);同一轮的续段不重复头像 */}
          {!item.continuation ? (
            <span className="entry-avatar">
              <SparkleIcon size={12} />
            </span>
          ) : (
            <span className="entry-avatar entry-avatar-ghost" />
          )}
          <div className="entry-body">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case 'reasoning':
      return <ReasoningBlock durationMs={item.durationMs} text={item.text} />;
    case 'tool': {
      const plan = extractPlan(item);
      if (plan) return <PlanCard plan={plan} />;
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
          thoughtMs={thoughtMs}
          thoughtText={thoughtText}
        />
      );
    }
    case 'turn':
      return (
        <TurnLine
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
    // 'collapsed' 只由 TUI 的 /focus 产生,GUI 没有对应入口——落到 default 不渲染。
    case 'banner':
      return <BannerItem item={item} />;
    default:
      return null;
  }
});
