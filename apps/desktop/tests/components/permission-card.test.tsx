// @vitest-environment jsdom
/**
 * 审批卡组件测试:tool 形态(编号选项 + 四档决策 + diff 视图 + 键盘流)、
 * plan 形态(两键 + markdown 正文)。onDecide 经 props 注入,不触碰桥。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PermissionDecision, PermissionRequest } from '@core/events';
import { setLocale } from '../../src/renderer/i18n/index.js';
import { PermissionCard } from '../../src/renderer/components/PermissionCard.js';

// jsdom 的 navigator.language 是 en-US:按钮文案断言按中文目录写,显式定 locale。
setLocale('zh-CN');

const toolRequest: PermissionRequest = {
  id: 'p1',
  toolName: 'edit',
  title: 'edit: src/a.ts',
  detail: `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 old
-removed line
+added line
+another
 context`,
  suggestedRule: 'Edit(src/a.ts)',
  risk: 'write',
};

/** 卡片根元素(挂载即聚焦,键盘事件打给它)。 */
function card(): HTMLElement {
  return screen.getByTestId('permission-card');
}

describe('PermissionCard', () => {
  it('tool 形态:diff detail 走 DiffView,编号选项点击各回调正确', async () => {
    const onDecide = vi.fn<(decision: PermissionDecision) => void>();
    render(<PermissionCard request={toolRequest} onDecide={onDecide} />);
    const user = userEvent.setup();

    // diff 渲染:统计行与增删行。
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    expect(screen.getByText('+added line')).toBeTruthy();
    expect(screen.getByText('-removed line')).toBeTruthy();

    await user.click(screen.getByRole('option', { name: /允许一次/ }));
    await user.click(screen.getByRole('option', { name: /本会话始终允许/ }));
    await user.click(screen.getByRole('option', { name: /始终允许\(写入工作区\)/ }));
    await user.click(screen.getByRole('option', { name: /拒绝/ }));
    expect(onDecide).toHaveBeenNthCalledWith(1, { type: 'allow' });
    expect(onDecide).toHaveBeenNthCalledWith(2, { type: 'allow-always', rule: 'Edit(src/a.ts)' });
    expect(onDecide).toHaveBeenNthCalledWith(3, { type: 'allow-persist', rule: 'Edit(src/a.ts)' });
    expect(onDecide).toHaveBeenNthCalledWith(4, { type: 'deny' });
  });

  it('数字键直选:1=允许,4=拒绝(ZCode 快捷键)', async () => {
    const onDecide = vi.fn<(decision: PermissionDecision) => void>();
    render(<PermissionCard request={toolRequest} onDecide={onDecide} />);
    const user = userEvent.setup();
    await user.keyboard('1');
    await user.keyboard('4');
    expect(onDecide).toHaveBeenNthCalledWith(1, { type: 'allow' });
    expect(onDecide).toHaveBeenNthCalledWith(2, { type: 'deny' });
  });

  it('方向键移动高亮,Enter 确认高亮项', async () => {
    const onDecide = vi.fn<(decision: PermissionDecision) => void>();
    render(<PermissionCard request={toolRequest} onDecide={onDecide} />);
    const user = userEvent.setup();
    await user.keyboard('{ArrowDown}{ArrowDown}'); // 高亮 3=allow-persist
    expect(card().querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(onDecide).toHaveBeenCalledWith({ type: 'allow-persist', rule: 'Edit(src/a.ts)' });
  });

  it('无 suggestedRule 时只显示 单次/拒绝 两档,数字键 2=拒绝', async () => {
    const onDecide = vi.fn<(decision: PermissionDecision) => void>();
    const request: PermissionRequest = { ...toolRequest, suggestedRule: undefined, detail: 'npm test' };
    render(<PermissionCard request={request} onDecide={onDecide} />);
    expect(screen.queryByRole('option', { name: /本会话始终允许/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /始终允许/ })).toBeNull();
    // 非 diff 的 detail 按命令文本展示;标题行是「需要权限」+ mono 子标题。
    expect(screen.getByText('需要权限')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    const user = userEvent.setup();
    await user.keyboard('2');
    expect(onDecide).toHaveBeenCalledWith({ type: 'deny' });
  });

  it('plan 形态:markdown 正文 + 批准/驳回两键', async () => {
    const onDecide = vi.fn<(decision: PermissionDecision) => void>();
    const request: PermissionRequest = {
      id: 'p2',
      toolName: 'exit_plan',
      kind: 'plan',
      title: '实施方案',
      detail: '# 方案\n\n1. 改 a.ts\n2. 跑测试',
      risk: 'write',
    };
    render(<PermissionCard request={request} onDecide={onDecide} />);
    const user = userEvent.setup();
    // markdown 正文渲染成标题。
    expect((screen.getByText('方案') as HTMLElement).tagName).toBe('H1');
    await user.click(screen.getByRole('button', { name: '批准方案' }));
    await user.click(screen.getByRole('button', { name: '驳回' }));
    expect(onDecide).toHaveBeenNthCalledWith(1, { type: 'allow' });
    expect(onDecide).toHaveBeenNthCalledWith(2, { type: 'deny' });
  });
});
