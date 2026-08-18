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
