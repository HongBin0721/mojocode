/**
 * 斜杠命令(自 Composer.tsx 拆出):输入态派生(slashState + 过滤)、菜单
 * 光标/压制态、命令分发(菜单选择与手打提交共用),以及 tryExecuteSlash
 * ——收掉此前 submit 里重复的一遍命令匹配。
 *
 * 扩展命令多一层:带 `hasOptions` 的命令在菜单上选中先开**选项层**
 * (`commandOptions` RPC 现取),选项可以再开一层(`expands`,如 /review 的
 * base → 分支列表)或预填输入框(`prefill`,如 /review custom)。层的状态与
 * 键盘处理都在这里,Composer 只按 `optionMenu` 是否存在分派按键。
 */

import { useMemo, useRef, useState } from 'react';
import type { ExtensionCommandInfo, ExtensionCommandOption } from '@core/protocol';
import { useDesktopStore } from '../../state/desktopStore.js';
import { newTask } from '../../state/actions.js';
import { rpcCall, rpcFire } from '../../bridge/invoke.js';
import {
  allCommands,
  filterCommands,
  slashState,
  type CommandEntry,
  type SkillInfo,
} from '../../commands/index.js';

/** 打开中的选项层:命令 + 已选过的层 + 本层取值。 */
export interface OptionMenuState {
  command: CommandEntry;
  /** 已经选过的层(本层的取值请求就是拿它当 path)。 */
  path: string[];
  options: ExtensionCommandOption[];
  loading: boolean;
}

/** 列表光标的钳位 + 环绕(命令菜单与选项层共用,两处手感必须一致)。 */
const wrapCursor = (cursor: number, total: number, step: -1 | 1): number =>
  (Math.min(cursor, total - 1) + total + step) % total;

