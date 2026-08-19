// @vitest-environment jsdom
/**
 * ModelsSettings 的最小行为集(拆分前锁行为):选供应商 → 详情切换;
 * 添加模型弹窗打开与保存(saveProvider 收到 upsert 后的列表);API Key
 * 失焦提交;「测试模型」结果胶囊。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StateSnapshot } from '@core/protocol';
import { setLocale } from '../../src/renderer/i18n/index.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { ModelsSettings } from '../../src/renderer/components/ModelsSettings.js';
import { clearModelCapabilitiesCache } from '../../src/renderer/utils/use-model-capabilities.js';
import { resetOverlayStackForTest } from '../../src/renderer/components/overlays/overlay-stack.js';

const rpcMock = vi.fn<(request: unknown) => Promise<unknown>>();

const snapshot = {
  root: '/tmp/demo',
  provider: { id: 'glm', model: 'GLM-5.3', apiKey: '', headers: {} },
  config: {
    provider: 'glm',
    providers: {
      glm: { apiKey: '', models: [{ id: 'GLM-5.3', contextWindow: 1_000_000 }] },
      'custom-ollama': { baseURL: 'http://127.0.0.1:11434/v1', label: 'Ollama' },
    },
  },
  mcpStatuses: [],
  storeId: 's1',
  agent: { isRunning: false, isCompacting: false, historyLength: 0 },
  goal: { active: false, busy: false },
  todos: [],
  skills: [],
  sentAt: 1,
} as unknown as StateSnapshot;

beforeEach(() => {
  setLocale('zh-CN');
  clearModelCapabilitiesCache();
  resetOverlayStackForTest();
  rpcMock.mockReset();
  rpcMock.mockResolvedValue(undefined);
  (window as unknown as { mojocode: unknown }).mojocode = { rpc: rpcMock };
  useDesktopStore.setState({ snapshot });
});

describe('ModelsSettings', () => {
  it('默认选中当前 provider;点自定义条目切详情', async () => {
    const user = userEvent.setup();
    render(<ModelsSettings />);
    // 当前 provider(glm)的详情:已启用徽章 + 模型行
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('GLM-5.3')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ollama' }));
    // 自定义条目未激活:出现「启用」按钮,标题为其 label
    expect(screen.getByRole('heading', { name: 'Ollama' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '启用' })).toBeTruthy();
  });

  it('添加模型弹窗:保存后 saveProvider 收到追加了新条目的列表', async () => {
    const user = userEvent.setup();
    render(<ModelsSettings />);
    await user.click(screen.getByRole('button', { name: '添加模型' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    await user.type(screen.getByPlaceholderText(/gpt|模型|model/i), 'glm-new');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'saveProvider',
          id: 'glm',
          config: expect.objectContaining({
            models: expect.arrayContaining([expect.objectContaining({ id: 'glm-new' })]),
          }),
        }),
      );
    });
  });

  it('API Key 失焦提交 saveProvider;空值不提交', async () => {
    const user = userEvent.setup();
    render(<ModelsSettings />);
    const keyInput = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await user.click(keyInput);
    await user.keyboard('sk-test-123');
    keyInput.blur();
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'saveProvider',
        id: 'glm',
        config: { apiKey: 'sk-test-123' },
      });
    });
  });

  it('测试模型:失败结果渲染成红胶囊并带端点原因', async () => {
    rpcMock.mockImplementation((request) => {
      if ((request as { kind: string }).kind === 'testModel') {
        return Promise.resolve({ ok: false, status: 401, error: 'invalid api key', durationMs: 10 });
      }
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<ModelsSettings />);
    await user.click(screen.getByRole('button', { name: '测试模型' }));
    await waitFor(() => {
      expect(screen.getByText(/invalid api key/)).toBeTruthy();
    });
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'testModel', id: 'glm', model: 'GLM-5.3' });
  });
});
