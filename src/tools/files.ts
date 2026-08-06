import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import { resolveInsideWorkspace } from '../permissions/sandbox.js';
import { truncate, type ToolContext } from './context.js';

const MAX_READ_BYTES = 400_000;

/** 用开头 8KB 是否含 NUL 字节粗判二进制,read 工具与 @ 引用展开共用。 */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/** 渲染紧凑的 unified diff,供权限确认提示和 UI 使用。 */
export function renderDiff(relativePath: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(relativePath, relativePath, before, after, '', '', {
    context: 3,
  });
  // 去掉 createTwoFilesPatch 输出的冗余 `Index:`/`===` 头部。
  const body = patch.split('\n').slice(2).join('\n');
  return truncate(body, 8000);
}

export function createFileTools(ctx: ToolContext) {
  const sandbox = { root: ctx.root, denyPath: ctx.rules.denyPath };

  const read = tool({
    description:
      'Read a UTF-8 text file from the workspace. Returns the content with 1-based line numbers. ' +
      'Use offset/limit for large files. You must read a file before editing it.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to the workspace root.'),
      offset: z.number().int().min(1).optional().describe('First line to return (1-based).'),
      limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines.'),
    }),
    execute: async ({ path: filePath, offset, limit }) => {
      const resolved = await resolveInsideWorkspace(filePath, sandbox);
      const stat = await fs.stat(resolved.absolute);
      if (stat.isDirectory()) {
        throw new Error(`${resolved.relative} is a directory. Use the glob tool to list its contents.`);
      }
      if (stat.size > MAX_READ_BYTES) {
        throw new Error(
          `${resolved.relative} is ${Math.round(stat.size / 1024)}KB, too large to read whole. ` +
            'Use grep to find the relevant lines, then read with offset/limit.',
        );
      }

      const buffer = await fs.readFile(resolved.absolute);
      if (looksBinary(buffer)) {
        throw new Error(`${resolved.relative} looks like a binary file and cannot be read as text.`);
      }

      const content = buffer.toString('utf8');
      ctx.readFiles.add(resolved.absolute);

      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const end = limit ? start + limit : lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice
        .map((line, i) => `${String(start + i + 1).padStart(5)}\t${line}`)
        .join('\n');

      return {
        path: resolved.relative,
        totalLines: lines.length,
        shownLines: `${start + 1}-${Math.min(end, lines.length)}`,
        content: truncate(numbered),
      };
    },
  });

  const write = tool({
    description:
      'Create a new file or completely replace an existing one. For targeted changes to an ' +
      'existing file prefer the edit tool — it is safer and cheaper.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to the workspace root.'),
      content: z.string().describe('Full file content to write.'),
    }),
    execute: async ({ path: filePath, content }) => {
      const resolved = await resolveInsideWorkspace(filePath, sandbox);
      ctx.gate.assertCanMutate(resolved.relative);

      let before = '';
      let existed = true;
      try {
        before = await fs.readFile(resolved.absolute, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        existed = false;
      }

      if (existed && before === content) {
        return { path: resolved.relative, changed: false, message: 'File already has this content.' };
      }

      const diff = existed
        ? renderDiff(resolved.relative, before, content)
        : truncate(content, 4000);
      await ctx.gate.checkWrite(resolved.relative, diff);

      await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
      await fs.writeFile(resolved.absolute, content, 'utf8');
      ctx.readFiles.add(resolved.absolute);

      // 写盘之后才检查:诊断永远描述已落地的内容,失败也只是拿不到诊断。
      const diagnostics = await ctx.lsp?.check(resolved.absolute, content);
      return {
        path: resolved.relative,
        changed: true,
        created: !existed,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content.split('\n').length,
        ...(diagnostics ? { diagnostics } : {}),
      };
    },
  });

  const edit = tool({
    description:
      'Replace an exact string in a file. `oldString` must appear exactly once unless replaceAll ' +
      'is set. Read the file first — this tool refuses to edit files you have not read.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to the workspace root.'),
      oldString: z.string().describe('Exact text to replace, including indentation.'),
      newString: z.string().describe('Replacement text.'),
      replaceAll: z.boolean().default(false).describe('Replace every occurrence instead of requiring uniqueness.'),
    }),
    execute: async ({ path: filePath, oldString, newString, replaceAll }) => {
      const resolved = await resolveInsideWorkspace(filePath, sandbox);
      ctx.gate.assertCanMutate(resolved.relative);

      if (!ctx.readFiles.has(resolved.absolute)) {
        throw new Error(
          `You have not read ${resolved.relative} in this session. Read it first so your edit ` +
            'is based on the current content.',
        );
      }
      if (oldString === newString) {
        throw new Error('oldString and newString are identical — nothing to do.');
      }

      const before = await fs.readFile(resolved.absolute, 'utf8');
      const occurrences = before.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `oldString was not found in ${resolved.relative}. It must match the file byte for byte, ` +
            'including indentation and line endings.',
        );
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `oldString appears ${occurrences} times in ${resolved.relative}. Include more surrounding ` +
            'context to make it unique, or set replaceAll.',
        );
      }

      const after = replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);

      const diff = renderDiff(resolved.relative, before, after);
      await ctx.gate.checkWrite(resolved.relative, diff);
      await fs.writeFile(resolved.absolute, after, 'utf8');

      const diagnostics = await ctx.lsp?.check(resolved.absolute, after);
      return {
        path: resolved.relative,
        replacements: replaceAll ? occurrences : 1,
        diff,
        ...(diagnostics ? { diagnostics } : {}),
      };
    },
  });

  return { read, write, edit };
}
