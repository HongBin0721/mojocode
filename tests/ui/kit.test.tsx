import { describe, expect, it } from 'vitest';
import { Box, Text, mapKeyEvent, useInput, type Key } from '../../src/ui/kit.js';
import { renderUi } from '../support/otui.js';

describe('kit.Text', () => {
  it('渲染普通文本与颜色', async () => {
    const ui = await renderUi(
      () => <Box flexDirection="column">
        <Text color="cyan">你好 world</Text>
        <Text bold>加粗</Text>
      </Box>,
      { width: 30, height: 5 },
    );
    expect(ui.frame()).toContain('你好 world');
    expect(ui.frame()).toContain('加粗');
    await ui.destroy();
  });

  it('含 ANSI 的子串被转成 span(不出现字面转义)', async () => {
    const ui = await renderUi(
      () => <Text>{'\x1b[31m红\x1b[39m 与 \x1b[1m粗\x1b[22m'}</Text>,
      { width: 30, height: 4 },
    );
    const frame = ui.frame();
    expect(frame).toContain('红 与 粗');
    expect(frame).not.toContain('[31m');
    expect(frame).not.toContain('\x1b');
    await ui.destroy();
  });

  it('嵌套 Text 渲染为 span(同一行内联)', async () => {
    const ui = await renderUi(
      () => <Text>
        前<Text color="red">中</Text>后
      </Text>,
      { width: 20, height: 3 },
    );
    expect(ui.frame().split('\n')[0]).toContain('前中后');
    await ui.destroy();
  });

  it('wrap="truncate-end" 单行截断', async () => {
    const ui = await renderUi(
      () => <Text wrap="truncate-end">{'一二三四五六七八九十'.repeat(4)}</Text>,
      { width: 12, height: 4 },
    );
    const lines = ui.frame().split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    await ui.destroy();
  });
});

describe('kit.Box', () => {
  it('默认 flexDirection=row(两个 Text 同行)', async () => {
    const ui = await renderUi(
      () => <Box>
        <Text>AA</Text>
        <Text>BB</Text>
      </Box>,
      { width: 20, height: 3 },
    );
    expect(ui.frame().split('\n')[0]).toContain('AABB');
    await ui.destroy();
  });

  it('column 布局纵向排列且 border 生效', async () => {
    const ui = await renderUi(
      () => <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text>第一行</Text>
        <Text>第二行</Text>
      </Box>,
      { width: 20, height: 6 },
    );
    const frame = ui.frame();
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
    expect(frame.indexOf('第一行')).toBeLessThan(frame.indexOf('第二行'));
    await ui.destroy();
  });
});

describe('kit.useInput', () => {
  function Probe({ onKey }: { onKey: (input: string, key: Key) => void }) {
    useInput(onKey);
    return <Text>probe</Text>;
  }

  it('方向键/回车/ESC/tab/退格映射为 Ink 形状', async () => {
    const seen: { input: string; key: Key }[] = [];
    const ui = await renderUi(() => <Probe onKey={(input, key) => seen.push({ input, key })} />, {
      width: 20,
      height: 3,
    });
    await ui.press('up');
    await ui.press('return');
    await ui.press('escape');
    await ui.press('tab', { shift: true });
    await ui.press('backspace');
    expect(seen[0]?.key.upArrow).toBe(true);
    expect(seen[1]?.key.return).toBe(true);
    expect(seen[2]?.key.escape).toBe(true);
    expect(seen[3]?.key.tab).toBe(true);
    expect(seen[3]?.key.shift).toBe(true);
    expect(seen[4]?.key.backspace ?? seen[4]?.key.delete).toBe(true);
    await ui.destroy();
  });

  it('可打印字符(含 CJK)同批合并派发,ctrl 组合单独派发', async () => {
    const seen: { input: string; key: Key }[] = [];
    const ui = await renderUi(() => <Probe onKey={(input, key) => seen.push({ input, key })} />, {
      width: 20,
      height: 3,
    });
    // Ink 语义:同一个 stdin chunk 里的普通字符合并成一个 input 字符串
    await ui.type('a中');
    await ui.press('t', { ctrl: true });
    expect(seen[0]?.input).toBe('a中');
    expect(seen[1]).toMatchObject({ input: 't', key: expect.objectContaining({ ctrl: true }) });
    await ui.destroy();
  });

  it('bracketed paste 合并为一次大 input(Ink 语义)', async () => {
    const seen: string[] = [];
    const ui = await renderUi(() => <Probe onKey={(input) => seen.push(input)} />, {
      width: 20,
      height: 3,
    });
    await ui.paste('3 files changed, 12 insertions(+)');
    expect(seen).toContain('3 files changed, 12 insertions(+)');
    await ui.destroy();
  });

  it('isActive=false 时不接收按键', async () => {
    const seen: string[] = [];
    function Gated() {
      useInput((input) => seen.push(input), { isActive: false });
      return <Text>gated</Text>;
    }
    const ui = await renderUi(() => <Gated />, { width: 20, height: 3 });
    await ui.type('x');
    expect(seen).toHaveLength(0);
    await ui.destroy();
  });
});

describe('kit.mapKeyEvent(纯映射)', () => {
  const ev = (partial: Record<string, unknown>) =>
    ({
      name: '',
      sequence: '',
      raw: '',
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      eventType: 'press',
      ...partial,
    }) as never;

  it('linefeed → ctrl+j(Input 换行 fallback 依赖)', () => {
    const r = mapKeyEvent(ev({ name: 'linefeed', sequence: '\n' }));
    expect(r).toMatchObject({ input: 'j', key: expect.objectContaining({ ctrl: true }) });
  });

  it('release 事件被丢弃', () => {
    expect(mapKeyEvent(ev({ name: 'a', sequence: 'a', eventType: 'release' }))).toBeUndefined();
  });

  it('纯修饰键被丢弃', () => {
    expect(mapKeyEvent(ev({ name: 'shift' }))).toBeUndefined();
  });
});
