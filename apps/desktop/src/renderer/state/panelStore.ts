/**
 * 右侧面板的本地状态:终端行缓冲(per-task ring buffer)。
 * 数据源是 client.ts 转发的 tool-output-delta(核心侧已按 ≥100ms/2KB 节流、
 * 单次调用封顶 64KB),这里只做:按行切分、ANSI 剥离、行数封顶。
 */

import { create } from 'zustand';

/** 每任务最多保留的终端行数(超出丢最旧)。 */
const MAX_LINES = 5000;

const ANSI_RE = new RegExp(String.raw`\x1b\[[0-9;]*[A-Za-z]`, 'g');

export interface TerminalLine {
  text: string;
  /** 命令行($ 开头,tool-start 注入)以亮色渲染。 */
  kind: 'cmd' | 'out';
}

interface TaskTerminal {
  lines: TerminalLine[];
  /** 尾部未换行的残段(下一个 chunk 接上)。 */
  partial: string;
}

export interface PanelStore {
  terminals: Record<string, TaskTerminal>;
  appendCommand(taskId: string, command: string): void;
  appendChunk(taskId: string, chunk: string): void;
  clear(taskId: string): void;
}

function pushLines(terminal: TaskTerminal, lines: TerminalLine[]): TaskTerminal {
  const merged = [...terminal.lines, ...lines];
  return {
    ...terminal,
    lines: merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged,
  };
}

const empty = (): TaskTerminal => ({ lines: [], partial: '' });

export const usePanelStore = create<PanelStore>((set) => ({
  terminals: {},

  appendCommand: (taskId, command) =>
    set((state) => {
      const terminal = state.terminals[taskId] ?? empty();
      // 残段先落行(上一条命令的尾巴不该拼进下一条)。
      const flushed = terminal.partial
        ? pushLines(terminal, [{ text: terminal.partial, kind: 'out' }])
        : terminal;
      const next = pushLines({ ...flushed, partial: '' }, [{ text: `$ ${command}`, kind: 'cmd' }]);
      return { terminals: { ...state.terminals, [taskId]: next } };
    }),

  appendChunk: (taskId, chunk) =>
    set((state) => {
      const terminal = state.terminals[taskId] ?? empty();
      const text = (terminal.partial + chunk).replace(ANSI_RE, '');
      const parts = text.split('\n');
      const partial = parts.pop() ?? '';
      const next = {
        ...pushLines(terminal, parts.map((line) => ({ text: line, kind: 'out' as const }))),
        partial,
      };
      return { terminals: { ...state.terminals, [taskId]: next } };
    }),

  clear: (taskId) =>
    set((state) => {
      const terminals = { ...state.terminals };
      delete terminals[taskId];
      return { terminals };
    }),
}));
