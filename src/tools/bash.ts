import { tool } from 'ai';
import { z } from 'zod';
import { execa } from 'execa';
import path from 'node:path';
import { resolveInsideWorkspace } from '../permissions/sandbox.js';
import { truncate, type ToolContext } from './context.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export function createBashTool(ctx: ToolContext) {
  return tool({
    description:
      'Run a shell command in the workspace. Use this for builds, tests, git and anything the ' +
      'other tools do not cover. Prefer the read/glob/grep tools over cat/find/grep — they are ' +
      'faster and produce cleaner output.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run.'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory relative to the workspace root. Defaults to the root.'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`),
    }),
    execute: async ({ command, cwd, timeoutMs }, { abortSignal }) => {
      const workDir = cwd ? (await resolveInsideWorkspace(cwd, { root: ctx.root, denyPath: ctx.rules.denyPath })).absolute : ctx.root;
      const label = path.relative(ctx.root, workDir) || '.';

      await ctx.gate.checkBash(command, label, { subagent: ctx.subagent });

      const started = Date.now();
      const result = await execa(command, {
        shell: true,
        cwd: workDir,
        timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        reject: false,
        all: true,
        maxBuffer: 10 * 1024 * 1024,
        cancelSignal: abortSignal,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
      });

      const output = truncate((result.all ?? '').trim(), 20_000);

      if (result.timedOut) {
        return {
          command,
          timedOut: true,
          exitCode: null,
          output: output || '(no output before timeout)',
          message: `Command exceeded its ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout and was killed.`,
        };
      }

      return {
        command,
        cwd: label,
        exitCode: result.exitCode ?? null,
        durationMs: Date.now() - started,
        output: output || '(no output)',
      };
    },
  });
}
