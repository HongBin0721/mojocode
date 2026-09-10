/**
 * 一方扩展:静态打包进核心,bootstrap 按此顺序逐个 setup,永远排在磁盘扩展
 * (`loader.ts` 的三层发现)之前。
 */

import type { Extension } from '../core/extension.js';
import { goalExtension } from './goal/index.js';
import { lspExtension } from './lsp/index.js';
import { mcpExtension } from './mcp/index.js';
import { reviewExtension } from './review/index.js';
import { todoExtension } from './todo/index.js';
import { webExtension } from './web/index.js';

export const BUILTIN_EXTENSIONS: readonly Extension[] = [
  goalExtension,
  lspExtension,
  mcpExtension,
  reviewExtension,
  todoExtension,
  webExtension,
];
