/**
 * 图片的纯派生工具。放在 utils/ 而不是 composer/:时间线与大图预览都用它,
 * 而 composer/use-attachments.ts 是个带 useState 的 hook 模块——为一句模板
 * 字符串把 React hook 拉进这两条 import 链没有道理。
 */

import type { TimelineImage } from '@core/types';

/**
 * data URI 是整份 base64 的又一份拷贝(单张可达数 MB),按图片对象的身份
 * 记忆:时间线条目不可变、附件数组只追加/过滤,同一张图的引用是稳定的。
 * 没有缓存时,Composer 每敲一个键、UserEntry 每开一次大图,都会把每张图
 * 重新拼一遍。WeakMap 随图片本身回收,不会自己变成泄漏。
 */
const uriCache = new WeakMap<TimelineImage, string>();

export function imageDataUri(image: TimelineImage): string {
  let uri = uriCache.get(image);
  if (uri === undefined) {
    uri = `data:${image.mediaType};base64,${image.data}`;
    uriCache.set(image, uri);
  }
  return uri;
}
