import { describe, expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { Box, ScrollArea, Text, useInput, useTerminalSize } from '../../src/ui/kit.js';
import { renderUi } from '../support/otui.js';

/**
 * kit 适配层(Solid 版)的行为冒烟:ANSI → span、嵌套 Text → span、
 * useInput 字符合并、终端尺寸 getter 的响应式。更细的行为由各组件测试
 * (ansi-spans / input / highlight 等)覆盖。
 */
describe('kit(Solid)', () => {
  it('Text 渲染 ANSI 字符串为着色 span,嵌套 Text 自动降为 span', async () => {
    const ui = await renderUi(
      () => (
        <Box flexDirection="column">
          <Text color="#00ffff">
            plain <Text bold>nested</Text> tail
          </Text>
          <Text>{'\x1b[31mred\x1b[39m normal'}</Text>
        </Box>
      ),
      { width: 40, height: 6 },
    );
    const frame = ui.frame();
    expect(frame).toContain('plain nested tail');
    expect(frame).toContain('red normal');
    // 样式断言:红色 span 真的以前景色落到帧上(fg.buffer = [r,g,b,a] 0-255)。
    const captured = ui.spans() as {
      lines: { spans: { text: string; fg: { buffer: Record<number, number> } }[] }[];
    };
    const red = captured.lines.flatMap((l) => l.spans).find((s) => s.text.includes('red'));
    expect(red).toBeDefined();
    // 真正的红:r 高且 g 低。只断言 r 会被默认白(255,255,255)假阳性糊弄
    // ——上游 span 只认 style prop,直传 fg 静默丢失的回归正是这样漏过的。
    expect(red!.fg.buffer[0]).toBeGreaterThan(120);
    expect(red!.fg.buffer[1] ?? 0).toBeLessThan(100);
    await ui.destroy();
  });

  it('useInput 把同批可打印字符合并为一次派发,信号同步可见', async () => {
    const calls: string[] = [];
    function Probe() {
      const [value, setValue] = createSignal('');
      useInput((input, key) => {
        calls.push(key.return ? '<ret>' : input);
        if (!key.return) setValue((v) => v + input);
      });
      return <Text>v={value()}</Text>;
    }
    const ui = await renderUi(() => <Probe />, { width: 40, height: 4 });
    await ui.type('abc');
    expect(ui.frame()).toContain('v=abc');
    // 同一个批次的三个字符必须合并成一次调用(丢字防护的行为契约)。
    expect(calls).toEqual(['abc']);
    await ui.press('return');
    expect(calls).toEqual(['abc', '<ret>']);
    await ui.destroy();
  });

  it('useTerminalSize 返回响应式 getter,resize 后布局跟随', async () => {
    function Probe() {
      const size = useTerminalSize();
      return <Text>{`w=${size.columns}`}</Text>;
    }
    const ui = await renderUi(() => <Probe />, { width: 40, height: 4 });
    expect(ui.frame()).toContain('w=40');
    ui.resize(60, 4);
    await ui.tick();
    expect(ui.frame()).toContain('w=60');
    await ui.destroy();
  });

  it('ScrollArea + 底部固定区:内容超高时输入区不被顶出屏幕', async () => {
    const ui = await renderUi(
      () => (
        <Box flexDirection="column" width="100%" height="100%">
          <ScrollArea>
            {Array.from({ length: 30 }, (_, i) => (
              <Text>line-{String(i)}</Text>
            ))}
          </ScrollArea>
          <Box flexShrink={0}>
            <Text>BOTTOM-BAR</Text>
          </Box>
        </Box>
      ),
      { width: 30, height: 8 },
    );
    const frame = ui.frame();
    expect(frame).toContain('BOTTOM-BAR');
    // 粘底:可视区应包含尾部行而不是头部行。
    expect(frame).toContain('line-29');
    expect(frame).not.toContain('line-0');
    await ui.destroy();
  });

  it('ScrollArea 拿到焦点后:↑/↓ 不滚动内容,PageUp/PageDown 仍然可以', async () => {
    const ui = await renderUi(
      () => (
        <Box flexDirection="column" width="100%" height="100%">
          <ScrollArea>
            {Array.from({ length: 40 }, (_, i) => (
              <Text>line-{String(i)}</Text>
            ))}
          </ScrollArea>
          <Box flexShrink={0}>
            <Text>BOTTOM-BAR</Text>
          </Box>
        </Box>
      ),
      { width: 30, height: 8 },
    );
    // 时间线上的一次点击就会让 scrollbox 拿到键盘焦点(renderer.autoFocus)。
    await ui.click(2, 2);
    const stuckToBottom = ui.frame();
    // ↑/↓ 属输入框(翻历史/移光标),不得穿透成滚动。
    await ui.press('up');
    expect(ui.frame()).toBe(stuckToBottom);
    await ui.press('down');
    expect(ui.frame()).toBe(stuckToBottom);
    // Page 键到不了输入框,仍归 scrollbox。
    await ui.press('pageup');
    expect(ui.frame()).not.toBe(stuckToBottom);
    await ui.press('pagedown');
    expect(ui.frame()).toBe(stuckToBottom);
    await ui.destroy();
  });
});
