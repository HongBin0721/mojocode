/**
 * Bash 命令检查。
 *
 * 这是一个启发式层,不是安全边界——铁了心的模型总能混淆命令。真正的边界
 * 是用户对自己看到的命令进行确认。这一层的价值在于:(a) 对明显安全的读
 * 操作不再打扰用户;(b) 对一小撮后果灾难性、绝不值得顺手按个 "y" 的模式
 * 直接硬拒绝。
 */

/** 足够只读、在 `ask` 模式下无需确认即可运行的命令。 */
export const SAFE_PREFIXES = [
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'which',
  'echo',
  'date',
  'env',
  'tree',
  'du',
  'df',
  'grep',
  'rg',
  'fd',
  'find',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'node --version',
  'npm --version',
  'npm ls',
  'npm run',
  'npm test',
  'pnpm test',
  'yarn test',
  'tsc --noEmit',
  'vitest run',
  'jest',
  'pytest',
  'go test',
  'cargo test',
];

/** 直接拒绝的模式。`deny` 优先于所有允许列表和除 yolo 外的所有模式。 */
const HARD_DENY: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, why: 'recursive force delete' },
  { pattern: /\brm\s+(-\S+\s+)*\/(\s|$)/, why: 'delete of /' },
  { pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/, why: 'piping a download into a shell' },
  { pattern: /\bsudo\b/, why: 'privilege escalation' },
  { pattern: /\bchmod\s+(-\S+\s+)*777\b/, why: 'world-writable permissions' },
  { pattern: /\bmkfs(\.|\s)/, why: 'filesystem format' },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\//, why: 'raw write to a block device' },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/, why: 'raw write to a block device' },
  { pattern: /\bgit\s+push\b[^|;&]*(--force|-f)\b/, why: 'force push' },
  { pattern: /\bgit\s+reset\s+--hard\b/, why: 'discards uncommitted work' },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/, why: 'host power control' },
];

export interface CommandVerdict {
  kind: 'deny' | 'safe' | 'needs-approval';
  /** 当 `kind === 'deny'` 时存在。 */
  reason?: string;
  /** 供"总是允许"使用的规则字符串,例如 `Bash(npm test:*)`。 */
  suggestedRule: string;
}

/**
 * 按 shell 操作符切分,使 `git status && rm -rf /` 的两半都会被审查,
 * 而不是只看无害的前半段。
 */
export function splitCommands(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\||\n)/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** `npm test --watch` → `Bash(npm test:*)`;单词命令 → `Bash(ls:*)`。 */
export function suggestRule(command: string): string {
  const words = normalize(command).split(' ');
  const head = words[0] ?? '';
  const second = words[1];
  // 子命令风格的工具,规则里带上两个词更易读。
  const multiword = new Set(['git', 'npm', 'pnpm', 'yarn', 'go', 'cargo', 'docker', 'kubectl', 'uv', 'pip']);
  const prefix = multiword.has(head) && second && !second.startsWith('-') ? `${head} ${second}` : head;
  return `Bash(${prefix}:*)`;
}

function matchesPrefix(command: string, prefix: string): boolean {
  const normalized = normalize(command);
  const normalizedPrefix = normalize(prefix);
  if (normalized === normalizedPrefix) return true;
  return normalized.startsWith(`${normalizedPrefix} `);
}

/**
 * 把 `Bash(npm test:*)` 这样的规则还原为前缀 `npm test`。
 * 普通字符串直接当作前缀处理。
 */
export function ruleToPrefix(rule: string): string {
  const match = /^Bash\((.*?)(?::\*)?\)$/.exec(rule.trim());
  return (match?.[1] ?? rule).trim();
}

export interface JudgeOptions {
  allow: string[];
  deny: string[];
}

export function judgeCommand(command: string, options: JudgeOptions): CommandVerdict {
  const segments = splitCommands(command);
  const suggestedRule = suggestRule(segments[0] ?? command);

  // 拒绝列表要同时匹配整条命令*和*每个片段:像 `curl … | sh` 这样的模式
  // 横跨管道,只看片段就会漏掉;而 `git status && rm -rf /` 只有第二个
  // 片段才会触发。
  for (const { pattern, why } of HARD_DENY) {
    if (pattern.test(command)) {
      return { kind: 'deny', reason: `refused: ${why} (\`${command.trim()}\`)`, suggestedRule };
    }
  }

  const denyPrefixes = options.deny.map(ruleToPrefix);
  for (const segment of segments) {
    for (const prefix of denyPrefixes) {
      if (matchesPrefix(segment, prefix)) {
        return { kind: 'deny', reason: `blocked by deny rule "${prefix}"`, suggestedRule };
      }
    }
  }

  // 任何重定向或命令替换都可能写文件,所以永远不自动放行。
  if (/[>`]|\$\(/.test(command)) {
    return { kind: 'needs-approval', suggestedRule };
  }

  const allowPrefixes = [...SAFE_PREFIXES, ...options.allow.map(ruleToPrefix)];
  const allSafe = segments.every((segment) =>
    allowPrefixes.some((prefix) => matchesPrefix(segment, prefix)),
  );

  return { kind: allSafe ? 'safe' : 'needs-approval', suggestedRule };
}
