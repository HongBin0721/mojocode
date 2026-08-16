import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createViewTools } from '../src/tools/view-image.js';
import type { ToolContext } from '../src/tools/context.js';

// 只换 generateText,保留真实的 tool()——参数 schema 与执行链路都要走真的。
const mockGenerateText = vi.hoisted(() => vi.fn());
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: mockGenerateText,
}));

const MODEL = { modelId: 'vision-stub' } as never;

/** 只填工具真正用到的字段(web-tools.test.ts 的手法)。 */
function makeCtx(vision: boolean, root = '/', extraRoots: string[] = []) {
  const ctx = {
    root,
    rules: { denyPath: [] },
    extraReadRoots: () => extraRoots,
    visionModel: () => (vision ? MODEL : undefined),
  } as unknown as ToolContext;
  return ctx;
}

type Execute = (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
function executeOf(tool: unknown): Execute {
  return (tool as { execute: Execute }).execute;
}

/** 10 字节的 PNG 头——downscaleImage 解不开会原样返回,足够走通链路。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe('createViewTools 注册', () => {
  it('视觉模型可解析时才注册 view_image', () => {
    expect(Object.keys(createViewTools(makeCtx(false)))).toEqual([]);
    expect(Object.keys(createViewTools(makeCtx(true)))).toEqual(['view_image']);
  });
});

describe('view_image 执行', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-view-'));
    await fs.writeFile(path.join(root, 'img.png'), PNG_BYTES);
    await fs.writeFile(path.join(root, 'note.txt'), 'plain text');
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  afterEach(() => {
    mockGenerateText.mockReset();
  });

  it('读图 → 视觉模型收到 file part,返回描述', async () => {
    mockGenerateText.mockResolvedValue({ text: 'A red square.', usage: {} });
    const view = createViewTools(makeCtx(true)).view_image;
    const result = await executeOf(view)({ path: path.join(root, 'img.png') }, {});

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0]![0] as {
      model: unknown;
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(call.model).toBe(MODEL);
    const [textPart, filePart] = call.messages[0]!.content;
    expect(textPart!.type).toBe('text');
    expect(textPart!.text).toMatch(/Describe this image/); // 默认提示词
    expect(filePart).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: PNG_BYTES.toString('base64'),
    });
    expect(result.description).toBe('A red square.');
    expect(result.path).toBe(await fs.realpath(path.join(root, 'img.png')));
  });

  it('自定义 prompt 落到 text part;描述超长被截断', async () => {
    mockGenerateText.mockResolvedValue({ text: 'x'.repeat(9_000), usage: {} });
    const view = createViewTools(makeCtx(true)).view_image;
    const result = await executeOf(view)(
      { path: path.join(root, 'img.png'), prompt: 'Read the error message.' },
      {},
    );

    const [textPart] = (
      mockGenerateText.mock.calls[0]![0] as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    ).messages[0]!.content;
    expect(textPart!.text).toBe('Read the error message.');
    expect((result.description as string).length).toBeLessThanOrEqual(8_100);
    expect(result.description).toMatch(/output truncated/);
  });

  it('视觉模型中途不可解析时抛可操作的错误', async () => {
    // 注册时有、执行时没有:会话中途切到了无预设视觉模型的 provider。
    // execute 内现取 getter 才是这道防线的意义(web_search 同款语义)。
    let available = true;
    const view = createViewTools({
      ...makeCtx(true),
      visionModel: () => (available ? MODEL : undefined),
    } as unknown as ToolContext).view_image;
    available = false;
    await expect(
      executeOf(view)({ path: path.join(root, 'img.png') }, {}),
    ).rejects.toThrow(/view_image is not configured/);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('非图片扩展名被拒绝', async () => {
    const view = createViewTools(makeCtx(true)).view_image;
    await expect(executeOf(view)({ path: path.join(root, 'note.txt') }, {})).rejects.toThrow(
      /not a supported image type/,
    );
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('目录被拒绝', async () => {
    const view = createViewTools(makeCtx(true)).view_image;
    await expect(executeOf(view)({ path: root }, {})).rejects.toThrow(/is a directory/);
  });

  it('工作区外且不在只读扩根内的路径被沙箱拒绝', async () => {
    // root 用真实的临时目录——root:'/' 会让任何路径都"界内",断言就空转了。
    const view = createViewTools(makeCtx(true, root)).view_image;
    await expect(executeOf(view)({ path: '/etc/hosts.png' }, {})).rejects.toThrow(/outside/);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
