// @vitest-environment jsdom
/**
 * 设置页组件测试:三节导航切换、返回工作区、常规节的语言选择、模型设置节的
 * 供应商列表 / 模型行 / saveProvider RPC。window.mojocode 以桩替换;
 * desktopStore/uiStore 直接置态。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StateSnapshot } from '@core/protocol';
import { getLocale, setLocale } from '../../src/renderer/i18n/index.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { useUiStore } from '../../src/renderer/state/uiStore.js';
import { SettingsPage } from '../../src/renderer/components/SettingsPage.js';
import { clearModelCapabilitiesCache } from '../../src/renderer/utils/use-model-capabilities.js';

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
  rpcMock.mockReset();
  rpcMock.mockResolvedValue(undefined);
  (window as unknown as { mojocode: unknown }).mojocode = { rpc: rpcMock };
  useDesktopStore.setState({ snapshot });
  useUiStore.setState({ view: 'settings', settingsSection: 'general' });
});

describe('SettingsPage', () => {
  it('渲染三节导航;常规节含语言选择,切换后 locale 生效', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    // 「常规」同时出现在导航与正文标题,按钮角色限定到导航行。
    expect(screen.getByRole('button', { name: '常规' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '外观' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '模型设置' })).toBeTruthy();

    // 自定义选择器:触发器(aria-label=语言)→ 浮层条目。
    await user.click(screen.getByRole('button', { name: '语言' }));
    await user.click(screen.getByRole('option', { name: 'English' }));
    expect(getLocale()).toBe('en');
    // 复位,别把 locale 泄漏给其他用例。
    setLocale('zh-CN');
  });

  it('「返回工作区」切回聊天视图', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('返回工作区'));
    expect(useUiStore.getState().view).toBe('chat');
  });

  it('外观节:主题固定深色(禁用),字号输入可用', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('外观'));
    const theme = screen.getByRole('button', { name: '界面主题' }) as HTMLButtonElement;
    expect(theme.disabled).toBe(true);
    expect(theme.textContent).toContain('深色');
    expect(screen.getByText('界面字号')).toBeTruthy();
  });

  it('模型设置节:左列分组、当前供应商详情带「已启用」与模型行', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    expect(screen.getByText('预设供应商')).toBeTruthy();
    expect(screen.getByText('自定义供应商')).toBeTruthy();
    expect(screen.getByText('Ollama')).toBeTruthy();
    // 默认选中当前 provider(glm):徽章 + 已配置模型行 + 上下文徽章。
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('GLM-5.3')).toBeTruthy();
    expect(screen.getByText('1.0M')).toBeTruthy();
  });

  it('添加模型:弹窗保存后发 saveProvider RPC(整组替换 models,预填 200000 窗口)', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    await user.click(screen.getByText('添加模型'));
    // 居中弹窗:模型 ID 输入 + 上下文窗口预填 200000。
    const dialog = screen.getByRole('dialog', { name: '添加模型' });
    expect(dialog).toBeTruthy();
    expect(screen.getByDisplayValue('200000')).toBeTruthy();
    await user.type(screen.getByPlaceholderText('模型 ID（按端点要求填写）'), 'GLM-5.2');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'saveProvider',
        id: 'glm',
        config: {
          models: [
            { id: 'GLM-5.3', contextWindow: 1_000_000 },
            { id: 'GLM-5.2', contextWindow: 200_000 },
          ],
        },
      });
    });
    // 保存后弹窗关闭。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加模型' })).toBeNull());
  });

  it('弹窗「高级」的最大输出 Token 一并写入模型条目', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    await user.click(screen.getByText('添加模型'));
    await user.type(screen.getByPlaceholderText('模型 ID（按端点要求填写）'), 'GLM-5.2');
    await user.type(screen.getByPlaceholderText('留空使用服务端默认'), '8192');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'saveProvider',
        id: 'glm',
        config: {
          models: [
            { id: 'GLM-5.3', contextWindow: 1_000_000 },
            { id: 'GLM-5.2', contextWindow: 200_000, maxOutputTokens: 8192 },
          ],
        },
      });
    });
  });

  it('API Key 失焦提交 saveProvider(已配置时圆点占位)', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    const keyInput = screen.getByPlaceholderText('••••••••••••••••••••••••••••••••');
    await user.type(keyInput, 'sk-new-key');
    await user.tab();
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({ kind: 'saveProvider', id: 'glm', config: { apiKey: 'sk-new-key' } });
    });
  });

  it('弹窗思考模式:档位保存为 reasoning 字符串,自定义 JSON 保存为对象,坏 JSON 拦下', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));

    // 档位:选「高」→ 条目带 reasoning: 'high'。
    await user.click(screen.getByText('添加模型'));
    await user.type(screen.getByPlaceholderText('模型 ID（按端点要求填写）'), 'GLM-5.4');
    await user.click(screen.getByRole('button', { name: '思考模式' }));
    await user.click(screen.getByRole('option', { name: '高' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'saveProvider',
        id: 'glm',
        config: {
          models: [
            { id: 'GLM-5.3', contextWindow: 1_000_000 },
            { id: 'GLM-5.4', contextWindow: 200_000, reasoning: 'high' },
          ],
        },
      });
    });

    // 自定义:坏 JSON 标红不提交;修好后保存为对象。
    rpcMock.mockClear();
    rpcMock.mockResolvedValue(undefined);
    await user.click(screen.getByText('添加模型'));
    await user.type(screen.getByPlaceholderText('模型 ID（按端点要求填写）'), 'qwen3');
    await user.click(screen.getByRole('button', { name: '思考模式' }));
    await user.click(screen.getByRole('option', { name: '自定义参数…' }));
    const textarea = document.querySelector('.setting-textarea') as HTMLTextAreaElement;
    await user.click(textarea);
    await user.paste('not json {');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('需为合法的 JSON 对象。')).toBeTruthy();
    expect(rpcMock).not.toHaveBeenCalled();
    await user.clear(textarea);
    await user.paste('{"enable_thinking": true}');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'saveProvider',
        id: 'glm',
        config: {
          models: [
            { id: 'GLM-5.3', contextWindow: 1_000_000 },
            { id: 'qwen3', contextWindow: 200_000, reasoning: { enable_thinking: true } },
          ],
        },
      });
    });
  });

  it('弹窗联动 models.dev 能力:预填上下文、库标注、思考档位收窄并预选中档', async () => {
    const user = userEvent.setup();
    rpcMock.mockImplementation(async (request) => {
      if ((request as { kind: string }).kind === 'modelCapabilities') {
        return {
          contextWindow: 1_048_576,
          maxOutputTokens: 131_072,
          efforts: ['off', 'low', 'high', 'max'],
        };
      }
      return undefined;
    });
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    await user.click(screen.getByText('添加模型'));
    await user.type(screen.getByPlaceholderText('模型 ID（按端点要求填写）'), 'kimi-k3');
    // 防抖 350ms 后能力返回:默认 200000 被目录窗口替换,库标注行出现。
    await screen.findByDisplayValue('1048576', undefined, { timeout: 3000 });
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'modelCapabilities', id: 'glm', model: 'kimi-k3' });
    expect(screen.getByText(/models\.dev/)).toBeTruthy();
    // 档位收窄 + 预选中档:阶梯 low/high/max(off 不算强度)的中位是 high,
    // 触发器文案随之变成「高」。
    const trigger = screen.getByRole('button', { name: '思考模式' });
    await waitFor(() => expect(trigger.textContent).toContain('高'));
    await user.click(trigger);
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels).toContain('高');
    expect(labels).not.toContain('中');
    // 弹窗不列「自动」:与「默认(跟随会话档位)」语义重复。
    expect(labels).not.toContain('自动');
  });

  it('测试模型:成功显示绿色「连接成功」,失败显示红色原因', async () => {
    const user = userEvent.setup();
    rpcMock.mockImplementation(async (request) => {
      if ((request as { kind: string }).kind === 'testModel') {
        return { ok: true, status: 200, durationMs: 320 };
      }
      return undefined;
    });
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    await user.click(screen.getByTitle('测试模型'));
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'testModel', id: 'glm', model: 'GLM-5.3' });
    const ok = await screen.findByText('连接成功！');
    expect(ok.className).toContain('model-test-ok');

    // 失败分支:端点原因渲染成红色胶囊。
    rpcMock.mockImplementation(async (request) => {
      if ((request as { kind: string }).kind === 'testModel') {
        return { ok: false, status: 401, error: '401 Unauthorized — bad key', durationMs: 88 };
      }
      return undefined;
    });
    await user.click(screen.getByTitle('测试模型'));
    const fail = await screen.findByText('连接失败：401 Unauthorized — bad key');
    expect(fail.className).toContain('model-test-fail');
  });

  it('自定义供应商改名:铅笔 → 输入 → 失焦提交 label', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    await user.click(screen.getByText('Ollama'));
    await user.click(screen.getByTitle('重命名'));
    const input = screen.getByDisplayValue('Ollama');
    await user.clear(input);
    await user.type(input, 'Ollama 本地');
    await user.tab();
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'saveProvider',
        id: 'custom-ollama',
        config: { label: 'Ollama 本地' },
      });
    });
  });

  it('添加供应商表单:名称派生配置键,初始模型随首次 saveProvider 落盘', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(screen.getByText('模型设置'));
    await user.click(screen.getByRole('button', { name: '添加供应商' }));
    expect(screen.getByText('添加模型供应商')).toBeTruthy();
    await user.type(screen.getByPlaceholderText('如：智谱 GLM'), 'My LLM');
    await user.type(screen.getByPlaceholderText('https://api.example.com/v1'), 'https://llm.local/v1');
    await user.click(screen.getByText('添加模型'));
    await user.type(screen.getByPlaceholderText('模型 ID（按端点要求填写）'), 'my-model');
    await user.click(screen.getByRole('button', { name: '保存' }));
    // 表单区提交按钮与左列入口同名,限定到主按钮。
    const submit = screen
      .getAllByRole('button', { name: '添加供应商' })
      .find((b) => b.classList.contains('settings-btn-primary'))!;
    await user.click(submit);
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'saveProvider',
        id: 'my-llm',
        config: {
          label: 'My LLM',
          baseURL: 'https://llm.local/v1',
          models: [{ id: 'my-model', contextWindow: 200_000 }],
        },
      });
    });
  });
});
