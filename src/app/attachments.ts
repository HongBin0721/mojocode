import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideWorkspace, SandboxError } from '../permissions/sandbox.js';
import { looksBinary } from '../tools/files.js';
import { downscaleImage } from './image.js';

/**
 * 输入框 @文件引用 的展开:提交时把 `@路径` 指向的文件内容附在消息末尾
 * 发给模型,UI 时间线仍显示原文(经 Agent.run 的 display 选项)。
 *
 * 信封结构镜像 loop.ts 的 wrapGuidance/unwrapGuidance:持久历史里存展开后
 * 的版本,回放时用 unwrapAttachments 还原原文。发给模型的文字保持英文
 * (项目约定:混语言会劣化 function calling)。
 */

/** 信封头。unwrapAttachments 靠它切回原文——改动即破坏旧会话的回放。 */
const ATTACHMENTS_HEADER = '\n\n[Attached files, referenced with @ in the message above]\n';

/** 单文件与整条消息的附件体积上限。低于 read 工具的 400KB——这是内联上下文。 */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

/** 图片的体积上限,与文本独立(base64 后约 1.37 倍,还会随快照整份重写)。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 按扩展名识别的图片类型。SVG 刻意留在文本路径:它是 XML,模型直接读
 * 效果更好,且不少服务商拒收 image/svg+xml。
 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 一张随消息发给模型的图片。`data` 必须是 base64 字符串——历史要经
 * JSONL 明文往返,Buffer/Uint8Array 会 revive 成字节映射对象,恢复会话
 * 后第一轮请求即被 AI SDK 的校验拒绝。
 */
export interface ImageAttachment {
  mediaType: string;
  data: string;
  /** @ 引用的相对路径,或 clipboard-N.png;作为 FilePart 的 filename 发出。 */
  filename?: string;
}

/**
 * @token:`@` 必须在行首或空白之后(`foo@bar.com` 不算引用),路径为连续
 * 非空白;尾部标点(中英文逗号句号引号括号等)视为句子的一部分剥掉。
 */
const AT_TOKEN = /(^|\s)@([^\s@]+)/g;

/** 提取文本中的 @路径,去重、按出现顺序。 */
export function extractAtPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(AT_TOKEN)) {
    const raw = match[2]!.replace(/[.,;:)\]}'"。，、；：）】》]+$/, '');
    if (raw && !paths.includes(raw)) paths.push(raw);
  }
  return paths;
}

export interface ExpandResult {
  /** 附上文件内容后的消息;没有可附的内容时与原文严格相等。 */
  expanded: string;
  /** 成功附上的路径(相对工作区)。 */
  attached: string[];
  /** 被跳过的引用及原因(英文,同时用于模型与 UI 提示)。 */
  skipped: { path: string; reason: string }[];
  /**
   * 被引用的图片。不进文本信封——由调用方作为多模态 part 随消息发出,
   * `@路径` 原样留在正文里,靠 FilePart 的 filename 对应。
   */
  images: ImageAttachment[];
}

/**
 * 展开文本中的 @文件引用。每个引用独立失败(不存在/目录/二进制/超限/
 * 被 sandbox 拒绝),只进 skipped,绝不抛错;全部失败时不加信封,
 * 但 skipped 照常返回供 UI 提醒。
 */
export async function expandAtReferences(
  text: string,
  options: { root: string; denyPath?: string[] },
): Promise<ExpandResult> {
  const attached: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const blocks: string[] = [];
  const images: ImageAttachment[] = [];
  let totalBytes = 0;
  let totalImageBytes = 0;

  for (const ref of extractAtPaths(text)) {
    try {
      const resolved = await resolveInsideWorkspace(ref, options);
      const stat = await fs.stat(resolved.absolute);
      if (stat.isDirectory()) {
        skipped.push({ path: ref, reason: 'is a directory' });
        continue;
      }
      // 图片分支在文本的体积/二进制检查之前:图片天然是二进制且远超 64KB。
      const imageType = IMAGE_MEDIA_TYPES[path.extname(resolved.relative).toLowerCase()];
      if (imageType) {
        if (stat.size > MAX_IMAGE_BYTES) {
          skipped.push({
            path: ref,
            reason: `image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
          });
          continue;
        }
        const buffer = await fs.readFile(resolved.absolute);
        // 先降采样再计入总量:缩完通常只剩几分之一,按原始体积算会把
        // 本来放得下的几张图挡在门外。
        const shrunk = await downscaleImage({
          mediaType: imageType,
          data: buffer.toString('base64'),
        });
        const bytes = Math.round(shrunk.data.length * 0.75);
        if (totalImageBytes + bytes > MAX_TOTAL_IMAGE_BYTES) {
          skipped.push({ path: ref, reason: 'total image size limit reached' });
          continue;
        }
        totalImageBytes += bytes;
        attached.push(resolved.relative);
        images.push({ ...shrunk, filename: resolved.relative });
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.push({ path: ref, reason: `too large (${Math.round(stat.size / 1024)}KB)` });
        continue;
      }
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
        skipped.push({ path: ref, reason: 'total attachment size limit reached' });
        continue;
      }
      const buffer = await fs.readFile(resolved.absolute);
      if (looksBinary(buffer)) {
        skipped.push({ path: ref, reason: 'binary file' });
        continue;
      }
      totalBytes += buffer.length;
      attached.push(resolved.relative);
      blocks.push(`<file path="${resolved.relative}">\n${buffer.toString('utf8')}\n</file>`);
    } catch (err) {
      if (err instanceof SandboxError) {
        skipped.push({ path: ref, reason: 'blocked by workspace rules' });
      } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped.push({ path: ref, reason: NOT_FOUND });
      } else {
        skipped.push({ path: ref, reason: (err as Error).message });
      }
    }
  }

  if (blocks.length === 0) return { expanded: text, attached, skipped, images };

  // 跳过的引用也告知模型,免得它以为文件内容都在场。
  const skippedLines = skipped.map((s) => `[Skipped @${s.path}: ${s.reason}]`);
  const expanded =
    text + ATTACHMENTS_HEADER + '\n' + [...blocks, ...skippedLines].join('\n\n');
  return { expanded, attached, skipped, images };
}

/** 引用指向的文件不存在。单独成常量:值得不值得提示要按它区分。 */
const NOT_FOUND = 'not found';

/**
 * 值得提示给用户的跳过项。
 *
 * `@` 后跟任意词都会被当成引用,`@types/node`、`@media`、`@某人` 这类
 * 普通行文因此天然落在 not found 上——为它们弹警告纯属噪音。只有当这条
 * 消息里确实有引用成功解析时,才说明用户在用 @ 引用文件,此时"某个路径
 * 打错了"才是有用的反馈。其他原因(被规则拦下、过大、二进制)一律提示:
 * 那些都是用户确实指向了一个存在的文件却没能附上。
 */
export function warnableSkips(result: ExpandResult): { path: string; reason: string }[] {
  const resolvedAny = result.attached.length > 0;
  return result.skipped.filter((s) => resolvedAny || s.reason !== NOT_FOUND);
}

/**
 * `expandAtReferences` 的逆操作:从持久历史的展开消息里还原用户原文。
 * 不是信封格式返回 undefined。与 unwrapGuidance 相同的已接受缺陷:
 * 用户原文里恰好含信封头字面量时会误切。
 */
export function unwrapAttachments(text: string): string | undefined {
  const index = text.indexOf(ATTACHMENTS_HEADER);
  if (index === -1) return undefined;
  return text.slice(0, index);
}
