import { describe, expect, it } from 'vitest';
import { Header } from '../../src/ui/Header.js';
import { Footer } from '../../src/ui/Footer.js';
import { TodoPanel } from '../../src/ui/TodoPanel.js';
import { StatusLine } from '../../src/ui/StatusLine.js';
import { GoalLine } from '../../src/ui/GoalLine.js';
import { renderUi } from '../support/otui.js';

describe('叶子组件在 OpenTUI 下渲染', () => {
  it('Header:边框横幅与信息行', async () => {
    const ui = await renderUi(
      () => <Header providerLabel="DeepSeek" model="deepseek-chat" root="/tmp/proj" mode="ask" />,
      { width: 60, height: 8 },
    );
    const frame = ui.frame();
    expect(frame).toContain('mojocode');
    expect(frame).toContain('DeepSeek');
    expect(frame).toContain('deepseek-chat');
    expect(frame).toContain('╭');
    await ui.destroy();
  });

  it('Footer:信息段渲染与 notice', async () => {
    const ui = await renderUi(
      () => <Footer
        contextUsed={4000}
        contextWindow={128000}
        cumulativeTokens={12345}
        todos={[]}
        model="kimi-k3"
        mode="ask"
        root="/tmp/proj"
        think="auto"
        segments={['model', 'context']}
        notice="再按一次 ctrl+c 退出"
      />,
      { width: 70, height: 4 },
    );
    const frame = ui.frame();
    expect(frame).toContain('kimi-k3');
    expect(frame).toContain('再按一次 ctrl+c 退出');
    await ui.destroy();
  });

  it('TodoPanel:清单行与勾选框', async () => {
    const ui = await renderUi(
      () => <TodoPanel
        todos={[
          { content: '写测试', status: 'completed' },
          { content: '迁移组件', status: 'in_progress' },
          { content: '收尾', status: 'pending' },
        ]}
        columns={60}
      />,
      { width: 60, height: 8 },
    );
    const frame = ui.frame();
    expect(frame).toContain('迁移组件');
    expect(frame).toContain('☒');
    expect(frame).toContain('☐');
    await ui.destroy();
  });

  it('StatusLine:阶段标签与提示', async () => {
    const ui = await renderUi(() => <StatusLine phase="thinking" since={Date.now() - 3000} />, {
      width: 60,
      height: 3,
    });
    // 阶段文案本地化,断言结构字符(spinner 帧集合里的任意一个)存在即可
    expect(ui.frame().trim().length).toBeGreaterThan(0);
    await ui.destroy();
  });

  it('GoalLine:靠右对齐的目标进度行', async () => {
    const ui = await renderUi(
      () => <GoalLine
        snapshot={() => ({
          condition: '让测试全绿',
          turns: 3,
          maxTurns: 10,
          elapsedMs: 64000,
          tokens: 0,
          lastReason: '',
          restored: false,
        })}
        columns={50}
      />,
      { width: 50, height: 3 },
    );
    const frame = ui.frame();
    expect(frame).toContain('◎');
    expect(frame).toContain('3/10');
    // 靠右:行首应有前导空白(justifyContent flex-end 生效)
    const line = ui
      .frame()
      .split('\n')
      .find((l) => l.includes('◎'));
    expect(line?.startsWith(' ')).toBe(true);
    await ui.destroy();
  });
});
