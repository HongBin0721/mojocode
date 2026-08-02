import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { PermissionPrompt } from '../src/ui/PermissionPrompt.js';
import { t } from '../src/i18n/index.js';
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

describe('方案审批确认框', () => {
  const planRequest = (detail: string): PermissionRequest => ({
    id: 'plan-1',
    kind: 'plan',
    toolName: 'exit_plan',
    title: '可以开始写了吗？',
    detail,
    risk: 'write',
  });

  it('只给「同意 / 继续完善」两项,不给记规则的选项', async () => {
    const { lastFrame, unmount } = setup(planRequest('# 方案\n\n1. 改 a.ts'));
    await tick();
    const out = lastFrame() ?? '';
    expect(out).toContain(t('perm.planApprove'));
    expect(out).toContain(t('perm.planKeepPlanning'));
    // 方案不产生规则,"始终允许"那套对它没有意义。
    expect(out).not.toContain(t('perm.alwaysSession'));
    expect(out).not.toContain(t('perm.alwaysPersist'));
    unmount();
  });

  it('esc 视为继续完善,并把理由带给模型', async () => {
    const { stdin, decisions, unmount } = setup(planRequest('# 方案'));
    await tick();
    stdin.write(ESC);
    await tick();
    expect(decisions).toEqual([{ type: 'deny', reason: 'the user wants to keep refining the plan' }]);
    unmount();
  });

  // y/n 对"批准整份方案"太含糊,一个手滑就让方案过了。
  it('不接 y/n 快捷键', async () => {
    const { stdin, decisions, unmount } = setup(planRequest('# 方案'));
    await tick();
    stdin.write('y');
    await tick();
    stdin.write('n');
    await tick();
    expect(decisions).toEqual([]);
    unmount();
  });

  // 只数换行符的话,散文段落折行后能把一帧撑到视口以上,触发 ink 重放
  // 整段已累积的 <Static> 输出。
  it('长散文按折行后的实际行数截断,而不是按换行符数', async () => {
    const prose = Array.from({ length: 12 }, (_, i) => `第 ${i} 段。${'很长的句子。'.repeat(20)}`);
    const { lastFrame, unmount } = setup(planRequest(prose.join('\n')));
    await tick();
    const rows = (lastFrame() ?? '').split('\n').length;
    // 12 行"才 12 个换行符",但折行后远超视口;截断后整帧必须仍然可控。
    expect(rows).toBeLessThan(40);
    // 截断标记(ui.moreLines 两种语言都以 … 开头),证明确实截过而不是碰巧短。
    expect(lastFrame()).toContain('…');
    unmount();
  });
});

describe('方案正文截断的边界', () => {
  const planRequest = (detail: string): PermissionRequest => ({
    id: 'plan-2',
    kind: 'plan',
    toolName: 'exit_plan',
    title: 'x',
    detail,
    risk: 'write',
  });

  // 首行自己就超预算(整段没有换行)时,不能只剩一行"还有 N 行"。
  it('单段超长正文仍展示内容,而不是只剩截断标记', async () => {
    const { lastFrame, unmount } = setup(planRequest('很长的一整段。'.repeat(400)));
    await tick();
    const out = lastFrame() ?? '';
    expect(out).toContain('很长的一整段');
    expect(out.split('\n').length).toBeLessThan(40);
    unmount();
  });

  it('短方案原样展示,不加截断标记', async () => {
    const { lastFrame, unmount } = setup(planRequest('# 方案\n\n1. 改 a.ts'));
    await tick();
    expect(lastFrame()).not.toContain('…');
    unmount();
  });
});
