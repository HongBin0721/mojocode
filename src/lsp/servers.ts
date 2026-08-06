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
}

export const BUILTIN_LSP_SERVERS: readonly LspServerDef[] = [
  {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    id: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
  },
  {
    id: 'gopls',
    command: 'gopls',
    args: [],
    extensions: ['.go'],
  },
  {
    id: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
  },
];

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
