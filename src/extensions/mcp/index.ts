/**
 * MCP 扩展:连接配置里的 MCP server,把它们的工具桥成模型可调用的工具,
 * 并提供 `/mcp` 查看连接状态。
 *
 * 搬成扩展之后,核心(bootstrap / Agent / Session / 协议)完全不知道 MCP:
 * `Session.mcpStatuses`、`mcpStatusChanged`、`StateSnapshot.mcpStatuses`、
 * `AgentOptions.beforeTurn` 一并退役,连 `--no-mcp` 都变成了「不加载这个
 * 扩展」。留在核心的只有 `src/mcp/client.ts`(协议客户端)——doctor 的 MCP
 * 分节在没有会话的 `mojocode doctor` 路径上也要连一遍,与 LSP 同样的分工。
 *
 * **连接是非阻塞的**,这是原来 bootstrap 里最要紧的一段不变量,原样搬来:
 * 每个 server 最坏 15s 超时,叠在启动路径上会让 GUI/TUI 拉起 sidecar 的握手
 * 一起陪等。所以 setup 里只发起连接,不 await;连上之后把工具**注册进去**
 * (registerTool 对主 agent 是就地改键,下一次开流生效)。首轮不抢跑:
 * `turn_start` 钩子在真正开轮前 await 连接收尾,轮次语义与旧的阻塞式一致
 * ——等待只是从「启动时」挪到「真要开轮时」。
 */

import { connectMcpServers, type McpConnection, type McpStatus } from '../../mcp/client.js';
import { bridgeMcpTools } from './bridge.js';
import { t } from '../../i18n/index.js';
import { glyphs } from '../../ui/theme.js';
import type { Extension, ExtensionAPI } from '../../core/extension.js';

/** `/doctor` 按这个 key 取会话内已连上的 server 状态(见 publishRuntime)。 */
export const MCP_RUNTIME_KEY = 'mcp';

export const mcpExtension: Extension = {
  id: 'mcp',
  setup(api: ExtensionAPI): void {
    const connections: McpConnection[] = [];
    const statuses: McpStatus[] = [];
    /** 会话已关。连接落地时若已置位,直接关掉——绝不留 stdio 孤儿进程。 */
    let disposed = false;

    const connecting = connectMcpServers(api.config.mcpServers, (status) => {
      statuses.push(status);
      // 失败即刻上总线:连接非阻塞之后,状态是在**握手之后**才落地的,
      // 调用方写 stderr 已经晚了(TUI 下直接糊进全屏画面)。bus 是 TUI 与
      // headless 都收得到的通道。
      if (!status.connected) {
        api.notify('warn', t('cli.mcpFailed', { name: status.name, error: status.error ?? '?' }));
      }
    });

    /**
     * 连接收尾。**永不 reject**:`turn_start` 钩子 await 它,拒绝会把之后
     * 每一轮都拖下水(钩子失败虽然是 fail-open,但没必要把错误当常态)。
     */
    const ready = connecting
      .then(({ connections: connected }) => {
        if (disposed) {
          for (const connection of connected) void connection.close(); // close 内部已吞错
          return;
        }
        connections.push(...connected);
        for (const bridged of bridgeMcpTools(connected)) {
          // 工具本身与作用域无关,**建一次**:工厂每次子 agent 生成都会被
          // 调用(subagentTools 现建),逐次重建等于每次 spawn 扔掉 N 个
          // tool()+jsonSchema() 对象。scope 只决定给不给。
          const instance = bridged.create();
          // explore 子 agent 不给:MCP 工具不透明,可能有副作用,而 explore
          // 的约定就是纯只读调研。
          api.registerTool(bridged.name, (scope) => (scope.mode === 'explore' ? undefined : instance));
        }
      })
      .catch(() => {});

    // doctor 有则采信,不再自己连一遍(每个 stdio server 会多一个子进程)。
    // 半满的数组不能当权威:没落地的 server 会被报成 fail · "?",还会把
    // 退出码带成 1——所以给的是「连接收尾后的那一份」,doctor 侧 await 它。
    api.publishRuntime(MCP_RUNTIME_KEY, () => ready.then(() => statuses));

    // 真要开轮了才等连接收尾(通常早已 resolve):首轮的工具集因此与旧的
    // 阻塞式启动一致。turn_start 在 stream 之前被 await,见 loop.ts 的 runTurn。
    api.on('turn_start', () => ready);

    api.on('session_shutdown', async () => {
      // 置位在前 + 等连接落定:关会话时连接可能还在路上(每 server 最坏
      // 15s),不等的话 connections 还是空的,那批 stdio 子进程就成了孤儿
      // ——上面的 disposed 分支负责关掉它们,但它得先跑完。
      // 工具不必注销:dispose 只在进程收尾时跑(`/new`、`/resume`、`/fork`
      // 走的是 session_start),那张工具表马上就跟着进程一起没了。真正要做
      // 的只有关子进程。
      disposed = true;
      await ready;
      await Promise.all(connections.map((c) => c.close()));
    });

    api.registerCommand('mcp', {
      description: t('cmd.mcp'),
      handler: async () => {
        // 连接还在路上时先等一等:半满的列表看起来就像「有几个没连上」。
        await ready;
        api.notify(
          'info',
          statuses.length === 0
            ? t('notice.mcpNone')
            : statuses
                .map((s) =>
                  s.connected
                    ? `  ${glyphs.done} ${s.name} — ${t('notice.mcpTools', { n: s.toolCount })}`
                    : `  ${glyphs.failed} ${s.name} — ${s.error ?? '?'}`,
                )
                .join('\n'),
        );
      },
    });
  },
};
