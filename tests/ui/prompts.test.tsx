import { describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { PermissionPrompt } from '../../src/ui/PermissionPrompt.js';
import { RewindPicker } from '../../src/ui/RewindPicker.js';
import { SessionPicker } from '../../src/ui/SessionPicker.js';
import { useInput } from '../../src/ui/kit.js';
import { t } from '../../src/i18n/index.js';
import type { PermissionDecision, PermissionRequest } from '../../src/core/events.js';
import { renderUi } from '../support/otui.js';

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'r1',
  toolName: 'bash',
  title: 'bash: npm test',
  risk: 'execute',
  ...over,
});

describe('PermissionPrompt', () => {
  it('渲染标题与选项,回车选中第一项', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt request={request()} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    expect(ui.frame()).toContain('bash: npm test');
    expect(ui.frame()).toContain('❯');
    await ui.press('return');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.type).toBe('allow');
    await ui.destroy();
  });

  it('↓ 移动光标后回车选择另一项', async () => {
    const first: PermissionDecision[] = [];
    const moved: PermissionDecision[] = [];
    const probe = async (down: boolean, sink: PermissionDecision[]) => {
      const ui = await renderUi(
        <PermissionPrompt request={request()} onDecide={(d) => sink.push(d)} />,
        { width: 70, height: 14 },
      );
      if (down) await ui.press('down');
      await ui.press('return');
      await ui.destroy();
    };
    await probe(false, first);
    await probe(true, moved);
    expect(first).toHaveLength(1);
    expect(moved).toHaveLength(1);
    // 光标移动后选到的是不同的选项
    expect(JSON.stringify(moved[0])).not.toBe(JSON.stringify(first[0]));
    await Promise.resolve();
  });

  it('数字键直达;粘贴以数字开头的长文本不误触(Ink 语义回归)', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt request={request()} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    await ui.paste('3 files changed, 12 insertions(+)');
    expect(decisions).toHaveLength(0);
    await ui.press('1');
    expect(decisions).toHaveLength(1);
    await ui.destroy();
  });

  it('esc = 拒绝;y/n 快捷键', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt request={request()} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    await ui.press('escape');
    expect(decisions[0]?.type).toBe('deny');
    await ui.press('y');
    expect(decisions[1]?.type).toBe('allow');
    await ui.destroy();
  });

  it('diff 详情走 Diff 渲染', async () => {
    const patch = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-旧\n+新\n';
    const ui = await renderUi(
      <PermissionPrompt request={request({ toolName: 'write', title: 'write: x', detail: patch })} onDecide={() => {}} />,
      { width: 70, height: 16 },
    );
    expect(ui.frame()).toContain('+ 新');
    expect(ui.frame()).toContain('- 旧');
    await ui.destroy();
  });
});

/** 带建议规则的写入请求:选项共 4 项(允许一次 / 会话始终 / 落盘始终 / 拒绝)。 */
const ruledRequest = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'req-1',
  toolName: 'write',
  title: 'write: index.js',
  suggestedRule: 'index.js',
  risk: 'write',
  ...over,
});

/**
 * 光标越界回归的宿主:OpenTUI harness 没有 rerender,用一个小状态组件承载
 * 请求切换——按 x 键把带建议规则的请求换成没有建议规则的(选项 4 → 2)。
 */
function SwapHost({ onDecide }: { onDecide: (d: PermissionDecision) => void }) {
  const [req, setReq] = useState<PermissionRequest>(() => ruledRequest());
  useInput((input) => {
    if (input === 'x') setReq((prev) => ({ ...prev, id: 'req-2', suggestedRule: undefined }));
  });
  return <PermissionPrompt request={req} onDecide={onDecide} />;
}

