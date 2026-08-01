import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { ResolvedProvider } from '../config/load.js';

/**
 * Builds an AI SDK language model for a resolved provider.
 *
 * DeepSeek gets its dedicated package so `reasoning_content` is mapped into
 * proper reasoning parts. Everything else goes through the generic
 * OpenAI-compatible provider with the baseURL used verbatim (see the note in
 * providers.ts about GLM's `/api/paas/v4` path).
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
 * Hits `GET {baseURL}/models`. Used by `kdg models` so users can discover the
 * ids their key actually has, instead of guessing at fast-moving names.
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
