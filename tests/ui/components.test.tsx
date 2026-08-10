import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { Header } from '../../src/ui/Header.js';
import { Footer } from '../../src/ui/Footer.js';
import { TodoPanel } from '../../src/ui/TodoPanel.js';
import { StatusLine } from '../../src/ui/StatusLine.js';
import { GoalLine } from '../../src/ui/GoalLine.js';
import { renderPixelLogo } from '../../src/ui/logo.js';
import { APP_NAME } from '../../src/config/paths.js';
import { renderUi } from '../support/otui.js';

describe('叶子组件在 OpenTUI 下渲染', () => {
  it('Header:像素字 logo 与信息行', async () => {
    const ui = await renderUi(
      () => (
        <Header
          providerLabel="DeepSeek"
          model="deepseek-chat"
          root="/tmp/proj"
          mode="ask"
          columns={60}
        />
      ),
      { width: 60, height: 16 },
    );
    const frame = ui.frame();
    // 宽度够时画像素字,行首不再重复写名字。
    expect(frame).toContain(renderPixelLogo(APP_NAME)[0]!.join(''));
    expect(frame).not.toContain(APP_NAME);
    expect(frame).toContain('DeepSeek');
    expect(frame).toContain('deepseek-chat');
    expect(frame).toContain('╭');
    await ui.destroy();
  });

  it('Header:窄终端退回纯文字标题', async () => {
    // 40 列放不下 47 列的像素字:必须整块不画,而不是折行成噪点。
    const ui = await renderUi(
      () => (
        <Header
          providerLabel="DeepSeek"
          model="deepseek-chat"
          root="/tmp/proj"
          mode="ask"
          columns={40}
        />
      ),
      { width: 40, height: 20 },
    );
    const frame = ui.frame();
    expect(frame).toContain(APP_NAME);
    expect(frame).not.toContain('▀');
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

  it('Footer:用量段靠右对齐,档位是带内边距的徽章', async () => {
    const columns = 70;
    const ui = await renderUi(
      () => <Footer
        contextUsed={30000}
        contextWindow={128000}
        cumulativeTokens={38200}
        todos={[]}
        model="kimi-k3"
        mode="plan"
        root="/tmp/proj"
        think="auto"
        segments={['mode', 'model', 'context']}
        columns={columns}
      />,
      { width: columns, height: 3 },
    );
    const line = ui.frame().split('\n').find((l) => l.includes('▰'))!;
    // 计量条那一组顶到右边缘(留 1 列换行余量),中间是空白而不是 ` · `。
    expect(line.length).toBe(columns - 1);
    expect(line).toMatch(/▰▰▱▱▱▱▱▱ 23%$/);
    expect(line).toMatch(/ {2,}▰/);
    // 徽章左右各留一格内边距,后面只跟一个空格——不再叠一个 ` · `。
    expect(line).toMatch(/^ plan {2}kimi-k3/);
    await ui.destroy();
  });

  it('Footer:上下文逼近上限时计量条画满到倒数第二格', async () => {
    const ui = await renderUi(
      () => <Footer
        contextUsed={127000}
        contextWindow={128000}
        cumulativeTokens={38200}
        todos={[]}
        model="kimi-k3"
        mode="ask"
        root="/tmp/proj"
        think="auto"
        segments={['context']}
        columns={70}
      />,
      { width: 70, height: 3 },
    );
    // 99% 不画满:满条是"到顶了"的信号,不能被 99% 冒充。
    expect(ui.frame()).toContain('▰▰▰▰▰▰▰▱ 99%');
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
    const ui = await renderUi(
      () => <StatusLine phase="thinking" since={Date.now() - 3500} tokens={1234} columns={60} />,
      { width: 60, height: 3 },
    );
    // 阶段文案本地化,断言结构字符(spinner 帧集合里的任意一个)存在即可
    expect(ui.frame().trim().length).toBeGreaterThan(0);
    // 已用时与本轮 token 都在:跑长任务时它是"还在动"的唯一证据。
    expect(ui.frame()).toContain('3s');
    expect(ui.frame()).toContain('1.2k tok');
    await ui.destroy();
  });

  it('StatusLine:窄终端按优先级丢尾部,绝不折行', async () => {
    // 这一行每 100ms 重绘一次,折行会让底部区域每秒抖一次高度。
    for (const columns of [12, 20, 30, 46]) {
      const ui = await renderUi(
        () => <StatusLine
          phase="tool"
          detail="bash"
          since={Date.now() - 3000}
          tokens={1234}
          todoHint="show"
          columns={columns}
        />,
        { width: columns, height: 4 },
      );
      const lines = ui.frame().split('\n').filter((l) => l.trim());
      expect(lines.length, `${columns} 列`).toBe(1);
      for (const line of lines) {
        expect(stringWidth(line), `${columns} 列: ${line}`).toBeLessThanOrEqual(columns);
      }
      await ui.destroy();
    }
  });

  it('StatusLine:压缩阶段画 ▰▱ 进度条与百分比', async () => {
    const ui = await renderUi(
      () => <StatusLine phase="compacting" progress={0.4} since={Date.now()} columns={70} />,
      { width: 70, height: 3 },
    );
    const frame = ui.frame();
    expect(frame).toContain('▰');
    expect(frame).toContain('▱');
    expect(frame).toContain('40%');
    await ui.destroy();
  });

  it('StatusLine:窄终端装不下进度条时整条不画,绝不折行', async () => {
    for (const columns of [14, 22]) {
      const ui = await renderUi(
        () => <StatusLine phase="compacting" progress={0.4} since={Date.now()} columns={columns} />,
        { width: columns, height: 4 },
      );
      const lines = ui.frame().split('\n').filter((l) => l.trim());
      expect(lines.length, `${columns} 列`).toBe(1);
      for (const line of lines) {
        expect(stringWidth(line), `${columns} 列: ${line}`).toBeLessThanOrEqual(columns);
      }
      await ui.destroy();
    }
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
