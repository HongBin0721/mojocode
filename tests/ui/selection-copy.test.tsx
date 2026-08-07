import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { Box, Text, useSelectionCopy } from '../../src/ui/kit.js';
import { renderUi } from '../support/otui.js';

function Probe({ copied, written }: { copied: number[]; written: string[] }) {
  useSelectionCopy(
    (chars) => copied.push(chars),
    async (text) => {
      written.push(text);
      return true;
    },
  );
  return (
    <Box flexDirection="column">
      <Text>hello world</Text>
      <Text>第二行内容</Text>
    </Box>
  );
}

describe('拖选自动复制(useSelectionCopy)', () => {
  it('鼠标拖选后经 300ms 静默期写入剪贴板并回调字符数', async () => {
    const copied: number[] = [];
    const written: string[] = [];
    const ui = await renderUi(() => <Probe copied={copied} written={written} />, {
      width: 30,
      height: 5,
    });

    await ui.mockMouse.drag(0, 0, 10, 0); // 划过第一行 "hello world"
    await sleep(400); // 越过 300ms 复制静默期
    await ui.tick();

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('hello');
    expect(copied).toEqual([written[0]!.length]);
    await ui.destroy();
  });

  it('同一段选区不重复复制;新选区再次复制', async () => {
    const copied: number[] = [];
    const written: string[] = [];
    const ui = await renderUi(() => <Probe copied={copied} written={written} />, {
      width: 30,
      height: 5,
    });

    await ui.mockMouse.drag(0, 0, 10, 0);
    await sleep(400);
    await ui.mockMouse.drag(0, 1, 9, 1); // 第二行 CJK
    await sleep(400);
    await ui.tick();

    expect(written).toHaveLength(2);
    expect(written[1]).toContain('第二行');
    await ui.destroy();
  });
});
