import { describe, expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { Box, ScrollArea, StreakScrollAccel, Text, useInput, useTerminalSize } from '../../src/ui/kit.js';
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

  it('ScrollArea 滚轮一格滚 3 行,且分帧缓动而不是一帧跳到位', async () => {
    const ui = await renderUi(
      () => (
        <Box flexDirection="column" width="100%" height="100%">
          <ScrollArea>
            {Array.from({ length: 60 }, (_, i) => (
              <Text>line-{String(i)}</Text>
            ))}
          </ScrollArea>
          <Box flexShrink={0}>
            <Text>BOTTOM-BAR</Text>
          </Box>
        </Box>
      ),
      { width: 30, height: 10 },
    );
    // 帧里第一个 line-N 就是可视区顶行。
    const topLine = (): number => Number(/line-(\d+)/.exec(ui.frame())?.[1]);
    /** 一直出帧到位置不再变(缓动落定)。 */
    const settle = async (): Promise<number> => {
      let last = topLine();
      for (let i = 0; i < 40; i += 1) {
        await ui.tick();
        const now = topLine();
        if (now === last) return now;
        last = now;
      }
      return last;
    };
    const before = topLine();
    await ui.scroll(2, 2, 'up');
    // 首帧只走了一部分——这就是「缓动」而非瞬时跳变的行为契约。
    expect(topLine()).toBeGreaterThan(before - 3);
    expect(topLine()).toBeLessThan(before);
    // 落定后正好是一格 3 行。
    expect(await settle()).toBe(before - 3);
    await ui.destroy();
  });

  it('滚轮缓动不破坏粘底:上滚后新内容不拉回底部,回到底部又重新跟随', async () => {
    const [count, setCount] = createSignal(40);
    const ui = await renderUi(
      () => (
        <Box flexDirection="column" width="100%" height="100%">
          <ScrollArea>
            {Array.from({ length: count() }, (_, i) => (
              <Text>line-{String(i)}</Text>
            ))}
          </ScrollArea>
          <Box flexShrink={0}>
            <Text>BOTTOM-BAR</Text>
          </Box>
        </Box>
      ),
      { width: 30, height: 10 },
    );
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 40; i += 1) await ui.tick();
    };
    // 粘底:尾行可见。
    expect(ui.frame()).toContain('line-39');
    // 上滚解粘,再追加内容,视图不应被拉回底部。
    for (let i = 0; i < 4; i += 1) await ui.scroll(2, 2, 'up');
    await settle();
    const topLine = (): number => Number(/line-(\d+)/.exec(ui.frame())?.[1]);
    const detachedTop = topLine();
    expect(ui.frame()).not.toContain('line-39');
    setCount(50);
    await settle();
    // 只比内容位置:滚动条滑块会随内容变长而变化,那不是回归。
    expect(topLine()).toBe(detachedTop);
    // 滚回底部后重新粘住,新内容继续跟随。
    for (let i = 0; i < 30; i += 1) await ui.scroll(2, 2, 'down');
    await settle();
    expect(ui.frame()).toContain('line-49');
    setCount(60);
    await settle();
    expect(ui.frame()).toContain('line-59');
    await ui.destroy();
  });

  it('StreakScrollAccel:连击提速并封顶,手势间隔超时后归零', () => {
    const accel = new StreakScrollAccel();
    // 首格永远是基础步长。
    expect(accel.tick(1000)).toBe(3);
    // 连击(间隔 ≤ 80ms)每格加一行。
    expect(accel.tick(1030)).toBe(4);
    expect(accel.tick(1060)).toBe(5);
    // 封顶 8,再快也不越过。
    for (let t = 1090; t <= 1500; t += 10) accel.tick(t);
    expect(accel.tick(1510)).toBe(8);
    // 停手后再滚,回到基础步长。
    expect(accel.tick(2000)).toBe(3);
    accel.tick(2030);
    accel.reset();
    expect(accel.tick(2060)).toBe(3);
  });
});
