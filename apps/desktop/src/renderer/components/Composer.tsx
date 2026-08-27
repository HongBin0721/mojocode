/**
 * 输入区(设计稿胶囊工具条)——外壳:textarea + 键盘状态机(slash 菜单
 * 导航/提交/权限循环三者的胶水)+ 提交;斜杠命令、附件、工具栏、上下文环
 * 在 composer/ 子目录(use-slash-commands / use-attachments /
 * ComposerToolbar / ContextRing / use-flash)。
 *
 * 键盘:Enter 提交 / Shift+Enter 换行;`Shift+Tab` 循环权限档;`/` 开头弹
 * 命令菜单;粘贴与拖入图片 → 缩略图附件 chips(拖入非图片忽略)。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useTimelineStore } from '../state/timelineStore.js';
import { rpcFire } from '../bridge/invoke.js';
import { t, useLocale } from '../i18n/index.js';
import { cyclePermissionsRpc } from '../commands/permissions.js';
import { SlashMenu } from './SlashMenu.js';
import { useSlashCommands } from './composer/use-slash-commands.js';
import { useAttachments } from './composer/use-attachments.js';
import { imageDataUri } from '../utils/image.js';
import { ComposerToolbar } from './composer/ComposerToolbar.js';
import { ImagePreview } from './overlays/ImagePreview.js';
import type { ImageAttachment } from '@core/attachments';

export function Composer() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  const snapshot = useDesktopStore((s) => s.snapshot);
  const composerPrefill = useDesktopStore((s) => s.composerPrefill);
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 外部预填(评审面板「请求修改」等):nonce 变化即取 text 填入并聚焦。
  useEffect(() => {
    if (!composerPrefill) return;
    setText(composerPrefill.text);
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nonce 即意图。
  }, [composerPrefill?.nonce]);

  const attachments = useAttachments();
  // 点开的大图预览;chip 删除/提交清空不追着关(preview 持有自己的引用)。
  const [preview, setPreview] = useState<ImageAttachment | null>(null);
  const slash = useSlashCommands({ text, setText });

  const running = snapshot?.agent.isRunning ?? false;
  const canSend =
    connection === 'connected' && (text.trim().length > 0 || attachments.images.length > 0);

  /** 手打提交:`/xxx args` 按命令执行,其余按普通消息发送。 */
  const submit = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    if (!attachments.images.length && slash.tryExecuteSlash(trimmed)) return;
    const images = attachments.images;
    setText('');
    attachments.clear();
    slash.resetSuppressed();
    const sentText = trimmed || '(image)';
    // 图随消息展示:turn-start 不带字节,提交方在发 RPC 前把原图暂存给
    // 时间线(按聚焦任务),turn-start 落地时按文本核对后缝到用户条目上。
    // 发送失败要显式回收——没有 turn-start 会来消费它。
    const taskId = useTimelineStore.getState().focusedTaskId;
    if (images.length && taskId) {
      useTimelineStore.getState().stashPendingImages(taskId, sentText, images);
    }
    rpcFire(
      {
        kind: 'run',
        text: sentText,
        options: images.length ? { images } : undefined,
      },
      {
        errorKey: 'notice.runFailed',
        onError: () => {
          if (taskId) useTimelineStore.getState().dropPendingImages(taskId);
        },
      },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab:权限档循环(Codex/ZCode 同款按键)。
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (snapshot) rpcFire(cyclePermissionsRpc(snapshot.config));
      return;
    }
    if (slash.menuVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slash.setCursor((slash.safeCursor + 1) % slash.entries.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slash.setCursor((slash.safeCursor - 1 + slash.entries.length) % slash.entries.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        slash.pickFromMenu(slash.entries[slash.safeCursor]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slash.suppress();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // 高度自适应:按内容收缩/增长,封顶 156px(超出内部滚动)。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  }, [text]);

  const primaryAction = () => {
    if (running) rpcFire({ kind: 'abort' });
    else submit();
  };

  return (
    <div className="composer conv-col">
      {slash.menuVisible ? (
        <SlashMenu
          entries={slash.entries}
          cursor={slash.safeCursor}
          onHover={slash.setCursor}
          onPick={slash.pickFromMenu}
        />
      ) : null}
      <div
        className={`composer-box${attachments.dragging ? ' composer-box-dragging' : ''}`}
        onDragOver={attachments.onDragOver}
        onDragLeave={attachments.onDragLeave}
        onDrop={attachments.onDrop}
      >
        {attachments.images.length > 0 ? (
          <div className="composer-attachments">
            {attachments.images.map((image, index) => (
              <span key={index} className="attachment-chip">
                <button
                  type="button"
                  className="attachment-thumb-button"
                  aria-label={t('image.viewFull')}
                  onClick={() => setPreview(image)}
                >
                  <img className="attachment-thumb" src={imageDataUri(image)} alt="" />
                </button>
                <span className="attachment-name">{image.filename ?? image.mediaType}</span>
                <button type="button" className="chip-remove" onClick={() => attachments.removeAt(index)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={text}
          placeholder={running ? t('composer.placeholderRunning') : t('composer.placeholder')}
          onChange={(e) => {
            setText(e.target.value);
            slash.onTextChange(e.target.value);
          }}
          onPaste={attachments.onPaste}
          onKeyDown={onKeyDown}
        />
        <ComposerToolbar
          running={running}
          canSend={canSend}
          onPrimary={primaryAction}
          onAddFiles={attachments.addFiles}
        />
        {attachments.dragging ? (
          <div className="composer-drag-overlay">
            <span className="composer-drag-pill">{t('composer.dropHint')}</span>
          </div>
        ) : null}
      </div>
      {preview ? <ImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
