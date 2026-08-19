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
import { rpcFire } from '../bridge/invoke.js';
import { t, useLocale } from '../i18n/index.js';
import { cyclePermissionsRpc } from '../commands/permissions.js';
import { SlashMenu } from './SlashMenu.js';
import { useSlashCommands } from './composer/use-slash-commands.js';
import { useAttachments } from './composer/use-attachments.js';
import { ComposerToolbar } from './composer/ComposerToolbar.js';

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
    rpcFire(
      {
        kind: 'run',
        text: trimmed || '(image)',
        options: images.length ? { images } : undefined,
      },
      { errorKey: 'notice.runFailed' },
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
                <img className="attachment-thumb" src={`data:${image.mediaType};base64,${image.data}`} alt="" />
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
    </div>
  );
}
