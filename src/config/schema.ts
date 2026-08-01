import { z } from 'zod';

export const permissionModeSchema = z.enum(['readonly', 'ask', 'acceptEdits', 'yolo']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/** A user-declared provider entry. Built-in ids only need the fields they override. */
export const providerConfigSchema = z.object({
  baseURL: z.url().optional(),
  apiKey: z.string().optional(),
  /** Env var name to read the key from, overriding the preset's list. */
  apiKeyEnv: z.string().optional(),
  model: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  contextWindow: z.number().int().positive().optional(),
  parallelToolCalls: z.boolean().optional(),
  label: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const mcpServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
  }),
]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const permissionRulesSchema = z.object({
  /** Bash command prefixes that never prompt, e.g. "git status", "npm test". */
  allowBash: z.array(z.string()).default([]),
  /** Bash command prefixes that are always refused, on top of the built-in denylist. */
  denyBash: z.array(z.string()).default([]),
  /** Globs (relative to workspace root) that may be written without prompting. */
  allowWrite: z.array(z.string()).default([]),
  /** Globs that may never be read or written. */
  denyPath: z.array(z.string()).default([]),
});
export type PermissionRules = z.infer<typeof permissionRulesSchema>;

export const configSchema = z.object({
  /** Active provider id — a built-in preset or a key of `providers`. */
  provider: z.string().default('deepseek'),
  /** Overrides the active provider's default model. */
  model: z.string().optional(),
  providers: z.record(z.string(), providerConfigSchema).default({}),
  permissionMode: permissionModeSchema.default('ask'),
  permissions: permissionRulesSchema.default({
    allowBash: [],
    denyBash: [],
    allowWrite: [],
    denyPath: [],
  }),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  /** Hard cap on agent loop steps per user turn — the anti-runaway backstop. */
  maxSteps: z.number().int().positive().default(50),
  temperature: z.number().min(0).max(2).optional(),
  /** Compact the history once input tokens exceed this fraction of the window. */
  compactThreshold: z.number().min(0.1).max(0.95).default(0.8),
  /** Force a context window, overriding the provider preset. Useful for testing compaction. */
  maxContext: z.number().int().positive().optional(),
  /** Extra instructions appended to the system prompt. */
  systemPromptAppend: z.string().optional(),
  /** UI language. `auto` follows KDG_LANG / LANG. */
  language: z.enum(['auto', 'en', 'zh-CN']).default('auto'),
});

export type Config = z.infer<typeof configSchema>;

/** Same shape as `Config` but every field optional — what a config file may contain. */
export const partialConfigSchema = configSchema.partial();
export type PartialConfig = z.input<typeof partialConfigSchema>;