describe('PermissionPrompt 选项边界', () => {
  it('上下键移动到"拒绝"后回车', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt request={ruledRequest()} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    await ui.press('down');
    await ui.press('down');
    await ui.press('down'); // 1→2→3→4(拒绝)
    await ui.press('return');
    expect(decisions).toEqual([{ type: 'deny' }]);
    await ui.destroy();
  });

  it('数字键直达"本次会话始终允许"并携带规则', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt request={ruledRequest()} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    await ui.press('2');
    expect(decisions).toEqual([{ type: 'allow-always', rule: 'index.js' }]);
    await ui.destroy();
  });

  it('没有建议规则时数字 2 对应"拒绝"', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt
        request={ruledRequest({ suggestedRule: undefined })}
        onDecide={(d) => decisions.push(d)}
      />,
      { width: 70, height: 14 },
    );
    await ui.press('2');
    expect(decisions).toEqual([{ type: 'deny' }]);
    await ui.destroy();
  });

  it('渲染带编号的选项与提示', async () => {
    const ui = await renderUi(
      <PermissionPrompt request={ruledRequest()} onDecide={() => {}} />,
      { width: 70, height: 14 },
    );
    const out = ui.frame();
    expect(out).toContain('1.');
    expect(out).toContain('4.');
    expect(out).toContain('index.js');
    await ui.destroy();
  });

  it('换成选项更少的请求时光标复位,不会读到越界选项而崩溃', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(<SwapHost onDecide={(d) => decisions.push(d)} />, {
      width: 70,
      height: 14,
    });
    // 移到第 4 项"拒绝"——只有带建议规则的请求才有 4 个选项。
    await ui.press('down');
    await ui.press('down');
    await ui.press('down');

    // 换成没有建议规则的请求:选项只剩 2 个,残留的光标已经越界。
    await ui.type('x');
    await ui.tick();
    await ui.press('return');

    // 复位到第 1 项;修复前这里会读到 undefined 并让整个 TUI 崩掉。
    expect(decisions).toEqual([{ type: 'allow' }]);
    await ui.destroy();
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
    const ui = await renderUi(
      <PermissionPrompt request={planRequest('# 方案\n\n1. 改 a.ts')} onDecide={() => {}} />,
      { width: 80, height: 20 },
    );
    const out = ui.frame();
    expect(out).toContain(t('perm.planApprove'));
    expect(out).toContain(t('perm.planKeepPlanning'));
    // 方案不产生规则,"始终允许"那套对它没有意义。
    expect(out).not.toContain(t('perm.alwaysSession'));
    expect(out).not.toContain(t('perm.alwaysPersist'));
    await ui.destroy();
  });

  it('esc 视为继续完善,并把理由带给模型', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt request={planRequest('# 方案')} onDecide={(d) => decisions.push(d)} />,
      { width: 80, height: 16 },
    );
    await ui.press('escape');
    expect(decisions).toEqual([
      { type: 'deny', reason: 'the user wants to keep refining the plan' },
    ]);
    await ui.destroy();
  });

  // y/n 对"批准整份方案"太含糊,一个手滑就让方案过了。
  it('不接 y/n 快捷键', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      <PermissionPrompt request={planRequest('# 方案')} onDecide={(d) => decisions.push(d)} />,
      { width: 80, height: 16 },
    );
    await ui.type('y');
    await ui.type('n');
    expect(decisions).toEqual([]);
    await ui.destroy();
  });

  // 只数换行符的话,散文段落折行后能把确认框撑到视口以上——必须按折行后
  // 的实际行数截断。帧永远是整个视口的高度,所以数非空行而不是总行数。
  it('长散文按折行后的实际行数截断,而不是按换行符数', async () => {
    const prose = Array.from({ length: 12 }, (_, i) => `第 ${i} 段。${'很长的句子。'.repeat(20)}`);
    const ui = await renderUi(
      <PermissionPrompt request={planRequest(prose.join('\n'))} onDecide={() => {}} />,
      { width: 80, height: 45 },
    );
    const frame = ui.frame();
    const rows = frame.split('\n').filter((line) => line.trim() !== '').length;
    // 12 行"才 12 个换行符",但折行后远超视口;截断后整帧必须仍然可控。
    expect(rows).toBeLessThan(40);
    // 截断标记(ui.moreLines 两种语言都以 … 开头),证明确实截过而不是碰巧短。
    expect(frame).toContain('…');
    await ui.destroy();
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
    const ui = await renderUi(
      <PermissionPrompt request={planRequest('很长的一整段。'.repeat(400))} onDecide={() => {}} />,
      { width: 80, height: 45 },
    );
    const frame = ui.frame();
    expect(frame).toContain('很长的一整段');
    expect(frame.split('\n').filter((line) => line.trim() !== '').length).toBeLessThan(40);
    await ui.destroy();
  });

  it('短方案原样展示,不加截断标记', async () => {
    const ui = await renderUi(
      <PermissionPrompt request={planRequest('# 方案\n\n1. 改 a.ts')} onDecide={() => {}} />,
      { width: 80, height: 20 },
    );
    expect(ui.frame()).not.toContain('…');
    await ui.destroy();
  });
});

describe('RewindPicker', () => {
  const entries = [
    { index: 4, ordinal: 3, text: '第三条消息' },
    { index: 2, ordinal: 2, text: '第二条消息' },
    { index: 0, ordinal: 1, text: '第一条消息' },
  ];

  it('列表渲染与选择', async () => {
    const picked: number[] = [];
    const ui = await renderUi(
      <RewindPicker entries={entries} onPick={(e) => picked.push(e.ordinal)} onCancel={() => {}} />,
      { width: 60, height: 10 },
    );
    expect(ui.frame()).toContain('第三条消息');
    await ui.press('down');
    await ui.press('return');
    expect(picked).toEqual([2]);
    await ui.destroy();
  });

  it('esc 取消', async () => {
    let cancelled = false;
    const ui = await renderUi(
      <RewindPicker entries={entries} onPick={() => {}} onCancel={() => (cancelled = true)} />,
      { width: 60, height: 10 },
    );
    await ui.press('escape');
    expect(cancelled).toBe(true);
    await ui.destroy();
  });
});

describe('SessionPicker', () => {
  it('渲染会话列表并选择', async () => {
    const chosen: (string | undefined)[] = [];
    const ui = await renderUi(
      <SessionPicker
        sessions={[
          {
            id: 'abc123',
            updatedAt: '2026-08-07T12:00:00.000Z',
            provider: 'deepseek',
            model: 'deepseek-chat',
            messageCount: 4,
            title: '修复登录问题',
          } as never,
        ]}
        onSelect={(id) => chosen.push(id)}
      />,
      { width: 80, height: 10 },
    );
    expect(ui.frame()).toContain('修复登录问题');
    await ui.press('return');
    expect(chosen).toEqual(['abc123']);
    await ui.destroy();
  });
});
