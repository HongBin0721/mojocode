/**
 * 输入区(Codex 式):多行 textarea,Enter 提交 / Shift+Enter 换行;
 * `Shift+Tab` 循环权限档(read-only→ask→auto→full-access→plan,逻辑在
 * commands/permissions.ts);`/` 开头弹命令菜单(内置 + 技能,空格后进入
 * 参数态);粘贴图片;运行中变「中断」。`/xxx args` 形态的提交按命令分发。
 */

import React, { useMemo, useRef, useState } from 'react';
import type { ImageAttachment } from '@core/attachments';
import { useDesktopStore } from '../state/desktopStore.js';
import { t, useLocale } from '../i18n/index.js';
import {
  builtinCommands,
  filterCommands,
  skillCommands,
  slashState,
  type CommandEntry,
} from '../commands/index.js';
import { cyclePermissionsRpc } from '../commands/permissions.js';
import { SlashMenu } from './SlashMenu.js';

/** 剪贴板里的图片文件 → ImageAttachment(base64)。 */
async function toAttachment(file: File, index: number): Promise<ImageAttachment> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return {
    mediaType: file.type || 'image/png',
    data: btoa(binary),
    filename: file.name || `clipboard-${index}.png`,
  };
}

const rpc = (request: Parameters<typeof window.mojocode.rpc>[0]) =>
  void window.mojocode.rpc(request).catch((error: unknown) => console.error('RPC 失败', error));

export function Composer() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  const snapshot = useDesktopStore((s) => s.snapshot);
  const requestModelsMenu = useDesktopStore((s) => s.requestModelsMenu);
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [cursor, setCursor] = useState(0);
  const [suppressed, setSuppressed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const running = snapshot?.agent.isRunning ?? false;
  const canSend = connection === 'connected' && (text.trim().length > 0 || images.length > 0);

  const slash = slashState(text);
  const entries = useMemo(() => {
    if (!slash.active) return [];
    return filterCommands(
      [...builtinCommands(), ...skillCommands(snapshot?.skills ?? [])],
      slash.query,
    );
    // eslint 假设:skills 随快照变化;filter/slash 每键重算可接受(几十项)。
  }, [slash.active, slash.query, snapshot?.skills]);

  const menuVisible = slash.active && !suppressed && entries.length > 0;
  // 过滤后 cursor 可能越界;渲染前夹紧。
  const safeCursor = Math.min(cursor, Math.max(0, entries.length - 1));

  /** 命令分发(菜单选择与手打 `/xxx args` 提交共用)。 */
  const executeCommand = (entry: CommandEntry, argText: string) => {
    setText('');
    setSuppressed(false);
    if (entry.source === 'skill') {
      rpc({
        kind: 'runSkill',
        name: entry.name,
        args: argText,
        display: `/${entry.name}${argText ? ` ${argText}` : ''}`,
      });
      return;
    }
    switch (entry.name) {
      case 'models':
        requestModelsMenu();
        return;
      case 'new':
        rpc({ kind: 'newSession' });
        return;
      case 'compact':
        rpc({ kind: 'compact' });
        return;
      case 'review':
        rpc({ kind: 'startReview', scope: argText || 'uncommitted' });
        return;
      case 'simplify':
        rpc({ kind: 'startSimplify', target: argText });
        return;
    }
  };

  /** 手打提交:`/xxx args` 按命令执行,其余按普通消息发送。 */
  const submit = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    if (trimmed.startsWith('/') && !images.length) {
      const name = trimmed.slice(1).split(/\s+/)[0] ?? '';
      const argText = trimmed.slice(1 + name.length).trim();
      const matched = filterCommands(
        [...builtinCommands(), ...skillCommands(snapshot?.skills ?? [])],
        name,
      ).find((entry) => entry.name === name);
      if (matched) {
        executeCommand(matched, argText);
        return;
      }
      // 未知命令按普通消息发出(模型会回应;后续可加本地提示)。
    }
    const attachments = images;
    setText('');
    setImages([]);
    setSuppressed(false);
    void window.mojocode
      .rpc({
        kind: 'run',
        text: trimmed || '(image)',
        options: attachments.length ? { images: attachments } : undefined,
      })
      .catch((error: unknown) => console.error('run 失败', error));
  };

  /** 菜单选择:带 argumentHint 的技能无参时只补全,等用户补参。 */
  const pickFromMenu = (entry: CommandEntry) => {
    const rest = text.slice(1 + slash.query.length);
    const argText = rest.replace(/^\s+/, '').trim();
    if (entry.source === 'skill' && entry.argumentHint && !argText) {
      setText(`/${entry.name} `);
      setSuppressed(false);
      return;
    }
    executeCommand(entry, argText);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab:权限档循环(Codex 同款按键)。
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (snapshot) rpc(cyclePermissionsRpc(snapshot.config));
      return;
    }
    if (menuVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((safeCursor + 1) % entries.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((safeCursor - 1 + entries.length) % entries.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        pickFromMenu(entries[safeCursor]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuppressed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      {menuVisible ? (
        <SlashMenu entries={entries} cursor={safeCursor} onHover={setCursor} onPick={pickFromMenu} />
      ) : null}
      {images.length > 0 ? (
        <div className="composer-images">
          {images.map((image, index) => (
            <span key={index} className="composer-image-chip">
              🖼 {image.filename ?? image.mediaType}
              <button
                type="button"
                className="chip-remove"
                onClick={() => setImages(images.filter((_, i) => i !== index))}
              >
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
          // 新的过滤结果出来前重置光标与压制(Esc 只压一次输入态)。
          setCursor(0);
          if (slashState(e.target.value).query !== slash.query) setSuppressed(false);
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).filter((file) =>
            file.type.startsWith('image/'),
          );
          if (files.length === 0) return;
          e.preventDefault();
          void Promise.all(files.map((file, index) => toAttachment(file, index))).then(setImages);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="composer-actions">
        <span className="composer-hint">Shift+Tab · {t('composer.modeHint')}</span>
        <button
          type="button"
          className="btn-danger"
          disabled={!running || connection !== 'connected'}
          onClick={() => rpc({ kind: 'abort' })}
        >
          {t('composer.abort')}
        </button>
        <button type="button" className="btn-primary" disabled={!canSend} onClick={submit}>
          {t('composer.send')}
        </button>
      </div>
    </div>
  );
}
