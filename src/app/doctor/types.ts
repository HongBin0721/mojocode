import type { LspRuntimeStatus } from '../../lsp/manager.js';
import type { McpStatus } from '../../mcp/client.js';
import type { Config } from '../../config/schema.js';

/** 每一项检查的结论。`info` 是纯陈述,不计入通过/告警/失败的汇总。 */
export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  /** 稳定标识:--json 的消费方和测试认它,不认本地化后的 label。 */
  id: string;
  label: string;
  level: CheckLevel;
  detail?: string;
  /** 修复建议,只在 warn/fail 时给。 */
  hint?: string;
}

export interface DoctorSection {
  id: string;
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  version: string;
  sections: DoctorSection[];
  counts: { ok: number; warn: number; fail: number };
  /** 没有 fail 即为健康;warn 不影响可用性。 */
  healthy: boolean;
}

export interface DoctorInput {
  root: string;
  /** 分层加载后的配置;加载失败时给 undefined,并在 configError 里说明。 */
  config?: Config;
  configError?: string;
  /** 实际生效的配置文件路径,按优先级排序。 */
  sources: string[];
  /** 加载期提示(旧版 permissionMode 的一次性转换等)。 */
  warnings: string[];
  env?: NodeJS.ProcessEnv;
  /** 跳过全部联网检查(端点探测、版本比对、MCP 连接)。 */
  offline?: boolean;
  /** 覆盖会话目录(测试用)。 */
  sessionsDir?: string;
  /** 覆盖配置文件路径(测试用);不传则用 ~/.mojocode 与 <root>/.mojocode。 */
  globalConfigFile?: string;
  projectConfigFile?: string;
  fetchImpl?: typeof fetch;
  version?: string;
  /**
   * 已知的 MCP 连接状态。给了就直接采信,不再自己连一遍——TUI 里 server
   * 已经连着,再连一次等于把每个 stdio server 的子进程又拉起一份。
   */
  mcpStatuses?: McpStatus[];
  /** 会话内已拉起的 LSP 服务器状态,同上:有则采信,没有的才做握手探测。 */
  lspStatuses?: LspRuntimeStatus[];
}

export interface DoctorOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  offline?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * 会话当前生效的配置。TUI 传它,好让报告反映 /approvals、/models 这些
   * 运行期改动;不传则以磁盘上的分层结果为准(CLI 的情形)。
   */
  config?: Config;
  mcpStatuses?: McpStatus[];
  lspStatuses?: LspRuntimeStatus[];
}
