import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { PermissionPrompt } from '../src/ui/PermissionPrompt.js';
import type { PermissionDecision, PermissionRequest } from '../src/core/events.js';

// Ink 会把单独的 ESC 缓冲 20ms 再分发,等待时间必须盖过它。
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

const ENTER = '\r';
const DOWN = '[B';
const ESC = '';

const request: PermissionRequest = {
  id: 'req-1',
  toolName: 'write',
  title: 'write: index.js',
  suggestedRule: 'index.js',
  risk: 'write',
};

function setup(req: PermissionRequest = request) {
  const decisions: PermissionDecision[] = [];
  const view = render(
    <PermissionPrompt request={req} onDecide={(decision) => decisions.push(decision)} />,
  );
  return { decisions, ...view };
}

describe('PermissionPrompt 选项列表', () => {
  it('默认选中"允许一次",回车确认', async () => {
    const { decisions, stdin, unmount } = setup();
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(decisions).toEqual([{ type: 'allow' }]);
    unmount();
  });

  it('上下键移动到"拒绝"后回车', async () => {
    const { decisions, stdin, unmount } = setup();
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // 1→2→3→4(拒绝)
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(decisions).toEqual([{ type: 'deny' }]);
    unmount();
  });

  it('数字键直达对应选项', async () => {
    const { decisions, stdin, unmount } = setup();
    await tick();
    stdin.write('2');
    await tick();
    expect(decisions).toEqual([{ type: 'allow-always', rule: 'index.js' }]);
    unmount();
  });

  it('esc 直接拒绝', async () => {
    const { decisions, stdin, unmount } = setup();
    await tick();
    stdin.write(ESC);
    await tick();
    expect(decisions).toEqual([{ type: 'deny' }]);
    unmount();
  });

  it('没有建议规则时数字 2 对应"拒绝"', async () => {
    const { decisions, stdin, unmount } = setup({ ...request, suggestedRule: undefined });
    await tick();
    stdin.write('2');
    await tick();
    expect(decisions).toEqual([{ type: 'deny' }]);
    unmount();
  });

  it('以数字开头的粘贴内容不触发选项', async () => {
    const { decisions, stdin, unmount } = setup();
    await tick();
    // 括号粘贴会把整段文本作为一个 input 送达,不能被 parseInt 取首位误选。
    stdin.write('3 files changed, 12 insertions(+)');
    await tick();
    expect(decisions).toEqual([]);
    unmount();
  });

  it('换成选项更少的请求时光标复位,不会读到越界选项而崩溃', async () => {
    const decisions: PermissionDecision[] = [];
    const onDecide = (decision: PermissionDecision) => decisions.push(decision);
    const { stdin, rerender, unmount } = render(
      <PermissionPrompt request={request} onDecide={onDecide} />,
    );
    await tick();
    // 移到第 4 项"拒绝"——只有带建议规则的请求才有 4 个选项。
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await tick();
    }

    // 换成没有建议规则的请求:选项只剩 2 个,残留的光标已经越界。
    rerender(
      <PermissionPrompt
        request={{ ...request, id: 'req-2', suggestedRule: undefined }}
        onDecide={onDecide}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();

    // 复位到第 1 项;修复前这里会读到 undefined 并让整个 TUI 崩掉。
    expect(decisions).toEqual([{ type: 'allow' }]);
    unmount();
  });

  it('渲染带编号的选项与提示', async () => {
    const { lastFrame, unmount } = setup();
    await tick();
    const out = lastFrame()!;
    expect(out).toContain('1.');
    expect(out).toContain('4.');
    expect(out).toContain('index.js');
    unmount();
  });
});
