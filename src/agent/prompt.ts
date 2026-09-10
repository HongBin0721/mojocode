import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

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

- Stay inside the workspace unless the task explicitly needs something outside it.
- Never run destructive commands (force push, hard reset, recursive delete) on your own.`;

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

export interface PromptOptions {
  /** view_image 是否注册了(取决于有没有解析出视觉模型)。 */
  viewImage?: boolean;
}

export function buildSystemPrompt(env: EnvironmentInfo, opts: PromptOptions, append?: string): string {
  const sections = [BASE_PROMPT];

  sections.push(
    [
      '## Environment',
      `- Workspace root: ${env.root}`,
      `- Platform: ${env.platform}`,
      `- Git repository: ${env.isGitRepo ? `yes (branch ${env.gitBranch})` : 'no'}`,
      opts.viewImage
        ? '- Images: user messages may reference attached image files by path; use the view_image tool to read one (you cannot see images directly)'
        : '',
      env.projectFiles.length > 0 ? `- Top-level entries: ${env.projectFiles.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

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
