import process from 'node:process';
import { execa } from 'execa';
import { downscaleImage } from './image.js';

/**
 * 读取系统剪贴板中的图片,供输入框 ctrl+v 粘贴使用。
 *
 * 所有平台路径都不抛错:返回 undefined 统一表示"剪贴板里没有图片/读不
 * 到",由调用方决定如何提示。macOS 是主平台;Linux(wl-paste/xclip)与
 * Windows(PowerShell)尽力支持。
 */

export interface ClipboardImage {
  mediaType: string;
  /** base64——与 ImageAttachment.data 相同的 JSONL 往返约束。 */
  data: string;
}

const TIMEOUT = 3000;

/**
 * 把文本写入系统剪贴板,TUI 内拖选自动复制用。成功返回 true;命令缺失、
 * 超时等一律返回 false 不抛错——调用方(kit.useSelectionCopy)还有 OSC 52
 * 兜底,SSH 场景下本地命令写的本来就是远端的剪贴板,靠的正是那条路。
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  const commands: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'linux'
        ? [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
          ]
        : process.platform === 'win32'
          ? [['clip', []]]
          : [];
  for (const [command, args] of commands) {
    const result = await execa(command, args, {
      input: text,
      reject: false,
      timeout: TIMEOUT,
    });
    if (result.exitCode === 0) return true;
  }
  return false;
}

export async function readClipboardImage(): Promise<ClipboardImage | undefined> {
  try {
    const image = await readPlatform();
    // 截图往往是 Retina 全屏尺寸,降采样在这里做,让所有调用方都受益。
    return image ? await downscaleImage(image) : undefined;
  } catch {
    return undefined;
  }
}

function readPlatform(): Promise<ClipboardImage | undefined> {
  switch (process.platform) {
    case 'darwin':
      return readDarwin();
    case 'linux':
      return readLinux();
    case 'win32':
      return readWindows();
    default:
      return Promise.resolve(undefined);
  }
}

/**
 * macOS:`osascript -e 'the clipboard as «class PNGf»'` 把图片以
 * `«data PNGf<hex>»` 文本吐出。选 hex 解析而不是写临时文件:没有文件
 * 生命周期和路径转义问题,execa 默认 maxBuffer(100MB)装得下截图的 hex。
 * PNG 拿不到时(如从别处复制的 JPEG)回退 JPEG。
 */
async function readDarwin(): Promise<ClipboardImage | undefined> {
  for (const [cls, mediaType] of [
    ['PNGf', 'image/png'],
    ['JPEG', 'image/jpeg'],
  ] as const) {
    const result = await execa('osascript', ['-e', `the clipboard as «class ${cls}»`], {
      reject: false,
      timeout: TIMEOUT,
    });
    if (result.exitCode !== 0) continue;
    const image = parseOsascriptData(result.stdout, mediaType);
    if (image) return image;
  }
  return undefined;
}

/** 解析 osascript 的 `«data PNGf89504E47…»` 输出。导出供测试。 */
export function parseOsascriptData(
  stdout: string,
  mediaType: string,
): ClipboardImage | undefined {
  const match = /«data \w{4}([0-9A-Fa-f]+)»/.exec(stdout.trim());
  if (!match || match[1]!.length % 2 !== 0) return undefined;
  const data = Buffer.from(match[1]!, 'hex').toString('base64');
  if (!data) return undefined;
  return { mediaType, data };
}

/** Linux:Wayland 优先 wl-paste,否则 xclip。工具缺失即视为无图片。 */
async function readLinux(): Promise<ClipboardImage | undefined> {
  const command = process.env['WAYLAND_DISPLAY']
    ? (['wl-paste', ['--type', 'image/png']] as const)
    : (['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']] as const);
  const result = await execa(command[0], [...command[1]], {
    reject: false,
    timeout: TIMEOUT,
    encoding: 'buffer',
  });
  if (result.exitCode !== 0 || result.stdout.length === 0) return undefined;
  return { mediaType: 'image/png', data: Buffer.from(result.stdout).toString('base64') };
}

/** Windows:PowerShell 从剪贴板取图并直接输出 base64。 */
async function readWindows(): Promise<ClipboardImage | undefined> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$img = [System.Windows.Forms.Clipboard]::GetImage();',
    'if ($img -eq $null) { exit 1 };',
    '$ms = New-Object System.IO.MemoryStream;',
    '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);',
    '[Convert]::ToBase64String($ms.ToArray())',
  ].join(' ');
  const result = await execa('powershell', ['-NoProfile', '-Command', script], {
    reject: false,
    timeout: TIMEOUT,
  });
  const data = result.stdout.trim();
  if (result.exitCode !== 0 || !data) return undefined;
  return { mediaType: 'image/png', data };
}
