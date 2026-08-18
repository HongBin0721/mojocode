import { tool } from 'ai';
import { z } from 'zod';
import { execa } from 'execa';
import path from 'node:path';
import { resolveInsideWorkspace } from '../permissions/sandbox.js';
import { truncate, type ToolContext } from './context.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** 流式输出的节流参数:发射间隔 / 单条聚合上限 / 单次调用总量封顶。 */
const STREAM_INTERVAL_MS = 100;
const STREAM_CHUNK_MAX = 2_048;
const STREAM_TOTAL_MAX = 64_000;

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
    execute: async ({ command, cwd, timeoutMs }, { abortSignal, toolCallId }) => {
      const workDir = cwd ? (await resolveInsideWorkspace(cwd, { root: ctx.root, denyPath: ctx.rules.denyPath })).absolute : ctx.root;
      const label = path.relative(ctx.root, workDir) || '.';

      await ctx.gate.checkBash(command, label, { subagent: ctx.subagent });

      const started = Date.now();
      const subprocess = execa(command, {
        shell: true,
        cwd: workDir,
        timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        reject: false,
        all: true,
        maxBuffer: 10 * 1024 * 1024,
        cancelSignal: abortSignal,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
      });

      // 运行中的增量输出(GUI 终端面板消费)。两道闸防事件风暴:
      //  - 节流聚合:距上次发射 ≥100ms 或缓冲 ≥2KB 才发一条;
      //  - 单次调用总量封顶 64KB,超出停发——尾部由 tool-end 的全量 output
      //    兜底(消费端在 tool-end 到达时用全量替换积累的 delta)。
      // 子 agent 的 bash 在私有 bus 上跑,delta 天然不进主时间线。
      let streamBuffer = '';
      let streamedTotal = 0;
      let lastFlushAt = 0;
      const flushStream = (): void => {
        if (!streamBuffer) return;
        ctx.bus.emit({ type: 'tool-output-delta', callId: toolCallId, chunk: streamBuffer });
        streamBuffer = '';
        lastFlushAt = Date.now();
      };
      subprocess.all?.on('data', (data: Buffer) => {
        if (streamedTotal >= STREAM_TOTAL_MAX) return;
        const text = data.toString('utf8');
        const room = STREAM_TOTAL_MAX - streamedTotal;
        streamBuffer += text.length > room ? text.slice(0, room) : text;
        streamedTotal += Math.min(text.length, room);
        if (streamBuffer.length >= STREAM_CHUNK_MAX || Date.now() - lastFlushAt >= STREAM_INTERVAL_MS) {
          flushStream();
        }
      });

      const result = await subprocess;
      flushStream(); // 进程结束:残余缓冲收尾

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
