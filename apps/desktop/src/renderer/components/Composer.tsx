/**
 * 输入区(设计稿胶囊工具条):rounded-2xl 扁平外框(textarea 透明内嵌);
 * 底部工具栏两组——左:附加文件(paperclip)、权限档 chip(shield-check,
 * 完全访问染警示色);右:上下文环、模型(cpu)、思考强度(brain)、发送钮
 * (arrow-up/停止 ■)。选择器 chips 右侧一律 caret-up-down(设计稿图标系)。
 *
 * 键盘:Enter 提交 / Shift+Enter 换行;`Shift+Tab` 循环权限档;`/` 开头弹
 * 命令菜单;粘贴与拖入图片 → 缩略图附件 chips(拖入非图片忽略)。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageAttachment } from '@core/attachments';
import { presetById } from '@core/schema';
import { useModelCapabilities } from '../utils/use-model-capabilities.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { newTask } from '../state/actions.js';
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
import {
  ArrowUpIcon,
  BrainIcon,
  CaretUpDownIcon,
  CpuIcon,
  PaperclipIcon,
  ShieldCheckIcon,
} from './icons.js';
import { localizeEffort, localizeMode } from '../utils/mode-label.js';
import { formatContextWindow, formatTokens, percent } from '../utils/format.js';

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

/**
 * 上下文环(设计稿):28px 悬停区里一个 15px conic-gradient 圆环(已用扇区
 * 亮色 #cfd3e5、剩余 #3f424d,9px 内孔挖回输入框底色),悬停出三行 tooltip。
 * 数据:快照的权威 contextUsage(provider 上报/换史后估算);首轮之前回退
 * 当前模型的窗口标称值(0 已用)。
 */
function ContextRing() {
  useLocale();
  const reportedUsage = useDesktopStore((s) => s.snapshot?.agent.contextUsage);
  const providerWindow = useDesktopStore((s) => s.snapshot?.provider.contextWindow);
  const [tipOpen, setTipOpen] = useState(false);
  const usage = reportedUsage ?? (providerWindow ? { used: 0, window: providerWindow } : undefined);
  if (!usage || usage.window <= 0) return null;

  const pct = percent(usage.used, usage.window);
  return (
    <div
      className="ctx-ring-wrap"
      onMouseEnter={() => setTipOpen(true)}
      onMouseLeave={() => setTipOpen(false)}
    >
      <div
        className="ctx-ring"
        style={{ background: `conic-gradient(#cfd3e5 0 ${pct}%, #3f424d ${pct}% 100%)` }}
      >
        <div className="ctx-ring-hole" />
      </div>
      {tipOpen ? (
        <div className="ctx-tip">
          <div className="ctx-tip-title">{t('composer.ctxTitle')}</div>
          <div className="ctx-tip-line">
            {t('composer.ctxUsedPct', { pct: String(pct), left: String(100 - pct) })}
          </div>
          <div className="ctx-tip-sub">
            {t('composer.ctxTokens', {
              used: formatTokens(usage.used),
              total: formatContextWindow(usage.window),
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
  const composerPrefill = useDesktopStore((s) => s.composerPrefill);
  const [text, setText] = useState('');

  // 外部预填(评审面板「请求修改」等):nonce 变化即取 text 填入并聚焦。
  useEffect(() => {
    if (!composerPrefill) return;
    setText(composerPrefill.text);
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nonce 即意图。
  }, [composerPrefill?.nonce]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [cursor, setCursor] = useState(0);
  const [suppressed, setSuppressed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const running = snapshot?.agent.isRunning ?? false;
  const canSend = connection === 'connected' && (text.trim().length > 0 || images.length > 0);

  const mode = snapshot?.config;
  const badge = mode ? permissionBadgeLabel(mode) : undefined;
  const flash = useFlash(badge);
  const dangerous = mode ? isDangerousMode(mode) : false;
  const permissionEntries = mode ? permissionMenuEntries(mode) : [];
  const effort = snapshot?.provider.reasoningEffort;
  // 模型条目配了自定义思考参数时档位映射(含 /think)不再生效——chip 显示
  // 「自定义」且不再展开档位菜单,避免选了也没用的假交互。
  const customReasoning = snapshot?.provider.reasoningParams !== undefined;
  // 思考菜单的可选档位:models.dev 逐模型能力(server 侧缓存),查不到 =
  // undefined = 菜单显示全量档位(与之前行为一致)。
  const effortLevels = useModelCapabilities(snapshot?.provider.id, snapshot?.provider.model)
    ?.efforts;

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
        newTask();
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

  /** 追加图片附件(拖入/粘贴/+ 按钮共用);非图片静默忽略。 */
  const addFiles = (list: Iterable<File>) => {
    const files = Array.from(list).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    void Promise.all(files.map((file, index) => toAttachment(file, index))).then((added) =>
      setImages((prev) => [...prev, ...added]),
    );
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
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
            if (e.clipboardData.files.length === 0) return;
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-toolbar">
          {/* 左组:+ 附件、盾牌权限档(ZCode 左下角布局) */}
          <div className="composer-tools">
            <button
              type="button"
              className="composer-tool"
              title={t('composer.attach')}
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipIcon size={13} />
              {t('composer.attach')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {mode ? (
              <MenuPopover
                label={
                  <span
                    className={`composer-tool composer-mode ${dangerous ? 'composer-tool-danger' : ''} ${
                      flash ? 'composer-tool-flash' : ''
                    }`}
                  >
                    <ShieldCheckIcon size={13} />
                    {badge && localizeMode(badge)}
                    <span className="composer-caret">
                      <CaretUpDownIcon size={11} />
                    </span>
                  </span>
                }
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
          </div>
          {/* 右组:上下文环 → 模型 → 思考强度 → 发送(设计稿构成) */}
          <ContextRing />
          {snapshot ? (
            <MenuPopover
              label={
                <span className="composer-tool composer-tool-model">
                  <CpuIcon size={13} />
                  {snapshot.provider.model}
                  <span className="composer-caret">
                      <CaretUpDownIcon size={11} />
                    </span>
                </span>
              }
              width={360}
              requestOpen={modelMenuRequest}
              placement="top"
              align="end"
            >
              <ModelMenuList />
            </MenuPopover>
          ) : null}
          {customReasoning ? (
            <span className="composer-tool composer-effort" title={t('reasoningMenu.customTitle')}>
              <BrainIcon size={13} />
              {t('effort.custom')}
            </span>
          ) : effortLevels?.length === 0 ? null : effort ? ( // 目录说该模型无思考能力:chip 整个不渲染
            <MenuPopover
              label={
                <span className="composer-tool composer-effort" title={t('reasoningMenu.title')}>
                  <BrainIcon size={13} />
                  {localizeEffort(effort)}
                  <span className="composer-caret">
                      <CaretUpDownIcon size={11} />
                    </span>
                </span>
              }
              title={t('reasoningMenu.title')}
              width={280}
              placement="top"
              align="end"
            >
              <ReasoningMenuList
                entries={reasoningMenuEntries(effort, effortLevels)}
                onPick={(level) => rpc(setReasoningRpc(level))}
              />
            </MenuPopover>
          ) : null}
          <button
            type="button"
            className="composer-send"
            disabled={running ? connection !== 'connected' : !canSend}
            title={running ? t('composer.abort') : t('composer.send')}
            onClick={primaryAction}
          >
            {running ? '■' : <ArrowUpIcon size={15} />}
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
