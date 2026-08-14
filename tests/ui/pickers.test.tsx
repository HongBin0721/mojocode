import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelPicker } from '../../src/ui/ModelPicker.js';
import { ProviderPicker } from '../../src/ui/ProviderPicker.js';
import { AuthWizard } from '../../src/ui/AuthWizard.js';
import { renderUi } from '../support/otui.js';
import { setLocale } from '../../src/i18n/index.js';

beforeEach(() => {
  setLocale('en');
});

let dir = '';

afterEach(async () => {
  // 只有 AuthWizard 的用例会建临时目录;其余用例 dir 为空,rm 会抛 TypeError。
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

/** /models 探针的假 fetch:返回固定模型列表。 */
function fakeModelsFetch(ids: string[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as typeof fetch;
}

describe('ModelPicker', () => {
  it('lists models with the current marker; enter picks, esc cancels', async () => {
    const picked: string[] = [];
    let cancelled = false;
    const ui = await renderUi(
      () => (
        <ModelPicker
          title="Models on Kimi"
          models={[
            { id: 'kimi-k3', note: 'context 1.0M' },
            { id: 'kimi-k2.6' },
          ]}
          current="kimi-k2.6"
          onPick={(id) => picked.push(id)}
          onCancel={() => (cancelled = true)}
        />
      ),
      { width: 60, height: 16 },
    );
    const frame = ui.frame();
    expect(frame).toContain('Models on Kimi');
    expect(frame).toContain('kimi-k3');
    // 光标初值落在当前模型上,带 ✓ current 标记。
    expect(frame).toContain('kimi-k2.6 ✓ current');
    expect(frame).toContain('context 1.0M');

    await ui.press('return');
    expect(picked).toEqual(['kimi-k2.6']);

    await ui.press('escape');
    expect(cancelled).toBe(true);
    await ui.destroy();
  });

  it('manual entry row: select it, type an id, enter picks the typed id', async () => {
    const picked: string[] = [];
    const ui = await renderUi(
      () => (
        <ModelPicker
          title="Models"
          models={[{ id: 'glm-5.2' }]}
          allowManual={true}
          onPick={(id) => picked.push(id)}
          onCancel={() => {}}
        />
      ),
      { width: 60, height: 16 },
    );
    expect(ui.frame()).toContain('Type a model id');

    // 下移到手动输入行并回车,进入内嵌输入态。
    await ui.press('down');
    await ui.press('return');
    await ui.type('glm-5.3-air');
    await ui.press('return');
    expect(picked).toEqual(['glm-5.3-air']);
    await ui.destroy();
  });

  it('windows long lists with more-above/below counters', async () => {
    const models = Array.from({ length: 12 }, (_, i) => ({ id: `model-${i + 1}` }));
    const ui = await renderUi(
      () => (
        <ModelPicker title="Models" models={models} onPick={() => {}} onCancel={() => {}} />
      ),
      { width: 60, height: 18 },
    );
    // 12 行 > 窗口 8:首屏显示 1..8 与 moreBelow 计数。
    expect(ui.frame()).toContain('model-1');
    expect(ui.frame()).toContain('model-8');
    expect(ui.frame()).not.toContain('model-9');
    expect(ui.frame()).toContain('4 more below');
    await ui.destroy();
  });
});

describe('ProviderPicker', () => {
  const rows = [
    { id: 'kimi', label: 'Kimi', hasKey: true, current: true },
    { id: 'glm', label: 'GLM', hasKey: false, current: false, keyUrl: 'https://example.com/keys' },
  ];

  it('picking a keyed provider switches directly', async () => {
    const switched: Array<[string, string | undefined]> = [];
    const ui = await renderUi(
      () => (
        <ProviderPicker
          rows={rows}
          probe={async () => 1}
          onSwitch={(id, apiKey) => switched.push([id, apiKey])}
          onCancel={() => {}}
        />
      ),
      { width: 60, height: 16 },
    );
    const frame = ui.frame();
    expect(frame).toContain('kimi');
    expect(frame).toContain('✓ current');
    expect(frame).toContain('no key');

    await ui.press('return');
    expect(switched).toEqual([['kimi', undefined]]);
    await ui.destroy();
  });

  it('keyless provider: inline key entry → validating → switch with the key', async () => {
    const switched: Array<[string, string | undefined]> = [];
    const probe = vi.fn(async (_id: string, key: string) => {
      expect(key).toBe('glmlive');
      return 7;
    });
    const ui = await renderUi(
      () => (
        <ProviderPicker rows={rows} probe={probe} onSwitch={(id, apiKey) => switched.push([id, apiKey])} onCancel={() => {}} />
      ),
      { width: 60, height: 16 },
    );
    await ui.press('down');
    await ui.press('return');
    expect(ui.frame()).toContain('Paste the API key for GLM');
    expect(ui.frame()).toContain('example.com/keys');

    await ui.type('glmlive');
    await ui.press('return');
    // 探针成功后由组件直接回调切换,key 一并送出。
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    expect(probe).toHaveBeenCalledOnce();
    expect(switched).toEqual([['glm', 'glmlive']]);
    await ui.destroy();
  });

  it('esc during validation aborts the probe and returns to key entry', async () => {
    let seenSignal: AbortSignal | undefined;
    // 挂死的端点:探针永不落定,只有 esc 的 abort 能解围。
    const probe = vi.fn((_id: string, _key: string, signal?: AbortSignal) => {
      seenSignal = signal;
      return new Promise<number>(() => {});
    });
    const ui = await renderUi(
      () => <ProviderPicker rows={rows} probe={probe} onSwitch={() => {}} onCancel={() => {}} />,
      { width: 60, height: 16 },
    );
    await ui.press('down');
    await ui.press('return');
    await ui.type('slowkey');
    await ui.press('return');
    expect(ui.frame()).toContain('Validating');

    await ui.press('escape');
    expect(seenSignal?.aborted).toBe(true);
    // 回到输入态,刚输的 key 草稿保留(7 个字符)。
    expect(ui.frame()).toContain('Paste the API key for GLM');
    expect(ui.frame()).toContain('(7)');
    await ui.destroy();
  });

  it('validation failure shows the error; s switches with the unverified key', async () => {
    const switched: Array<[string, string | undefined]> = [];
    const probe = vi.fn(async () => {
      throw new Error('401 unauthorized');
    });
    const ui = await renderUi(
      () => (
        <ProviderPicker rows={rows} probe={probe} onSwitch={(id, apiKey) => switched.push([id, apiKey])} onCancel={() => {}} />
      ),
      { width: 60, height: 16 },
    );
    await ui.press('down');
    await ui.press('return');
    await ui.type('bad');
    await ui.press('return');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    expect(ui.frame()).toContain('Validation failed');
    expect(ui.frame()).toContain('401 unauthorized');

    await ui.type('s');
    expect(switched).toEqual([['glm', 'bad']]);
    await ui.destroy();
  });
});

describe('AuthWizard', () => {
  beforeEach(() => {
    dir = '';
  });

  async function tmpFile(): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-wizard-'));
    return path.join(dir, 'config.json');
  }

  async function readConfig(file: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  }

  it('builtin flow: key → validation → model picker → pick writes key+model+default', async () => {
    const file = await tmpFile();
    const ui = await renderUi(
      () => <AuthWizard saveFile={file} fetchImpl={fakeModelsFetch(['kimi-k3', 'kimi-k2.6'])} />,
      { width: 80, height: 24 },
    );
    // 首屏:内置列表 + "其他"入口。
    expect(ui.frame()).toContain('API key setup');
    expect(ui.frame()).toContain('kimi');
    expect(ui.frame()).toContain('custom OpenAI-compatible endpoint');

    await ui.press('return'); // 选中第一项 kimi
    expect(ui.frame()).toContain('Paste the API key for');
    await ui.type('moon-live-key');
    await ui.press('return');
    // 验证成功 → 直接进模型选择器(不再有"设为默认?/再配一个?"两问)。
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    const frame = ui.frame();
    expect(frame).toContain('2 models available');
    expect(frame).toContain('Pick a model for kimi');
    expect(frame).toContain('kimi-k3');

    await ui.press('return'); // 光标初值在预设默认模型 kimi-k2.6 上
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    // 回到选择屏,顶部回显已保存的默认组合,列表项打上 ✓。
    const done = ui.frame();
    expect(done).toContain('set as default');
    expect(done).toContain('✓ configured');

    const config = await readConfig(file);
    expect(config).toEqual({
      provider: 'kimi',
      providers: {
        kimi: expect.objectContaining({ apiKey: 'moon-live-key', model: 'kimi-k2.6' }),
      },
    });
    await ui.destroy();
  });

  it('custom flow: other → baseURL → empty key (local) → model from live list', async () => {
    const file = await tmpFile();
    const ui = await renderUi(
      () => <AuthWizard saveFile={file} fetchImpl={fakeModelsFetch(['qwen3-coder'])} />,
      { width: 80, height: 24 },
    );
    // 光标移到末尾的"其他"行(7 个内置预设之后,共 8 行)。
    for (let i = 0; i < 7; i++) await ui.press('down');
    await ui.press('return');
    expect(ui.frame()).toContain('Base URL');

    // 非法输入有行内提示,合法 URL 进入(可留空的)key 输入。
    await ui.type('not a url');
    await ui.press('return');
    expect(ui.frame()).toContain('valid http(s) URL');
    await ui.press('backspace');
    for (const _ of 'not a url') await ui.press('backspace');
    await ui.paste('http://127.0.0.1:11434/v1');
    await ui.press('return');
    expect(ui.frame()).toContain('Paste the API key for 127.0.0.1');
    expect(ui.frame()).toContain('empty for local endpoints');

    await ui.press('return'); // 空 key 直接验证
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    expect(ui.frame()).toContain('Pick a model for custom-127-0-0-1');

    await ui.press('return');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();

    const config = await readConfig(file);
    expect(config).toEqual({
      provider: 'custom-127-0-0-1',
      providers: {
        'custom-127-0-0-1': {
          baseURL: 'http://127.0.0.1:11434/v1',
          model: 'qwen3-coder',
        },
      },
    });
    await ui.destroy();
  });

  it('custom flow: esc at the model picker leaves the config untouched', async () => {
    const file = await tmpFile();
    const ui = await renderUi(
      () => <AuthWizard saveFile={file} fetchImpl={fakeModelsFetch(['m1'])} />,
      { width: 80, height: 24 },
    );
    for (let i = 0; i < 7; i++) await ui.press('down');
    await ui.press('return');
    await ui.paste('http://127.0.0.1:11434/v1');
    await ui.press('return');
    await ui.press('return'); // 空 key 直接验证
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    expect(ui.frame()).toContain('Pick a model for custom-127-0-0-1');

    await ui.press('escape');
    expect(ui.frame()).toContain('API key setup');
    // 一个字段都不落盘:提前写 key 会留下有 baseURL 没 model 的残缺条目,
    // 之后在厂商选择器里一选就撞 "No model" 报错。
    await expect(fs.access(file)).rejects.toThrow();
    await ui.destroy();
  });

  it('custom flow: esc from key entry restores the URL draft', async () => {
    const file = await tmpFile();
    const ui = await renderUi(
      () => <AuthWizard saveFile={file} fetchImpl={fakeModelsFetch(['m1'])} />,
      { width: 80, height: 24 },
    );
    for (let i = 0; i < 7; i++) await ui.press('down');
    await ui.press('return');
    await ui.paste('http://127.0.0.1:11434/v1');
    await ui.press('return');
    expect(ui.frame()).toContain('Paste the API key for 127.0.0.1');

    await ui.type('sk-ab');
    await ui.press('escape'); // 回去改 URL:半截 key 不能顶掉 URL 草稿
    expect(ui.frame()).toContain('Base URL');
    expect(ui.frame()).toContain('http://127.0.0.1:11434/v1');
    expect(ui.frame()).not.toContain('sk-ab');
    await ui.destroy();
  });

  it('failed validation: s proceeds unverified; picking a model saves key+model', async () => {
    const file = await tmpFile();
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const ui = await renderUi(
      () => <AuthWizard saveFile={file} fetchImpl={fetchImpl} />,
      { width: 100, height: 24 },
    );
    await ui.press('down');
    await ui.press('down');
    await ui.press('down'); // deepseek(列表第 4 项)
    await ui.press('return');
    await ui.type('rejected');
    await ui.press('return');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    expect(ui.frame()).toContain('Validation failed');

    await ui.type('s');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    // 未验证保存后仍要选完模型:预设已知模型作选项,手动输入行兜底。
    const frame = ui.frame();
    expect(frame).toContain('not verified');
    expect(frame).toContain('Pick a model for deepseek');
    expect(frame).toContain('deepseek-v4-flash');

    await ui.press('return');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ui.tick();
    const config = await readConfig(file);
    expect(config).toEqual({
      provider: 'deepseek',
      providers: {
        deepseek: expect.objectContaining({ apiKey: 'rejected', model: 'deepseek-v4-flash' }),
      },
    });
    await ui.destroy();
  });
});
