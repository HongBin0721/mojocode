/**
 * 输入区(ZCode 式输入块):rounded-2xl 外框(focus-within 抬边框/换底色)
 * 内嵌 rounded-xl textarea 卡;底部工具栏左侧是模式切换(权限档菜单)与
 * 模型选择器(原顶栏的两个入口迁到这里),右侧品牌色发送/停止钮。
 *
 * 键盘:Enter 提交 / Shift+Enter 换行;`Shift+Tab` 循环权限档;`/` 开头弹
 * 命令菜单;粘贴与拖入图片 → 缩略图附件 chips(拖入非图片忽略)。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageAttachment } from '@core/attachments';
import { presetById } from '@core/schema';
import { useDesktopStore } from '../state/desktopStore.js';
import { t, useLocale } from '../i18n/index.js';
import {
  builtinCommands,
  filterCommands,
  skillCommands,
  slashState,
  type CommandEntry,
} from '../commands/index.js';
import { cyclePermissionsRpc, isDangerousMode, permissionBadgeLabel, permissionMenuEntries } from '../commands/permissions.js';
import { reasoningMenuEntries, setReasoningRpc } from '../commands/reasoning.js';
import { SlashMenu } from './SlashMenu.js';
import { MenuPopover } from './Menu.js';
import { ModelMenuList } from './ModelMenu.js';
import { PermissionMenuList } from './PermissionMenu.js';
import { ReasoningMenuList } from './ReasoningMenu.js';

/** 剪贴板/拖入的图片文件 → ImageAttachment(base64)。 */
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

/** 模式值变化时品牌色环闪 2s(原顶栏徽章闪动的迁入)。 */
function useFlash(value: string | undefined): boolean {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== undefined && prev.current !== value) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 2000);
      prev.current = value;
      return () => clearTimeout(timer);
    }
    prev.current = value;
    return;
  }, [value]);
  return flash;
}

export function Composer() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  const snapshot = useDesktopStore((s) => s.snapshot);
  const requestModelsMenu = useDesktopStore((s) => s.requestModelsMenu);
  const modelMenuRequest = useDesktopStore((s) => s.modelMenuRequest);
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [cursor, setCursor] = useState(0);
  const [suppressed, setSuppressed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const running = snapshot?.agent.isRunning ?? false;
  const canSend = connection === 'connected' && (text.trim().length > 0 || images.length > 0);

  const mode = snapshot?.config;
  const badge = mode ? permissionBadgeLabel(mode) : undefined;
  const flash = useFlash(badge);
  const dangerous = mode ? isDangerousMode(mode) : false;
  const permissionEntries = mode ? permissionMenuEntries(mode) : [];
  const effort = snapshot?.provider.reasoningEffort;

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
    // Shift+Tab:权限档循环(Codex/ZCode 同款按键)。
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

  // 高度自适应:按内容收缩/增长,封顶 156px(超出内部滚动)。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 156)}px`;
  }, [text]);

  const primaryAction = () => {
    if (running) rpc({ kind: 'abort' });
    else submit();
  };

  /** 拖入:仅接受图片(与粘贴同路径);非图片静默忽略。 */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    void Promise.all(files.map((file, index) => toAttachment(file, index))).then(setImages);
  };

  return (
    <div className="composer conv-col">
      {menuVisible ? (
        <SlashMenu entries={entries} cursor={safeCursor} onHover={setCursor} onPick={pickFromMenu} />
      ) : null}
      <div
        className={`composer-box${dragging ? ' composer-box-dragging' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        {images.length > 0 ? (
          <div className="composer-attachments">
            {images.map((image, index) => (
              <span key={index} className="attachment-chip">
                <img className="attachment-thumb" src={`data:${image.mediaType};base64,${image.data}`} alt="" />
                <span className="attachment-name">{image.filename ?? image.mediaType}</span>
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
        <div className="composer-toolbar">
          <div className="composer-tools">
            {mode ? (
              <MenuPopover
                label={
                  <span
                    className={`composer-tool ${dangerous ? 'composer-tool-danger' : ''} ${
                      flash ? 'composer-tool-flash' : ''
                    }`}
                  >
                    {badge}
                  </span>
                }
                title={t('permissionMenu.title')}
                width={320}
                placement="top"
              >
                <PermissionMenuList
                  entries={permissionEntries}
                  onPick={(id) => {
                    if (id === 'plan') rpc({ kind: 'setPlan', active: true });
                    else rpc({ kind: 'setPermissions', permissions: presetById(id) });
                  }}
                />
              </MenuPopover>
            ) : null}
            {/* 思考强度:左组第二位(ZCode 的 Reasoning effort 位) */}
            {effort ? (
              <MenuPopover
                label={
                  <span className="composer-tool" title={t('reasoningMenu.title')}>
                    <span aria-hidden>✦</span>
                    {effort}
                  </span>
                }
                title={t('reasoningMenu.title')}
                width={280}
                placement="top"
              >
                <ReasoningMenuList
                  entries={reasoningMenuEntries(effort)}
                  onPick={(level) => rpc(setReasoningRpc(level))}
                />
              </MenuPopover>
            ) : null}
          </div>
          <span className="composer-hint">Shift+Tab · {t('composer.modeHint')}</span>
          {/* 模型选择器:发送键左侧(ZCode 的 betweenCancelAndSubmitAction 位) */}
          {snapshot ? (
            <MenuPopover
              label={
                <span className="composer-tool">
                  {snapshot.provider.model}
                  <span className="composer-caret">⌄</span>
                </span>
              }
              title={t('modelMenu.title')}
              width={360}
              requestOpen={modelMenuRequest}
              placement="top"
            >
              <ModelMenuList />
            </MenuPopover>
          ) : null}
          <button
            type="button"
            className="composer-send"
            disabled={running ? connection !== 'connected' : !canSend}
            title={running ? t('composer.abort') : t('composer.send')}
            onClick={primaryAction}
          >
            {running ? '■' : '↑'}
          </button>
        </div>
        {dragging ? (
          <div className="composer-drag-overlay">
            <span className="composer-drag-pill">{t('composer.dropHint')}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
