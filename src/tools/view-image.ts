import fs from 'node:fs/promises';
import path from 'node:path';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { resolvePath } from './paths.js';
import { downscaleImage } from '../app/image.js';
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } from '../app/attachments.js';
import { truncate, type ToolContext } from './context.js';

/** 视觉模型输出描述的字符上限——描述是喂回主力模型的上下文。 */
const MAX_DESCRIPTION_CHARS = 8_000;

const DEFAULT_VIEW_PROMPT =
  'Describe this image thoroughly and factually: overall content, any text ' +
  '(transcribe it verbatim), UI elements or charts with their labels and values, ' +
  'colors and layout where relevant. Do not speculate beyond what is visible.';

/**
 * 读图工具:把图片交给视觉模型(visionModel 配置,缺省回落 provider 预设)
 * 读成文字描述。非视觉主力模型的图片因此降级为文件引用后仍可被消费——
 * 主力模型不浪费视觉 token,需要看图时才花视觉模型的钱。
 *
 * 仅在解析出视觉模型时注册(照 web_search 的降级模式)。它打的是**已配置的
 * provider 端点**,不是模型指定的任意 URL——与主循环、task 子代理同一条出网
 * 路径,不是一件额外的联网能力。
 */
export function createViewTools(ctx: ToolContext) {
  // 注册时机一次性求值:与 provider 工具同生命周期(/new 重建时再取)。
  const visionAvailable = ctx.visionModel() !== undefined;
  return {
    ...(visionAvailable ? { view_image: createViewImageTool(ctx) } : {}),
  };
}

export function createViewImageTool(ctx: ToolContext) {
  return tool({
    description:
      'View an image file and get a text description from a vision model. Use it when a message ' +
      'references an attached image by path (e.g. "[Attached images, readable with the view_image ' +
      'tool]") and the task needs its visual content — screenshots, diagrams, photos. ' +
      'Returns the description, not the image.',
    inputSchema: z.object({
      path: z
        .string()
        .describe('Path to the image file (absolute, or relative to the workspace root).'),
      prompt: z
        .string()
        .max(2_000)
        .optional()
        .describe('What to look for or report; defaults to a thorough factual description.'),
    }),
    execute: async ({ path: imagePath, prompt }, { abortSignal }) => {
      const model = ctx.visionModel();
      if (!model) {
        // 会话中途切到无预设视觉模型的 provider 才会走到这里(注册是启动
        // 时的事实)。照 web_search 的同款语义给可操作的指引。
        throw new Error(
          'view_image is not configured: no vision model resolved for the current provider. ' +
            'Ask the user to set visionModel (or MOJOCODE_VISION_MODEL) in the configuration.',
        );
      }
      const resolved = resolvePath(imagePath, ctx.root);
      const stat = await fs.stat(resolved.absolute);
      if (stat.isDirectory()) {
        throw new Error(`${resolved.relative} is a directory.`);
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `${resolved.relative} is ${(stat.size / 1024 / 1024).toFixed(1)}MB, too large to view ` +
            `(limit ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`,
        );
      }
      const mediaType = IMAGE_MEDIA_TYPES[path.extname(resolved.absolute).toLowerCase()];
      if (!mediaType) {
        throw new Error(
          `${resolved.relative} is not a supported image type (png/jpg/jpeg/gif/webp).`,
        );
      }

      const data = (await fs.readFile(resolved.absolute)).toString('base64');
      const shrunk = await downscaleImage({ mediaType, data });
      const result = await generateText({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt ?? DEFAULT_VIEW_PROMPT },
              { type: 'file', mediaType: shrunk.mediaType, data: shrunk.data },
            ],
          },
        ],
        abortSignal,
      });
      return {
        path: resolved.absolute,
        description: truncate(result.text, MAX_DESCRIPTION_CHARS),
      };
    },
  });
}
