import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolScope } from '../src/core/extension.js';
import type { Config } from '../src/config/schema.js';
import { recordingExtensionApi } from './support/extension-api.js';

/**
 * web 扩展的**接入面**(工具本身在 web-tools.test.ts 里测):按后端有没有 key
 * 决定注册几个工具,并把「你有哪些联网工具」如实写进系统提示词。
 *
 * 这条提示词是这次搬家的要点:提示词与实际注册的工具**必须一致**——说了
 * 不存在的工具,模型就会去调它。核心猜不了(注册在扩展手上),所以由扩展
 * 自己经 before_agent_start 追加。
 */

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));
vi.mock('../src/config/search.js', () => ({ resolveSearchBackend: mockResolve }));

import { webExtension } from '../src/extensions/web/index.js';

const MAIN: ToolScope = { subagent: false };

function makeHost() {
  const host = recordingExtensionApi({
    id: 'web',
    config: { search: { backend: 'off' } } as unknown as Config,
  });
  webExtension.setup(host.api);
  const prompt = async () =>
    (await host.hooks.beforeAgentStart({ systemPrompt: 'BASE', subagent: false })).systemPrompt;
  return { ...host, prompt };
}

beforeEach(() => {
  mockResolve.mockReset();
});

describe('web 扩展', () => {
  it('有搜索后端时注册两个工具,提示词如实点名两个', async () => {
    mockResolve.mockReturnValue({ id: 'glm', label: 'GLM', endpoint: 'x', apiKey: 'k', auth: 'bearer' });
    const host = makeHost();

    expect([...host.tools.keys()].sort()).toEqual(['web_fetch', 'web_search']);
    const prompt = await host.prompt();
    expect(prompt).toContain('BASE');
    expect(prompt).toContain('web_search and web_fetch');
    expect(prompt).toContain('public web content');
  });

  it('后端缺 key 时只注册 web_fetch,提示词也只说 web_fetch', async () => {
    mockResolve.mockReturnValue(undefined);
    const host = makeHost();

    expect([...host.tools.keys()]).toEqual(['web_fetch']);
    const prompt = await host.prompt();
    expect(prompt).toContain('web_fetch');
    expect(prompt).not.toContain('web_search');
  });

  it('联网调研是只读的:explore 子 agent 照给', () => {
    mockResolve.mockReturnValue(undefined);
    const host = makeHost();
    const factory = host.tools.get('web_fetch')!;
    expect(factory(MAIN)).toBeDefined();
    expect(factory({ subagent: true, mode: 'explore' })).toBeDefined();
    expect(factory({ subagent: true, mode: 'general' })).toBeDefined();
  });

});
