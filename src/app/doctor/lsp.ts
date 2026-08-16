import { LspClient } from '../../lsp/client.js';
import { HANDSHAKE_GRACE_MS, resolveLspServers, type LspRuntimeStatus } from '../../lsp/manager.js';
import type { Config } from '../../config/schema.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';
import { findCommand } from './util.js';

/**
 * LSP 分节:列出合并后(内置 + 用户配置)的每个服务器。
 *
 * 三级递进:命令不在 PATH 上 → 内置 info / 用户显式配置 warn;在 PATH 上且
 * 会话给了运行状态(TUI 的 /doctor)→ 直接采信,不重复拉起;否则做一次真
 * 握手探测——拉起、initialize、随即杀掉(与 MCP 分节连一下就断同理)。
 * 只查存在性抓不住"装了个坏的":tsls 没有 workspace typescript@5 时命令
 * 在 PATH 上却根本起不来,那正是最需要 doctor 说话的情形。offline 跳过
 * 探测(拉起语言服务器可能触发它联网下载索引)。
 */
export async function lspChecks(
  config: Config,
  env: NodeJS.ProcessEnv,
  root: string,
  offline: boolean,
  known?: LspRuntimeStatus[],
): Promise<DoctorCheck[]> {
  if (!config.lsp.enabled) {
    return [
      { id: 'lspStatus', label: t('doctor.check.lsp'), level: 'info', detail: t('doctor.lspDisabled') },
    ];
  }
  const defs = resolveLspServers(config.lsp);
  if (defs.length === 0) {
    return [
      { id: 'lspStatus', label: t('doctor.check.lsp'), level: 'info', detail: t('doctor.lspNone') },
    ];
  }
  return Promise.all(
    defs.map(async (def): Promise<DoctorCheck> => {
      const found = await findCommand(def.command, env);
      const exts = def.extensions.join(' ');
      if (!found) {
        const userConfigured = config.lsp.servers[def.id]?.command !== undefined;
        return {
          id: `lsp:${def.id}`,
          label: def.id,
          level: userConfigured ? 'warn' : 'info',
          detail: `${def.command} · ${t('doctor.lspNotFound')}`,
          ...(userConfigured
            ? { hint: t('doctor.lspNotFoundHint', { command: def.command, id: def.id }) }
            : {}),
        };
      }

      // 会话内已经拉起过:直接采信运行状态。
      const status = known?.find((s) => s.id === def.id);
      if (status) {
        return status.state === 'ok'
          ? { id: `lsp:${def.id}`, label: def.id, level: 'ok', detail: `${found} · ${exts} · ${t('doctor.lspRunning')}` }
          : {
              id: `lsp:${def.id}`,
              label: def.id,
              level: 'warn',
              detail: `${found} · ${t('doctor.lspDead')}`,
              hint: t('doctor.lspProbeHint', { command: def.command }),
            };
      }

      // 会话内体检(known 非 undefined):这个服务器本会话还没被任何编辑触发过。
      // 绝不为体检去拉一个真语言服务器——那正是 MCP 分节刻意规避的"从运行中的
      // 会话再拉起一份重量级子进程"(rust-analyzer 会连带 cargo/go 子进程)。
      // 只报"装了、在 PATH 上";真握手留给 CLI 的 `mojocode doctor`。
      if (known !== undefined) {
        return {
          id: `lsp:${def.id}`,
          label: def.id,
          level: 'ok',
          detail: `${found} · ${exts} · ${t('doctor.lspInstalled')}`,
        };
      }

      if (offline) {
        return {
          id: `lsp:${def.id}`,
          label: def.id,
          level: 'ok',
          detail: `${found} · ${exts} · ${t('doctor.skippedOffline')}`,
        };
      }

      // 真握手:起得来才算数。探完立刻杀,不留子进程。用已解析的绝对路径
      // 拉起(findCommand 看的是传入的 env.PATH,spawn 走的是进程真实 PATH,
      // 两者可能不一致——报告说的和试的必须是同一个可执行文件)。
      const started = Date.now();
      const client = new LspClient({
        command: found,
        args: def.args,
        root,
        // 握手预算与会话同源(lsp.timeoutMs + 握手宽限),而非联网检查的 8s:
        // 用户为慢速的 rust-analyzer 调大 timeoutMs 时,这里不该还卡在硬编码
        // 上限,报"握手失败"而会话内其实健康。
        initTimeoutMs: config.lsp.timeoutMs + HANDSHAKE_GRACE_MS,
      });
      try {
        await client.ready();
        return {
          id: `lsp:${def.id}`,
          label: def.id,
          level: 'ok',
          detail: `${found} · ${exts} · ${t('doctor.lspHandshakeOk', { ms: `${Date.now() - started}ms` })}`,
        };
      } catch (err) {
        return {
          id: `lsp:${def.id}`,
          label: def.id,
          level: 'warn',
          detail: `${found} · ${t('doctor.lspHandshakeFailed', { message: (err as Error).message })}`,
          hint: t('doctor.lspProbeHint', { command: def.command }),
        };
      } finally {
        await client.dispose().catch(() => {});
      }
    }),
  );
}
