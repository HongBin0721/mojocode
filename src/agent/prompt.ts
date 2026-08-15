import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { Permissions, SandboxMode } from '../config/schema.js';

const BASE_PROMPT = `You are mojocode, a coding agent that works inside the user's terminal.

You have tools for reading, searching, editing and running code in the user's workspace. Use them
rather than guessing. Prefer grep and glob to locate code over reading files at random.

## How to work

- Answer the question that was asked. Do not expand the scope on your own.
- Before editing a file, read it. The edit tool will refuse otherwise.
- Prefer edit over write for existing files; write replaces the whole file.
- After changing code, run the project's tests or type checker if one exists, and report what
  actually happened. If something fails, say so and show the output — never claim success you
  have not verified.
- For work spanning more than a couple of steps, use the todo tool so the user can see the plan.
- For research that sweeps many files, or for independent subtasks that could run in
  parallel, delegate to the task tool: each subagent spends its own context and returns
  only its report. Use mode 'explore' for read-only research. Do not delegate quick
  single-file lookups; read those directly.
- Do not create documentation, README files or comments unless asked.

## Style

- Be concise. The output is read in a terminal, not a browser.
- Refer to code as \`path/to/file.ts:42\` so the user can click it.
- Match the surrounding code's conventions, naming and comment density.
- Explain what you did in a sentence or two, not a report.

## Boundaries

- Everything is scoped to the workspace root. Paths outside it are rejected.
- Some actions require the user's approval. If one is denied, do not retry it — ask what to do.
- Never run destructive commands (force push, hard reset, recursive delete) on your own.
- Network access is approved per domain. If a domain is denied, do not route around it
  (e.g. with curl in bash).`;

/** 沙箱行后缀。只有受限的档位需要额外交代,其余留空。 */
const SANDBOX_CAVEATS: Partial<Record<SandboxMode, string>> = {
  'read-only':
    ' — file edits and state-changing commands are outside the sandbox; each one needs the user to approve an escalation',
};

/** 仅在计划模式下附加。英文——喂给模型的文本不本地化。 */
const planModePrompt = (webSearch: boolean): string => `## Plan mode

You are planning, not implementing. Produce a plan the user approves before any code changes.

- Research first. Read the files the task actually touches, grep the call sites, and check how
  similar features are already built here. Do not plan against a guess.
- You cannot edit files or run state-changing commands. Read, glob, grep, ${
  webSearch ? 'web_search, ' : ''
}web_fetch and read-only commands all work. Do not try edits to "check" — they will be refused.
- When the plan is ready, call the exit_plan tool with it. Do not print the plan as an ordinary
  message instead of calling the tool — only the tool asks the user to approve it.
- Write the plan for whoever implements it: which files change and what changes in each, the
  order to do them in, and how to verify the result. Skip preamble and restating the request.
- If the user rejects it, you are still in plan mode. Revise it from their feedback and call
  exit_plan again.
- Always end the turn by calling exit_plan. It is the only way out of plan mode, and the user
  chose plan mode precisely so that nothing happens until they approve. Even if you conclude the
  task needs no code changes, say so *through* exit_plan — that conclusion is theirs to accept,
  not yours to act on. Never research, answer, and stop without calling it.
- The one exception is a direct question about the code that asks for no change at all
  ("what does this function do?"). Answer those normally. Anything phrased as work to be done
  goes through exit_plan.`;

export interface EnvironmentInfo {
  root: string;
  platform: string;
  isGitRepo: boolean;
  gitBranch?: string;
  projectFiles: string[];
  /** AGENTS.md / MOJOCODE.md 的内容(如果存在)。 */
  projectInstructions?: string;
}

async function readFirstExisting(root: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      const content = await fs.readFile(path.join(root, name), 'utf8');
      if (content.trim()) return content.trim().slice(0, 20_000);
    } catch {
      // 尝试下一个候选文件
    }
  }
  return undefined;
}

export async function gatherEnvironment(root: string): Promise<EnvironmentInfo> {
  const [branchResult, entries, projectInstructions] = await Promise.all([
    execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, reject: false, timeout: 3000 }),
    fs.readdir(root, { withFileTypes: true }).catch(() => []),
    readFirstExisting(root, ['AGENTS.md', 'MOJOCODE.md', 'CLAUDE.md']),
  ]);

  const isGitRepo = branchResult.exitCode === 0;
  const projectFiles = entries
    .filter((e) => !e.name.startsWith('.'))
    .slice(0, 40)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();

  return {
    root,
    platform: process.platform,
    isGitRepo,
    gitBranch: isGitRepo ? branchResult.stdout.trim() : undefined,
    projectFiles,
    projectInstructions,
  };
}

export interface PromptPermissions {
  permissions: Permissions;
  /** 计划模式激活。压过两轴的描述——模型该看到的是"现在只能调研"。 */
  plan: boolean;
  /** web_search 是否注册了(取决于搜索后端有没有 key)。web_fetch 恒在。 */
  webSearch?: boolean;
}

export function buildSystemPrompt(
  env: EnvironmentInfo,
  perms: PromptPermissions,
  append?: string,
): string {
  const sections = [BASE_PROMPT];
  const { sandbox, approval } = perms.permissions;

  sections.push(
    [
      '## Environment',
      `- Workspace root: ${env.root}`,
      `- Platform: ${env.platform}`,
      `- Git repository: ${env.isGitRepo ? `yes (branch ${env.gitBranch})` : 'no'}`,
      perms.plan
        ? '- Permissions: plan mode — research only; you cannot write files or run state-changing commands until the user approves your plan'
        : `- Sandbox: ${sandbox}${SANDBOX_CAVEATS[sandbox] ?? ''}; approval policy: ${approval}${
            approval === 'never' ? ' — nothing outside the sandbox can be escalated; it just fails' : ''
          }`,
      `- Web tools: ${perms.webSearch ? 'web_search and web_fetch' : 'web_fetch'} available; each new domain needs the user's approval unless previously allowed`,
      env.projectFiles.length > 0 ? `- Top-level entries: ${env.projectFiles.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (perms.plan) {
    sections.push(planModePrompt(perms.webSearch ?? false));
  }

  if (env.projectInstructions) {
    sections.push(
      `## Project instructions\n\nThe workspace provides these instructions. Follow them.\n\n${env.projectInstructions}`,
    );
  }

  if (append?.trim()) {
    sections.push(`## Additional instructions\n\n${append.trim()}`);
  }

  return sections.join('\n\n');
}
