/**
 * 列表面板的鼠标点击。
 *
 * 命中坐标一律从当前帧里反查(找到那一行的文字再取它的列号),不写死行号:
 * 面板的边框、标题、上/下省略提示都会挪动行位置,写死的坐标改一次文案就废。
 * 所以需要的文本都取 ASCII——captureCharFrame 是按格取字符,CJK 占两格会让
 * indexOf 的字符下标与终端列号对不上。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { PermissionPrompt } from '../../src/ui/PermissionPrompt.js';
import { RewindPicker } from '../../src/ui/RewindPicker.js';
import { SessionPicker } from '../../src/ui/SessionPicker.js';
import { SettingsPanel } from '../../src/ui/SettingsPanel.js';
import { setLocale, t } from '../../src/i18n/index.js';
import type { PermissionDecision, PermissionRequest } from '../../src/core/events.js';
import type { StatusSegment } from '../../src/config/schema.js';
import { renderUi, type UiHandle } from '../support/otui.js';
import type { JSX } from '../../src/ui/kit.js';

beforeEach(() => {
  setLocale('en');
});

/** 帧里含 needle 的那一行,以及 needle 首字符所在的列。 */
function locate(ui: UiHandle, needle: string): { x: number; y: number } {
  const lines = ui.frame().split('\n');
  const y = lines.findIndex((line) => line.includes(needle));
  expect(y, `帧里找不到 ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return { x: lines[y]!.indexOf(needle), y };
}

const clickOn = async (ui: UiHandle, needle: string): Promise<void> => {
  const { x, y } = locate(ui, needle);
  await ui.click(x, y);
};

/**
 * 越过 kit 的点击落定窗口(CLICK_SETTLE_MS = 250ms)。
 *
 * 需要它的场景只有一种:上一次点击把新内容铺到了同一片格子上,而这一次点击
 * 落在那片新内容里。真人分两步操作本来就远不止 250ms,测试里两次点击却只隔
 * 几毫秒——不等就会被当成双击的第二下吞掉(那正是这个窗口存在的理由)。
 */
const settle = () => sleep(300);

const ruledRequest: PermissionRequest = {
  id: 'req-1',
  toolName: 'write',
  title: 'write: index.js',
  suggestedRule: 'index.js',
  risk: 'write',
};

describe('PermissionPrompt 点击', () => {
  it('点击选项即决策,与数字键同一档语义', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      () => <PermissionPrompt request={ruledRequest} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    // 第 2 项 = 本次会话始终允许,带建议规则。
    await clickOn(ui, '2.');
    expect(decisions).toEqual([{ type: 'allow-always', rule: 'index.js' }]);
    await ui.destroy();
  });

  it('点在哪一项就是哪一项,与光标位置无关', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      () => <PermissionPrompt request={ruledRequest} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    await ui.press('down'); // 光标停在第 2 项
    await clickOn(ui, '4.'); // 但点的是"拒绝"
    expect(decisions).toEqual([{ type: 'deny' }]);
    await ui.destroy();
  });

  /**
   * 这条是点击判定"零位移"标准的锁:<text> 上按下就进入拖选,横向划过一行
   * 去复制文字时按下与抬起都落在这一行——判定一旦放宽到按元素比较,复制一段
   * 文本就会顺手把这一行点了(在授权框里就是手滑放行)。
   */
  it('横向拖选不算点击;拖完再点仍然正常', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      () => <PermissionPrompt request={ruledRequest} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    const row = locate(ui, '1.');
    await ui.mockMouse.drag(row.x, row.y, row.x + 8, row.y);
    await ui.tick();
    expect(decisions).toEqual([]);

    await ui.click(row.x, row.y);
    expect(decisions).toEqual([{ type: 'allow' }]);
    await ui.destroy();
  });

  it('右键不触发点击', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      () => <PermissionPrompt request={ruledRequest} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    const row = locate(ui, '1.');
    await ui.mockMouse.click(row.x, row.y, 2 /* RIGHT */);
    await ui.tick();
    expect(decisions).toEqual([]);
    await ui.destroy();
  });
});

describe('RewindPicker 点击', () => {
  const entries = [
    { index: 4, ordinal: 3, text: 'third message' },
    { index: 2, ordinal: 2, text: 'second message' },
    { index: 0, ordinal: 1, text: 'first message' },
  ];

  it('点击某一条即选中它', async () => {
    const picked: number[] = [];
    const ui = await renderUi(
      () => (
        <RewindPicker entries={entries} onPick={(e) => picked.push(e.ordinal)} onCancel={() => {}} />
      ),
      { width: 60, height: 12 },
    );
    await clickOn(ui, 'first message');
    expect(picked).toEqual([1]);
    await ui.destroy();
  });
});

describe('SessionPicker 点击', () => {
  it('点击某个会话即选中它', async () => {
    const chosen: (string | undefined)[] = [];
    const ui = await renderUi(
      () => (
        <SessionPicker
          sessions={[
            {
              id: 'abc123',
              updatedAt: '2026-08-07T12:00:00.000Z',
              provider: 'deepseek',
              model: 'deepseek-chat',
              messageCount: 4,
              title: 'fix login',
            } as never,
          ]}
          onSelect={(id) => chosen.push(id)}
        />
      ),
      { width: 80, height: 12 },
    );
    await clickOn(ui, 'fix login');
    expect(chosen).toEqual(['abc123']);
    await ui.destroy();
  });
});

describe('SettingsPanel 点击', () => {
  const panel = (over: {
    segments?: StatusSegment[];
    onLanguage?: (l: 'en' | 'zh-CN') => void;
    onStatusBar?: (s: StatusSegment[]) => void;
  }) => (
    <SettingsPanel
      language="en"
      segments={over.segments ?? []}
      onLanguage={over.onLanguage ?? (() => {})}
      onStatusBar={over.onStatusBar ?? (() => {})}
      onClose={() => {}}
    />
  );

  it('点击一级设置项进入二级,点击语言即选定', async () => {
    const picked: string[] = [];
    const ui = await renderUi(() => panel({ onLanguage: (l) => picked.push(l) }), {
      width: 70,
      height: 20,
    });
    await clickOn(ui, t('settings.language'));
    // 进了二级:语言列表以各自母语写法列出。
    expect(ui.frame()).toContain('English');

    await settle();
    await clickOn(ui, 'zh-CN');
    expect(picked).toEqual(['zh-CN']);
    await ui.destroy();
  });

  /** 多选那一支:点击一行只是勾选(等价于空格),回车才提交。 */
  it('状态栏分区里点击行 = 勾选,回车提交草稿', async () => {
    const committed: StatusSegment[][] = [];
    const ui = await renderUi(() => panel({ onStatusBar: (s) => committed.push(s) }), {
      width: 70,
      height: 20,
    });
    await clickOn(ui, t('settings.statusbar'));
    expect(ui.frame()).toContain('Current model id');

    await settle();
    await clickOn(ui, 'model');
    expect(committed).toEqual([]); // 只勾选,没提交
    await ui.press('return');
    expect(committed).toEqual([['model']]);
    await ui.destroy();
  });

  it('再点一次取消勾选', async () => {
    const committed: StatusSegment[][] = [];
    const ui = await renderUi(
      () => panel({ segments: ['model'], onStatusBar: (s) => committed.push(s) }),
      { width: 70, height: 20 },
    );
    await clickOn(ui, t('settings.statusbar'));
    await settle();
    await clickOn(ui, 'model');
    await ui.press('return');
    expect(committed).toEqual([[]]);
    await ui.destroy();
  });
});

/**
 * 两条回归:kit 点击判定自身的漏洞,都会以"用户从没点过的选项被选中"收场。
 */
describe('点击判定的边界', () => {
  /**
   * 按下落在 A、拖走后在别处抬起——A 等不到自己的那次 up。按下坐标若是每个
   * 元素各存一份,A 就一直武装着,之后任何**结束**在同一格的拖动都会被它判成
   * 点击(在授权框里 = 凭空放行一次)。坐标必须是模块级共享的一份。
   */
  it('按下后拖走,再反向拖回同一格不会补触发点击', async () => {
    const decisions: PermissionDecision[] = [];
    const ui = await renderUi(
      () => <PermissionPrompt request={ruledRequest} onDecide={(d) => decisions.push(d)} />,
      { width: 70, height: 14 },
    );
    const first = locate(ui, '1.');
    const second = locate(ui, '2.');

    // 在第 1 项上按下,拖到第 2 项抬起(一次跨行选区)。
    await ui.mockMouse.drag(first.x, first.y, second.x, second.y);
    await ui.tick();
    expect(decisions).toEqual([]);

    // 另起一次选区,反向拖动、正好停在第 1 项那一格上。
    await ui.mockMouse.drag(second.x + 6, second.y, first.x, first.y);
    await ui.tick();
    expect(decisions).toEqual([]);
    await ui.destroy();
  });

  /**
   * 双击的第二下会落在第一下刚变出来的内容上:点「语言」进二级,语言列表就
   * 铺在刚才那几行上,第二下正好选中其中一项——zh-CN 用户双击「语言」会被
   * 静默切成英文。
   */
  it('双击不会顺带选中新铺上来的那一行', async () => {
    const picked: string[] = [];
    const ui = await renderUi(() => panelFixture((l) => picked.push(l)), {
      width: 70,
      height: 20,
    });
    const row = locate(ui, t('settings.language'));

    await ui.mockMouse.doubleClick(row.x, row.y);
    await ui.tick();

    // 第一下进了二级,第二下被落定窗口吞掉——没有选定任何语言。
    expect(ui.frame()).toContain('English');
    expect(picked).toEqual([]);
    await ui.destroy();
  });
});

/** 上面那条双击回归用的面板(与 SettingsPanel 点击那组同构)。 */
function panelFixture(onLanguage: (l: 'en' | 'zh-CN') => void): JSX.Element {
  return (
    <SettingsPanel
      language="en"
      segments={[]}
      onLanguage={onLanguage}
      onStatusBar={() => {}}
      onClose={() => {}}
    />
  );
}
