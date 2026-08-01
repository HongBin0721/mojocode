/**
 * Bash command inspection.
 *
 * This is a heuristic layer, not a security boundary — a determined model can
 * always obfuscate a command. The real boundary is the user confirming the
 * command they see. What this buys us is (a) not prompting for obviously safe
 * reads, and (b) hard-refusing a small set of patterns that are catastrophic
 * and never worth a "y" typed on autopilot.
 */

/** Commands that are read-only enough to run without prompting in `ask` mode. */
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

/** Patterns refused outright. `deny` beats every allowlist and every mode except yolo. */
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
  /** Present when `kind === 'deny'`. */
  reason?: string;
  /** Rule string offered for "always allow", e.g. `Bash(npm test:*)`. */
  suggestedRule: string;
}

/**
 * Splits on shell operators so `git status && rm -rf /` is judged on both
 * halves rather than only the benign prefix.
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

/** `npm test --watch` → `Bash(npm test:*)`; single-word commands → `Bash(ls:*)`. */
export function suggestRule(command: string): string {
  const words = normalize(command).split(' ');
  const head = words[0] ?? '';
  const second = words[1];
  // Subcommand-style tools read better with two words in the rule.
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
 * Converts a rule like `Bash(npm test:*)` back to the prefix `npm test`.
 * Plain strings are treated as prefixes directly.
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

  // Match the denylist against the whole command *and* each segment: patterns
  // like `curl … | sh` span a pipe and would vanish if we only saw segments,
  // while `git status && rm -rf /` only trips on the second segment.
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

  // Any redirection or command substitution can write files, so never auto-allow it.
  if (/[>`]|\$\(/.test(command)) {
    return { kind: 'needs-approval', suggestedRule };
  }

  const allowPrefixes = [...SAFE_PREFIXES, ...options.allow.map(ruleToPrefix)];
  const allSafe = segments.every((segment) =>
    allowPrefixes.some((prefix) => matchesPrefix(segment, prefix)),
  );

  return { kind: allSafe ? 'safe' : 'needs-approval', suggestedRule };
}
