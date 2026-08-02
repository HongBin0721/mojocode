/**
 * Bash 命令检查。
 *
 * 这是一个启发式层,不是安全边界——铁了心的模型总能混淆命令。真正的边界
 * 是用户对自己看到的命令进行确认。这一层的价值在于:(a) 对明显安全的读
 * 操作不再打扰用户;(b) 对一小撮后果灾难性、绝不值得顺手按个 "y" 的模式
 * 直接硬拒绝。
 */

/** 本身只读、任何环境下都无需确认即可运行的命令。 */
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
  'tsc --noEmit',
];

/**
 * 执行**项目自带代码**的命令(npm scripts、各家测试运行器)。
 *
 * 它们不能进 SAFE_PREFIXES:package.json 的脚本和测试代码可以写文件、删目录、
 * 连网,"只读"的承诺不能取决于仓库自觉。分级处理——可写环境下视为安全
 * (改动本来就免确认或可确认,跑测试是日常动作,不该变吵);只读环境下不再
 * 免检,落回 needs-approval。
 *
 * 落回之后的归宿由权限门决定,两种只读环境不同:read-only 沙箱下弹升级
 * 确认(可以批准);计划模式下直接拒绝——计划模式按设计就不可升级,
 * 调研阶段不该跑构建和测试。见 gate.ts 的 hardStopReason。
 */
export const PROJECT_CODE_PREFIXES = [
  'npm run',
  'npm test',
  'pnpm test',
  'yarn test',
  'vitest run',
  'jest',
  'pytest',
  'go test',
  'cargo test',
];

/**
 * safe 前缀的参数补判:有些命令按前缀是只读的,带上特定参数就不是了。
 * 命中即整段不算安全(落回 needs-approval),任何环境下都生效。
 *
 * - find/fd 的 -exec/-x 一族是任意命令执行通道,-delete/-fprint 直接写盘;
 * - `git branch foo` 建分支、`-d/-D/-m` 删改分支——裸命令和纯列表参数才是列表;
 * - `git remote add/remove/set-url` 改 .git/config——非 flag 的子命令一律不放。
 */
const UNSAFE_ARGS: Array<{ prefix: string; pattern: RegExp }> = [
  // fprint0 必须显式列出:`fprintf?\b` 匹配不到它——`\b` 在 `t` 与 `0`
  // 之间不成立(两者都是单词字符),于是 `find . -fprint0 /etc/x` 会被判成
  // safe 而免确认直跑,任意写盘。
  {
    prefix: 'find',
    pattern: /(^|\s)-(exec|execdir|ok|okdir|delete|fprint(f|0)?|fls)\b/,
  },
  { prefix: 'fd', pattern: /(^|\s)(-x|-X|--exec(-batch)?)\b/ },
  { prefix: 'git branch', pattern: /(^|\s)(-[dDmMcC]\b|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))|(^|\s)[^-\s]/ },
  { prefix: 'git remote', pattern: /(^|\s)[^-\s]/ },
];

/** 片段本身是否只读安全(前缀命中且参数没把它变成写操作)。 */
function isIntrinsicallySafe(segment: string): boolean {
  const normalized = normalize(segment);
  for (const { prefix, pattern } of UNSAFE_ARGS) {
    if (matchesPrefix(normalized, prefix) && pattern.test(normalized.slice(prefix.length))) {
      return false;
    }
  }
  return SAFE_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix));
}

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
  // --force-with-lease / --force-if-includes 是安全变体(不会覆盖别人推的
  // 提交),不拦——否则模型会被推回去建议用户手动裸 force,适得其反。
  {
    pattern: /\bgit\s+push\b[^|;&]*(--force\b(?!-with-lease\b|-if-includes\b)|-f\b)/,
    why: 'force push',
  },
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
  /**
   * 只读环境(read-only 沙箱、计划模式)。为真时:执行项目代码的命令
   * (PROJECT_CODE_PREFIXES)不算安全;用户的 allow 规则也不参与放行——
   * 那些授权是在可写的信任语境下给出的,不该在"只读"承诺里自动生效。
   * deny 规则不受影响,任何环境都拦。
   */
  readOnly?: boolean;
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

  const extraPrefixes = options.readOnly
    ? []
    : [...PROJECT_CODE_PREFIXES, ...options.allow.map(ruleToPrefix)];
  const allSafe = segments.every(
    (segment) =>
      isIntrinsicallySafe(segment) ||
      extraPrefixes.some((prefix) => matchesPrefix(segment, prefix)),
  );

  return { kind: allSafe ? 'safe' : 'needs-approval', suggestedRule };
}
