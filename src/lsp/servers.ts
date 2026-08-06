/**
 * 内置 LSP 服务器注册表。
 *
 * 只登记"装了就能用"的主流服务器,不做任何自动下载——找不到命令就静默
 * 跳过(manager 负责),诊断回喂是锦上添花,绝不能因为环境缺东西而打断
 * write/edit 本身。用户可在 config 的 `lsp.servers` 里覆盖内置条目或添加
 * 自定义条目(见 schema.ts 的 lspServerConfigSchema)。
 */

export interface LspServerDef {
  id: string;
  command: string;
  args: string[];
  /** 该服务器接管的文件扩展名,含点(".ts")。 */
  extensions: string[];
  /**
   * 收到**空**诊断批次后再等多久,看有没有后续批次(毫秒)。
   *
   * tsls 实测把语法/语义合并成一批发出,短宽限只是保险;rust-analyzer
   * (cargo check 流式出结果)与 gopls(按包检查)先发空批次占位、真正的
   * 错误明显滞后,宽限必须给足,否则"有错"会被报成"干净"。这些数字是
   * 启发值,config 的 lsp.servers.<id>.graceMs 可逐服务器覆盖。
   */
  emptyGraceMs: number;
}

const DEFAULT_EMPTY_GRACE_MS = 400;

export const BUILTIN_LSP_SERVERS: readonly LspServerDef[] = [
  {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    emptyGraceMs: DEFAULT_EMPTY_GRACE_MS,
  },
  {
    id: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    emptyGraceMs: DEFAULT_EMPTY_GRACE_MS,
  },
  {
    id: 'gopls',
    command: 'gopls',
    args: [],
    extensions: ['.go'],
    emptyGraceMs: 1000,
  },
  {
    id: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    emptyGraceMs: 1500,
  },
];

export { DEFAULT_EMPTY_GRACE_MS };

/** didOpen 需要的 languageId。没有专名的扩展名退化为去点的扩展名本身。 */
const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

export function languageIdFor(ext: string): string {
  return LANGUAGE_IDS[ext] ?? (ext.startsWith('.') ? ext.slice(1) : ext) ?? 'plaintext';
}
