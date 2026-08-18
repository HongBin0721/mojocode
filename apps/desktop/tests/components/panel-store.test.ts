/**
 * panelStore(终端 ring buffer):按行切分、残段拼接、ANSI 剥离、行数封顶。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { usePanelStore } from '../../src/renderer/state/panelStore.js';

beforeEach(() => usePanelStore.setState({ terminals: {} }));

describe('panelStore', () => {
  it('chunk 跨行拼接:残段等到下一个 chunk 才成行', () => {
    const store = usePanelStore.getState();
    store.appendChunk('t1', 'hel');
    store.appendChunk('t1', 'lo\nworld\npar');
    const terminal = usePanelStore.getState().terminals['t1']!;
    expect(terminal.lines.map((line) => line.text)).toEqual(['hello', 'world']);
    expect(terminal.partial).toBe('par');
  });

  it('ANSI 转义被剥离;命令行注入前先落残段', () => {
    const store = usePanelStore.getState();
    store.appendChunk('t1', '[32mgreen[0m\nrest');
    store.appendCommand('t1', 'npm test');
    const terminal = usePanelStore.getState().terminals['t1']!;
    expect(terminal.lines.map((line) => [line.text, line.kind])).toEqual([
      ['green', 'out'],
      ['rest', 'out'],
      ['$ npm test', 'cmd'],
    ]);
    expect(terminal.partial).toBe('');
  });

  it('行数封顶:超出丢最旧', () => {
    const store = usePanelStore.getState();
    store.appendChunk('t1', Array.from({ length: 5100 }, (_, i) => `line-${i}`).join('\n') + '\n');
    const terminal = usePanelStore.getState().terminals['t1']!;
    expect(terminal.lines).toHaveLength(5000);
    expect(terminal.lines[0]!.text).toBe('line-100');
  });
});
