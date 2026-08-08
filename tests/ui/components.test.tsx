import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
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
        columns={70}
        notice="再按一次 ctrl+c 退出"
      />,
      { width: 70, height: 4 },
    );
    const frame = ui.frame();
    expect(frame).toContain('kimi-k3');
    expect(frame).toContain('再按一次 ctrl+c 退出');
    await ui.destroy();
  });

  // 超宽时 OpenTUI 收缩的是子节点本身,分隔符两侧的空格会被吃掉
  // (`full-access· kimi-k3 · …/demo· 思考 max`)——必须自己先裁到装得下。
  it('Footer:全段开启的窄终端下不超宽、不吞分隔符空格', async () => {
    const columns = 60;
    const ui = await renderUi(
      () => <Footer
        contextUsed={2700}
        contextWindow={1_000_000}
        cumulativeTokens={10000}
        todos={[]}
        model="kimi-k3"
        mode="full-access"
        root="/private/tmp/claude-501/very/deep/scratchpad/mcdemo"
        think="max"
        segments={['mode', 'model', 'cwd', 'think', 'context', 'total']}
        columns={columns}
      />,
      { width: columns, height: 6 },
    );
    const lines = ui.frame().split('\n').map((l) => l.trimEnd());
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns);
    const body = lines.filter(Boolean).join('\n');
    expect(body).not.toMatch(/\S·|·\S/);
    // 权限档位在任何宽度下都不能被丢掉
    expect(body).toContain('full-access');
    await ui.destroy();
  });

  // 预算下限若取固定值(曾经是 20),更窄的终端上就会按看不见的宽度裁剪,
  // 每一段都溢出折行,底栏胀成好几行把输入框顶出视口——正是它要防的事。
  it('Footer:极窄终端下不折行,行数不超过两行', async () => {
    for (const columns of [10, 14, 20, 28]) {
      const ui = await renderUi(
        () => <Footer
          contextUsed={2700}
          contextWindow={1_000_000}
          cumulativeTokens={10000}
          todos={[{ content: '一个很长很长的任务标题需要被截断', status: 'in_progress' }]}
          model="kimi-k3"
          mode="full-access"
          root="/private/tmp/claude-501/very/deep/scratchpad/mcdemo"
          think="max"
          segments={['mode', 'model', 'cwd', 'think', 'context', 'total', 'todos']}
          columns={columns}
          notice="再按一次 ctrl+c 退出"
        />,
        { width: columns, height: 10 },
      );
      const lines = ui.frame().split('\n').filter((l) => l.trim());
      // 最多四行:任务、提醒、独占一行的路径、信息段——谁都不许再折出第五行
      expect(lines.length, `${columns} 列`).toBeLessThanOrEqual(4);
      for (const line of lines) expect(stringWidth(line), `${columns} 列: ${line}`).toBeLessThanOrEqual(columns);
      await ui.destroy();
    }
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
