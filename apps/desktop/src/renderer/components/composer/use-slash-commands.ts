/**
 * 斜杠命令(自 Composer.tsx 拆出):输入态派生(slashState + 过滤)、菜单
 * 光标/压制态、命令分发(菜单选择与手打提交共用),以及 tryExecuteSlash
 * ——收掉此前 submit 里重复的一遍命令匹配。
 */

import { useMemo, useState } from 'react';
import { useDesktopStore } from '../../state/desktopStore.js';
import { newTask } from '../../state/actions.js';
import { rpcFire } from '../../bridge/invoke.js';
import {
  builtinCommands,
  filterCommands,
  skillCommands,
  slashState,
  type CommandEntry,
} from '../../commands/index.js';

export function useSlashCommands({
  text,
  setText,
}: {
  text: string;
  setText: (text: string) => void;
}) {
  const snapshot = useDesktopStore((s) => s.snapshot);
  const requestModelsMenu = useDesktopStore((s) => s.requestModelsMenu);
  const [cursor, setCursor] = useState(0);
  const [suppressed, setSuppressed] = useState(false);

  const slash = slashState(text);
  const allCommands = () => [...builtinCommands(), ...skillCommands(snapshot?.skills ?? [])];
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
      rpcFire({
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
        rpcFire({ kind: 'compact' });
        return;
      case 'review':
        rpcFire({ kind: 'startReview', scope: argText || 'uncommitted' });
        return;
      case 'simplify':
        rpcFire({ kind: 'startSimplify', target: argText });
        return;
    }
  };

  /**
   * 手打提交路径:`/xxx args` 命中命令表则执行并返回 true;未知命令返回
   * false(调用方按普通消息发出,模型会回应)。
   */
  const tryExecuteSlash = (trimmed: string): boolean => {
    if (!trimmed.startsWith('/')) return false;
    const name = trimmed.slice(1).split(/\s+/)[0] ?? '';
    const argText = trimmed.slice(1 + name.length).trim();
    const matched = filterCommands(allCommands(), name).find((entry) => entry.name === name);
    if (!matched) return false;
    executeCommand(matched, argText);
    return true;
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

  /** 输入变化时的配套复位:光标归零;查询词变了解除 Esc 压制(只压一次输入态)。 */
  const onTextChange = (next: string) => {
    setCursor(0);
    if (slashState(next).query !== slash.query) setSuppressed(false);
  };

  return {
    entries,
    menuVisible,
    safeCursor,
    setCursor,
    suppress: () => setSuppressed(true),
    resetSuppressed: () => setSuppressed(false),
    pickFromMenu,
    tryExecuteSlash,
    onTextChange,
  };
}
