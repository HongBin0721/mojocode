import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { ResolvedProvider } from '../config/load.js';

/**
 * 为解析后的 provider 构建 AI SDK 语言模型。
 *
 * DeepSeek 使用其专用包,这样 `reasoning_content` 能被映射为正规的
 * reasoning 部分。其余都走通用的 OpenAI 兼容 provider,baseURL 原样使用
 * (参见 providers.ts 中关于 GLM `/api/paas/v4` 路径的说明)。
 */
export function createModel(provider: ResolvedProvider): LanguageModel {
  if (provider.sdk === 'deepseek') {
    const deepseek = createDeepSeek({
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      headers: provider.headers,
    });
    return deepseek(provider.model);
  }

  const compatible = createOpenAICompatible({
    name: provider.id,
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    headers: provider.headers,
  });
  return compatible(provider.model);
}

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

/**
 * 请求 `GET {baseURL}/models`。供 `kdg models` 使用,让用户能查到自己的
 * key 实际拥有的模型 id,而不是去猜那些变化频繁的名字。
 */
export async function listModels(provider: ResolvedProvider): Promise<ModelInfo[]> {
  const url = `${provider.baseURL.replace(/\/$/, '')}/models`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GET ${url} failed: ${res.status} ${res.statusText}${body ? `\n${body.slice(0, 500)}` : ''}`,
    );
  }

  const json = (await res.json()) as { data?: Array<{ id?: string; owned_by?: string }> };
  if (!Array.isArray(json.data)) {
    throw new Error(`GET ${url} returned an unexpected shape (no "data" array).`);
  }

  return json.data
    .filter((m): m is { id: string; owned_by?: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, ownedBy: m.owned_by }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
