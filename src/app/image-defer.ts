import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment } from './attachments.js';
import { IMAGE_MEDIA_TYPES } from './attachments.js';
import { imagesDir } from '../config/paths.js';

/**
 * 非视觉模型的图片降级:消息不带图片 part(服务端会整单拒收),改为
 * `@`引用图沿用原路径、粘贴图落到 ~/.mojocode/images/,正文尾部注入英文
 * 信封列出路径,模型用 view_image 工具按需读图。视觉模型的直发链路
 * (loop.ts 的 buildUserContent)不经此处。
 *
 * 与 @附件信封的 unwrap 关系:时间线回放保留引用行(用户看到图片落在
 * 哪里是有用信息),但 rewind 行与输入框回填走 unwrapImagesEnvelope 还原
 * 用户原文——机器生成的英文信封和绝对路径不该变成可编辑输入再次提交。
 */

/** view_image 已注册时的信封头。 */
const IMAGES_HEADER = '\n\n[Attached images, readable with the view_image tool]\n';

/** 无视觉模型可用时的信封头——如实告知,不让模型对着路径空转。 */
const IMAGES_NO_TOOL_HEADER = '\n\n[Attached images — this model cannot view them directly]\n';

/** 同秒两条消息的防覆盖序号。 */
let sequence = 0;

/** 落盘文件名:日期时间到秒 + 进程 pid + 序号 + 扩展名。 */
function imageName(filename: string | undefined, mediaType: string): string {
  const ext =
    (filename?.includes('.') && path.extname(filename)) || MEDIA_TYPE_EXT[mediaType] || '.png';
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const clock = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join('');
  sequence += 1;
  // pid:多个 mojocode 进程共享 ~/.mojocode/images,各自的序号都从 1 起,
  // 同秒落盘会静默互相覆盖——进程内序号挡不住跨进程,uid 得带进程份。
  return `${stamp}-${clock}-${process.pid}-${sequence}${ext}`;
}

/** mediaType 反查扩展名(落盘命名用)。 */
const MEDIA_TYPE_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MEDIA_TYPES).map(([ext, type]) => [type, ext]),
);

export interface DeferImagesResult {
  /** 注入信封后的消息文本(无图片 part 的纯字符串)。 */
  text: string;
  /** 恒为 undefined——降级后不再有随消息发出的图片。 */
  images: undefined;
  /** 实际降级成功的图片数(写盘失败的不算)。 */
  deferred: number;
}

/**
 * 把图片从消息体降级为文件引用。逐图独立失败(写盘出错只进信封的
 * skipped 行,绝不抛错);返回的 images 恒为 undefined,调用方据此以纯
 * 文本发送。目录不存在会顺手 mkdir,失败由逐图 try/catch 兜住。
 */
export async function deferImagesForModel(
  text: string,
  images: ImageAttachment[],
  options: { viewImageTool: boolean; imagesDir?: string },
): Promise<DeferImagesResult> {
  const dir = options.imagesDir ?? imagesDir();
  const lines: string[] = [];
  let deferred = 0;

  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  for (const image of images) {
    // @ 引用图:原文件已在工作区(realpath 过、界内、deny 已过),零拷贝。
    if (image.absolutePath) {
      lines.push(`- ${image.absolutePath} (${image.mediaType})`);
      deferred += 1;
      continue;
    }
    // 粘贴图:内存里的 base64(降采样后)写盘,消息里引用落盘路径。
    try {
      const target = path.join(dir, imageName(image.filename, image.mediaType));
      await fs.writeFile(target, Buffer.from(image.data, 'base64'));
      // 回填:同一份 attachments 再次降级(inject 在写盘窗口内错过入队,
      // 调用方顺势开新一轮重跑降级)时走上面的零拷贝分支,不写第二份文件。
      image.absolutePath = target;
      lines.push(`- ${target} (${image.mediaType})`);
      deferred += 1;
    } catch {
      const label = image.filename ?? image.mediaType;
      lines.push(`[Skipped ${label}: could not save image]`);
    }
  }

  const header = options.viewImageTool ? IMAGES_HEADER : IMAGES_NO_TOOL_HEADER;
  return { text: text + header + lines.join('\n'), images: undefined, deferred };
}

/**
 * 从降级后的消息里剥掉图片信封,还原用户原文。不是信封格式返回
 * undefined。两个信封头都认——回填/rewind 时无从知道当时工具注册与否。
 */
export function unwrapImagesEnvelope(text: string): string | undefined {
  for (const header of [IMAGES_HEADER, IMAGES_NO_TOOL_HEADER]) {
    const index = text.indexOf(header);
    if (index !== -1) return text.slice(0, index);
  }
  return undefined;
}
