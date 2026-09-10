/**
 * LSP 诊断扩展:`write`/`edit` 写盘成功后拉起对应语言的服务器,把该文件的
 * 错误/警告(以及被这次改动波及的其他文件)附到工具结果上回喂给模型。
 *
 * 搬成扩展之后,工具侧完全不知道 LSP 的存在——`ToolContext.lsp` 与 files.ts
 * 里那两行 `ctx.lsp?.check(...)` 都没了,诊断改由 `tool_result` 钩子在结果
 * 喂回模型之前**改写**进去。这是钩子层设计时给 `tool_result` 举的原例。
 *
 * 机制仍住在 `src/lsp/`(客户端/协议/服务器注册表):那是一个库,`/doctor`
 * 的 LSP 分节也要用它,而 doctor 的 CLI 路径没有会话、也就没有扩展。本文件
 * 只持有**策略**:什么时候查、查哪份内容、结果怎么并进工具输出、服务器什么
 * 时候关掉。
 *
 * 一切失败静默降级(LspManager.check 自己吞错):诊断是锦上添花,绝不能让
 * 一次已经成功的写入变成工具报错。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { LspManager } from '../../lsp/manager.js';
import type { Extension, ExtensionAPI } from '../../core/extension.js';

/** `/doctor` 按这个 key 取会话内已拉起的服务器状态(见 publishRuntime)。 */
export const LSP_RUNTIME_KEY = 'lsp';

/** 只有这两个工具会落地文件内容;bash 造成的改动 LSP 看不见(与 changedFiles 同样的已知局限)。 */
const WRITE_TOOLS = new Set(['write', 'edit']);

export const lspExtension: Extension = {
  id: 'lsp',
  setup(api: ExtensionAPI): void {
    /**
     * 关掉就**什么都不注册**。enabled 是启动期决定的(运行中改不了,没有
     * 对应命令),所以这里可以直接退出。原来是在钩子内部才查 enabled,于是
     * 一个关了 LSP 的会话照样让 `hooks.has('tool_result')` 为真——
     * `Agent.hookedTools()` 每次开流都要重建整套包装工具(几十个对象展开
     * 加闭包),每个工具结果还要空跑一遍钩子链。doctor 那边没有区别:没建过
     * manager 与没注册过 runtime 一样都读到 undefined("这个会话没查过任何
     * 文件"),它照旧自己去探测。
     */
    if (!api.config.lsp.enabled) return;

    /** 惰性建:第一次真要查文件时才起服务器。 */
    let manager: LspManager | undefined;
    const managerFor = (): LspManager => (manager ??= new LspManager(api.root, api.config.lsp));

    // doctor 有则采信,不再为已经拉起来的服务器重复握手。没建过 manager 时
    // 返回 undefined(而不是空数组):那是"这个会话没查过任何文件",doctor
    // 该自己去探测,而不是当成"一个服务器都没起来"。
    api.publishRuntime(LSP_RUNTIME_KEY, () => manager?.statuses());

    api.on('tool_result', async ({ toolName, isError, output }) => {
      if (isError || !WRITE_TOOLS.has(toolName)) return undefined;
      const result = output as Record<string, unknown> | undefined;
      if (!result || typeof result !== 'object') return undefined;
      const relative = result['path'];
      // write 对"内容没变"提前返回,那次调用没有写盘,也就没有新东西可查。
      if (typeof relative !== 'string' || result['changed'] === false) return undefined;

      const lsp = managerFor();
      const absolute = path.resolve(api.root, relative);
      // 内容从盘上现读,而不是从工具入参里拼:write 的入参有 content,edit
      // 的没有(它给的是替换对),读盘对两者是同一条路,拿到的也正是刚落地
      // 的那份。读不到(竞态删除)就放弃这次诊断。
      let content: string;
      try {
        content = await fs.readFile(absolute, 'utf8');
      } catch {
        return undefined;
      }

      const diagnostics = await lsp.check(absolute, content);
      if (!diagnostics) return undefined;
      // 干净时**不加字段**:结果的 JSON 要和没装 LSP 时一字不差,否则模型
      // 会把一个空诊断对象读成"查过了、有话说"。
      return { output: { ...result, diagnostics } };
    });

    api.on('session_shutdown', async () => {
      const current = manager;
      manager = undefined;
      await current?.dispose();
    });
  },
};
