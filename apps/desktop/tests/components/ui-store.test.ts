/**
 * uiStore 视图状态机:home/task/archive/settings 迁移、returnView 记忆、
 * taskLayout 与 rightTab 的正交切换。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../../src/renderer/state/uiStore.js';

beforeEach(() => {
  useUiStore.setState({
    view: 'task',
    returnView: 'task',
    taskLayout: 'chat',
    rightTab: 'diff',
    width: 264,
    collapsed: false,
    panelWidth: 480,
  });
});

describe('uiStore 视图状态机', () => {
  it('navigate 在三个主视图间切换;进 task 时布局回到 chat', () => {
    const s = useUiStore.getState();
    s.navigate('home');
    expect(useUiStore.getState().view).toBe('home');
    useUiStore.setState({ taskLayout: 'review' });
    useUiStore.getState().navigate('task');
    expect(useUiStore.getState().view).toBe('task');
    expect(useUiStore.getState().taskLayout).toBe('chat');
  });

  it('openSettings 记录来处,closeSettings 回去;settings 内切节不覆盖来处', () => {
    useUiStore.getState().navigate('archive');
    useUiStore.getState().openSettings('models');
    expect(useUiStore.getState().view).toBe('settings');
    expect(useUiStore.getState().settingsSection).toBe('models');
    // settings 内再次 openSettings(切节)不改 returnView。
    useUiStore.getState().openSettings('general');
    useUiStore.getState().closeSettings();
    expect(useUiStore.getState().view).toBe('archive');
  });

  it('toggleReviewLayout 在 chat/review 间往复;setRightTab 切 tab', () => {
    useUiStore.getState().toggleReviewLayout();
    expect(useUiStore.getState().taskLayout).toBe('review');
    useUiStore.getState().toggleReviewLayout();
    expect(useUiStore.getState().taskLayout).toBe('chat');
    useUiStore.getState().setRightTab('terminal');
    expect(useUiStore.getState().rightTab).toBe('terminal');
  });
});

describe('uiStore 面板宽度', () => {
  it('setPanelWidth 钳制 240~720,并给会话区留最小宽(侧栏实宽从 store 读)', () => {
    const s = useUiStore.getState();
    s.setPanelWidth(100, 2000);
    expect(useUiStore.getState().panelWidth).toBe(240); // 下限
    useUiStore.getState().setPanelWidth(900, 2000);
    expect(useUiStore.getState().panelWidth).toBe(720); // 上限
    // 视口 1100 - 侧栏 264 - CHAT_MIN_WIDTH 360 = 476:上限被会话区最小宽压低
    useUiStore.getState().setPanelWidth(700, 1100);
    expect(useUiStore.getState().panelWidth).toBe(476);
    // 侧栏折叠时不占宽:同样视口上限放宽到 1100 - 0 - 360 = 740 → 封顶 720
    useUiStore.setState({ collapsed: true });
    useUiStore.getState().setPanelWidth(700, 1100);
    expect(useUiStore.getState().panelWidth).toBe(700);
  });

  it('窗口极窄时上限压不过 240 下限(CSS 端兜底,store 不产出更小值)', () => {
    useUiStore.getState().setPanelWidth(300, 500);
    expect(useUiStore.getState().panelWidth).toBe(240);
  });
});
