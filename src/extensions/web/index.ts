/**
 * web 扩展:`web_fetch`(恒有)与 `web_search`(解析出搜索后端时才有)。
 *
 * 这是第一个用上 **`before_agent_start`** 的扩展:系统提示词里那句「你有哪些
 * 联网工具、每个新域名都要用户批准」由它自己追加。核心的 `buildSystemPrompt`
 * 因此不再有 `webSearch` 标志——**提示词必须与实际注册的工具一致**,说了不
 * 存在的工具模型就会去调它,而"注册了哪些工具"这件事在扩展手上,让核心猜
 * 迟早会猜错(bootstrap 里那个 `'web_search' in tools` 的一次性快照就是在
 * 扩展注册之前算的,已经错了)。
 *
 * 联网没有任何授权或域名围栏——Pi 式,边界由运行环境划。
 */

import { resolveSearchBackend } from '../../config/search.js';
import type { Extension, ExtensionAPI } from '../../core/extension.js';
import { createWebTools } from './tools.js';

export const webExtension: Extension = {
  id: 'web',
  setup(api: ExtensionAPI): void {
    // 惰性 getter:config 会被 switchProvider 就地改,现取现算才拿到当下的值
    // (原 ToolContext.searchBackend 的语义照搬)。
    const searchBackend = () => resolveSearchBackend(api.config, process.env);
    const tools = createWebTools({ searchBackend });

    // 联网调研是只读的,explore 子 agent 照给(原 EXPLORE_TOOLS 白名单里就有
    // 这两个);主 agent 与 general 子 agent 自然也给。
    for (const [name, tool] of Object.entries(tools)) api.registerTool(name, () => tool);

    const hasSearch = 'web_search' in tools;
    api.on('before_agent_start', ({ systemPrompt }) => ({
      systemPrompt: `${systemPrompt}\n\n## Web tools\n\n${
        hasSearch ? 'web_search and web_fetch' : 'web_fetch'
      } are available for reading public web content.`,
    }));
  },
};