/** 缺席字段的稳定空表(见下面 memo 依赖处的注释)。 */
const EMPTY_COMMANDS: ExtensionCommandInfo[] = [];
const EMPTY_SKILLS: SkillInfo[] = [];

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
  const [optionMenu, setOptionMenu] = useState<OptionMenuState | undefined>();
  const [optionCursor, setOptionCursor] = useState(0);

  const slash = slashState(text);
  // `?? EMPTY` 而不是 `?? []`:字面量每次渲染都是新数组,依赖数组就永远不
  // 相等,下面那个 memo 于是每敲一个键、每次无关重渲染都要重建整张命令表。
  // 字段缺席不是罕见分支——老 server 没有它们,首帧 state 到达之前也没有。
  const extensionInfos = snapshot?.extensions?.commands ?? EMPTY_COMMANDS;
  const skills = snapshot?.skills ?? EMPTY_SKILLS;
  /**
   * 整张命令表只随**快照**变(内置 + 扩展 + 技能的合表与排序),不随输入变。
   * 与下面的过滤分开两个 memo 是有理由的:合表要遍历三份来源、按优先级去重
   * 排序,而过滤是每敲一个键都跑的——搅在一个 memo 里等于把合表也变成了每
   * 键一次。它同时是 `tryExecuteSlash` 的查表来源,那里本来还各自现算一份。
   */
  const commands = useMemo(() => allCommands(extensionInfos, skills), [extensionInfos, skills]);
  const entries = useMemo(
    () => (slash.active ? filterCommands(commands, slash.query) : []),
    [slash.active, slash.query, commands],
  );

  const menuVisible = slash.active && !suppressed && entries.length > 0;
  // 过滤后 cursor 可能越界;渲染前夹紧。
  const safeCursor = Math.min(cursor, Math.max(0, entries.length - 1));

  /**
   * 在途 `commandOptions` 的代次。取值 RPC 可能跑好几秒(`/review` 要列分支),
   * 期间用户按 esc 关掉选项层、接着打字是常事——迟到的响应不作废的话会把
   * 浮层重新弹回来盖住输入框,空表那一支甚至会**执行**用户刚取消的命令。
   * TUI 侧的 `selectorGen` 是同一道闸,GUI 移植时漏了。ref 而不是 state:
   * 它只用来比对,不该触发重渲染。
   */
  const optionGen = useRef(0);

  const closeOptions = () => {
    optionGen.current += 1;
    setOptionMenu(undefined);
    setOptionCursor(0);
  };

  const fireCommand = (entry: CommandEntry, argText: string) =>
    rpcFire({ kind: 'runCommand', name: entry.name, args: argText });

  /**
   * 打开(或深入一层)选项层。取值为空 = 这一层没有可选项:提交已选的层,
   * 由命令自己解释为什么空(是没有分支,还是根本不是 git 仓库)——与 TUI
   * 的回退规则一致,判断留在一处。
   */
  const openOptions = (entry: CommandEntry, path: string[]) => {
    const gen = ++optionGen.current;
    setText('');
    setSuppressed(false);
    setOptionMenu({ command: entry, path, options: [], loading: true });
    setOptionCursor(0);
    void rpcCall({ kind: 'commandOptions', name: entry.name, path })
      .then((options) => {
        if (optionGen.current !== gen) return; // 已被关掉或又开了别的:结果作废
        if (options.length === 0) {
          closeOptions();
          fireCommand(entry, path.join(' '));
          return;
        }
        const current = options.findIndex((option) => option.current);
        setOptionMenu({ command: entry, path, options, loading: false });
        setOptionCursor(Math.max(0, current));
      })
      .catch(() => {
        if (optionGen.current !== gen) return;
        // 取值 RPC 失败:退回成提交命令,由命令把错误报到时间线上。
        closeOptions();
        fireCommand(entry, path.join(' '));
      });
  };

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
    if (entry.source === 'extension') {
      // 没带参数且有取值:先让用户选。带了参数说明用户自己打全了,直接执行。
      if (entry.hasOptions && !argText) {
        openOptions(entry, []);
        return;
      }
      fireCommand(entry, argText);
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
    const matched = commands.find((entry) => entry.name === name);
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

  const safeOptionCursor = optionMenu
    ? Math.min(optionCursor, Math.max(0, optionMenu.options.length - 1))
    : 0;

  const moveOption = (step: -1 | 1) => {
    const total = optionMenu?.options.length ?? 0;
    if (total === 0) return;
    setOptionCursor((c) => wrapCursor(c, total, step));
  };

  /**
   * 命令菜单的光标移动。与 moveOption 走**同一个** wrapCursor:两处曾各写
   * 一份钳位与环绕算式(一处 `Math.min` 先钳、一处内联取模),改一处另一处
   * 默默不同步——TUI 侧为同样的理由要求 wheel 与 ↑/↓ 共用一个 mover。
   */
  const moveCommand = (step: -1 | 1) => {
    if (entries.length === 0) return;
    setCursor((c) => wrapCursor(c, entries.length, step));
  };

  /** 选中一项:再开一层 / 预填输入框 / 提交。 */
  const pickOption = (option: ExtensionCommandOption) => {
    if (!optionMenu) return;
    const { command, path } = optionMenu;
    if (option.expands) {
      openOptions(command, [...path, option.value]);
      return;
    }
    const full = [...path, option.value];
    closeOptions();
    // 预填留尾随空格,菜单保持关闭(slashState 遇空格即收起),用户接着补
    // 自由文本再自己回车。
    if (option.prefill) {
      setText(`/${command.name} ${full.join(' ')} `);
      return;
    }
    fireCommand(command, full.join(' '));
  };

  /** esc:深层退回上一层,第一层关掉整个选项菜单。 */
  const backOption = () => {
    if (!optionMenu) return;
    if (optionMenu.path.length === 0) {
      closeOptions();
      return;
    }
    openOptions(optionMenu.command, optionMenu.path.slice(0, -1));
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
    optionMenu,
    optionCursor: safeOptionCursor,
    setOptionCursor,
    moveOption,
    moveCommand,
    pickOption,
    backOption,
  };
}
