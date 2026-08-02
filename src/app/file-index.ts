import fg from 'fast-glob';
import { execa } from 'execa';
import { DEFAULT_IGNORE } from '../tools/search.js';
import { matchGlob } from '../permissions/sandbox.js';

/**
 * @ 文件引用弹出菜单的数据源:列举工作区文件 + 模糊过滤。
 *
 * 无 React 依赖——Input.tsx 通过 prop 注入列举函数,保持组件不碰文件系统,
 * 测试时可直接注入假列表。
 */

const DEFAULT_LIMIT = 5000;

/**
 * 列举工作区文件(相对 posix 路径)。优先 `git ls-files`(尊重 .gitignore,
 * 且对大仓库远快于全量扫描);非 git 仓库或 git 失败时回退 fast-glob +
 * DEFAULT_IGNORE。git 的输出同样过一遍 DEFAULT_IGNORE——被跟踪的 dist/
 * 之类噪音不该出现在补全里。
 */
export async function listWorkspaceFiles(root: string, limit = DEFAULT_LIMIT): Promise<string[]> {
  let files: string[];
  try {
    // core.quotePath=false 必须带上:默认值 true 会把非 ASCII 路径转义成
    // `"src/\346\210\252\345\233\276.png"`,补全菜单里显示的是转义串,
    // 插进消息后 @引用 一律解析不到文件(中文/带重音的文件名全中招)。
    const result = await execa(
      'git',
      ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
    );
    files = result.stdout
      .split('\n')
      .filter(Boolean)
      .filter((file) => !DEFAULT_IGNORE.some((rule) => matchGlob(rule, file)));
  } catch {
    files = await fg('**/*', {
      cwd: root,
      ignore: DEFAULT_IGNORE,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });
  }
  return files.sort().slice(0, limit);
}

/**
 * 带 TTL 缓存的列举器:首次调用才扫描(懒加载),TTL 内复用同一个 promise,
 * 过期后下次调用重新扫描。扫描失败不缓存,下次重试。
 */
export function createFileLister(root: string, ttlMs = 15_000): () => Promise<string[]> {
  let cached: Promise<string[]> | undefined;
  let fetchedAt = 0;
  return () => {
    const now = Date.now();
    if (!cached || now - fetchedAt > ttlMs) {
      fetchedAt = now;
      cached = listWorkspaceFiles(root).catch((err) => {
        cached = undefined;
        throw err;
      });
    }
    return cached;
  };
}

/**
 * 大小写不敏感的子序列模糊匹配,按得分降序返回前 limit 条。
 * 空 query 返回字母序前 limit 条(列表本身已排序)。
 */
export function fuzzyFilter(query: string, paths: string[], limit = 50): string[] {
  if (!query) return paths.slice(0, limit);
  const needle = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = fuzzyScore(needle, path);
    if (score !== undefined) scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, limit)
    .map((entry) => entry.path);
}

/** 子序列打分;不匹配返回 undefined。 */
function fuzzyScore(needle: string, path: string): number | undefined {
  const haystack = path.toLowerCase();
  const basenameStart = haystack.lastIndexOf('/') + 1;
  let score = 0;
  let pos = -1;
  let prevHit = -2;
  for (const ch of needle) {
    pos = haystack.indexOf(ch, pos + 1);
    if (pos === -1) return undefined;
    score += 1;
    // 连续命中:成串的匹配远比零散的字符更像用户想要的。
    if (pos === prevHit + 1) score += 4;
    // 边界命中:路径段/词的开头(/ . _ - 之后)权重更高。
    const before = haystack[pos - 1];
    if (pos === 0 || before === '/' || before === '.' || before === '_' || before === '-') {
      score += 3;
    }
    // basename 内命中:输文件名比输目录名常见得多。
    if (pos >= basenameStart) score += 2;
    prevHit = pos;
  }
  // 短路径优先:同样的命中,越短说明匹配越"密"。
  return score - haystack.length / 100;
}
