import { tool } from 'ai';
import { z } from 'zod';
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { resolveInsideWorkspace } from '../permissions/sandbox.js';
import { truncate, type ToolContext } from './context.js';

/** 搜索与文件列举共用的忽略清单(fast-glob 不解析 .gitignore,以此代替)。 */
export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/target/**',
];

const MAX_MATCHES = 300;

let ripgrepAvailable: boolean | undefined;

/** 在真实仓库上 ripgrep 快 10-100 倍;JS 回退实现保证可移植性。 */
async function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== undefined) return ripgrepAvailable;
  try {
    await execa('rg', ['--version'], { timeout: 3000 });
    ripgrepAvailable = true;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

interface Match {
  file: string;
  line: number;
  text: string;
}

async function grepWithRipgrep(
  pattern: string,
  root: string,
  include: string | undefined,
  caseInsensitive: boolean,
): Promise<Match[]> {
  const args = ['--line-number', '--no-heading', '--color=never', '--max-count=50'];
  if (caseInsensitive) args.push('--ignore-case');
  if (include) args.push('--glob', include);
  for (const ignore of DEFAULT_IGNORE) args.push('--glob', `!${ignore}`);
  args.push('--regexp', pattern, '.');

  const result = await execa('rg', args, {
    cwd: root,
    reject: false,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  // rg 在没有任何匹配时以退出码 1 结束——对我们来说这不算错误。
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`ripgrep failed: ${result.stderr || `exit ${result.exitCode}`}`);
  }

  return result.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_MATCHES)
    .flatMap((line) => {
      const match = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!match) return [];
      return [{ file: match[1]!, line: Number(match[2]), text: match[3]! }];
    });
}

async function grepWithJs(
  pattern: string,
  root: string,
  include: string | undefined,
  caseInsensitive: boolean,
): Promise<Match[]> {
  const regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
  const files = await fg(include ?? '**/*', {
    cwd: root,
    ignore: DEFAULT_IGNORE,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const matches: Match[] = [];
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    let content: string;
    try {
      const buffer = await fs.readFile(path.join(root, file));
      if (buffer.subarray(0, 8000).includes(0)) continue; // 二进制文件
      content = buffer.toString('utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      const text = lines[i]!;
      if (regex.test(text)) matches.push({ file, line: i + 1, text });
    }
  }
  return matches;
}

export function createSearchTools(ctx: ToolContext) {
  const sandbox = { root: ctx.root, denyPath: ctx.rules.denyPath };

  const glob = tool({
    description:
      'Find files by glob pattern, newest first. Use this to explore the layout of the project ' +
      'before reading files.',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts".'),
      cwd: z.string().optional().describe('Directory to search in, relative to the workspace root.'),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    execute: async ({ pattern, cwd, limit }) => {
      const base = cwd ? (await resolveInsideWorkspace(cwd, sandbox)).absolute : ctx.root;
      const entries = await fg(pattern, {
        cwd: base,
        ignore: DEFAULT_IGNORE,
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: false,
        stats: true,
      });

      const sorted = entries
        .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
        .slice(0, limit)
        .map((entry) => entry.path);

      return {
        pattern,
        count: sorted.length,
        truncated: entries.length > sorted.length,
        files: sorted,
      };
    },
  });

  const grep = tool({
    description:
      'Search file contents with a regular expression. Returns file:line matches. Prefer this ' +
      'over reading many files when you are looking for a symbol or string.',
    inputSchema: z.object({
      pattern: z.string().describe('Regular expression (ripgrep syntax when available).'),
      include: z.string().optional().describe('Restrict to files matching this glob, e.g. "*.ts".'),
      caseInsensitive: z.boolean().default(false),
    }),
    execute: async ({ pattern, include, caseInsensitive }) => {
      const useRg = await hasRipgrep();
      const matches = useRg
        ? await grepWithRipgrep(pattern, ctx.root, include, caseInsensitive)
        : await grepWithJs(pattern, ctx.root, include, caseInsensitive);

      const rendered = matches
        .map((m) => `${m.file}:${m.line}: ${m.text.trim().slice(0, 300)}`)
        .join('\n');

      return {
        pattern,
        engine: useRg ? 'ripgrep' : 'javascript',
        count: matches.length,
        truncated: matches.length >= MAX_MATCHES,
        matches: truncate(rendered),
      };
    },
  });

  return { glob, grep };
}
