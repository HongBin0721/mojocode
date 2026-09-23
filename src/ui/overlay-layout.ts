/**
 * `ui.custom(…, { overlay: true })` 的布局算法:把 Pi 形状的 OverlayOptions 按
 * 终端尺寸算成一个绝对定位的矩形。纯函数、Node-free、不碰 kit——App 只拿结果
 * 往 `<Box position="absolute">` 上放,核心测试也能直接考它。
 *
 * 规则(与 Pi 的 tui.md 一致):
 *  - 尺寸:数字是格数,`"50%"` 按终端算;夹在 min/max 之间,再夹进 margin 之内;
 *    高度不给就 `undefined`(由内容撑,最多到 maxHeight);
 *  - 位置:`row`/`col` 给了按绝对放(百分比同样按终端算),否则按 `anchor`
 *    (缺省居中)加 `offsetX/Y`;
 *  - 最后整块夹回 margin 之内,绝不让覆盖层探出终端。
 */

import type { OverlayAnchor, OverlayOptions, UiCustomRequest } from '../core/extension-types.js';

/**
 * 直接展开到 `<Box position="absolute">` 上的矩形。没给高度时**不带** `height`
 * 键(由内容撑,`maxHeight` 封顶)——`height: undefined` 在 Box 上与不传不同。
 * 画不画不在这里:那是 `overlayShown` 的事,画框与收键共用它一个判据。
 */
export interface OverlayLayout {
  left: number;
  top: number;
  width: number;
  height?: number;
  maxHeight: number;
}

/** 缺省宽度:终端的六成——与 Pi 的缺省一样"像个对话框"而不是一整屏。 */
const DEFAULT_WIDTH_RATIO = 0.6;
/** 一条边最少留给内容的格数(边框占 2)。 */
const MIN_CELLS = 4;

function resolveSize(value: number | `${number}%` | undefined, total: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Math.round(value);
  const pct = Number.parseFloat(value);
  return Number.isFinite(pct) ? Math.round((total * pct) / 100) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function margins(margin: OverlayOptions['margin']): { top: number; right: number; bottom: number; left: number } {
  if (margin === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof margin === 'number') return { top: margin, right: margin, bottom: margin, left: margin };
  return { top: margin.top ?? 0, right: margin.right ?? 0, bottom: margin.bottom ?? 0, left: margin.left ?? 0 };
}

/**
 * 一个方向上的边距放不下了(终端比「两边 margin + 最小内容」还窄):整对让掉。
 * 不让的话可用区是负数,最后那次夹取的上界比下界还小,框就被推出终端右/下沿。
 */
function fitMargins(a: number, b: number, total: number): [number, number] {
  return total - a - b >= MIN_CELLS ? [a, b] : [0, 0];
}

/**
 * 锚点 → 可用区里的比例位置(0 = 贴左/上,0.5 = 居中,1 = 贴右/下)。Pi 的命名
 * 角落是「竖-横」(top-left),边是「横-center」(right-center),所以不按位置
 * 拆,按词找。
 */
function anchorRatio(anchor: OverlayAnchor): { x: number; y: number } {
  const parts = anchor.split('-');
  const x = parts.includes('left') ? 0 : parts.includes('right') ? 1 : 0.5;
  const y = parts.includes('top') ? 0 : parts.includes('bottom') ? 1 : 0.5;
  return { x, y };
}

/** 请求上挂着的选项(函数形态现取)。 */
export function overlayOptionsOf(request: Pick<UiCustomRequest, 'overlay'>): OverlayOptions {
  const overlay = request.overlay;
  return typeof overlay === 'function' ? overlay() : (overlay ?? {});
}

/**
 * 这个覆盖层此刻画不画——把手 `setHidden(true)`、或 `visible(w, h)` 说了不画,
 * 都算不画。**画框与收键共用这一个判据**:藏起来的覆盖层若还收键,用户看到的
 * 是一个灰掉却不能打字的输入框,而屏幕上没有任何东西解释为什么。
 */
export function overlayShown(
  request: Pick<UiCustomRequest, 'overlay' | 'hidden'>,
  termWidth: number,
  termHeight: number,
): boolean {
  if (request.overlay === undefined || request.hidden) return false;
  const visible = overlayOptionsOf(request).visible;
  return visible ? visible(termWidth, termHeight) : true;
}

/**
 * `contentHeight` 是内容撑出来的框高(行数 + 边框),没给高度时靠它定位——
 * 不给的话只能按封顶高度算,居中与贴底的覆盖层就全都贴到了顶上。
 */
export function resolveOverlayLayout(
  options: OverlayOptions,
  termWidth: number,
  termHeight: number,
  contentHeight?: number,
): OverlayLayout {
  const m = margins(options.margin);
  const [ml, mr] = fitMargins(m.left, m.right, termWidth);
  const [mt, mb] = fitMargins(m.top, m.bottom, termHeight);
  const availWidth = Math.max(1, termWidth - ml - mr);
  const availHeight = Math.max(1, termHeight - mt - mb);

  const maxWidth = clamp(resolveSize(options.maxWidth, termWidth) ?? availWidth, 1, availWidth);
  const minWidth = Math.min(Math.max(MIN_CELLS, options.minWidth ?? 0), maxWidth);
  const width = clamp(
    resolveSize(options.width, termWidth) ?? Math.round(termWidth * DEFAULT_WIDTH_RATIO),
    minWidth,
    maxWidth,
  );

  const maxHeight = clamp(resolveSize(options.maxHeight, termHeight) ?? availHeight, 1, availHeight);
  const minHeight = Math.min(Math.max(MIN_CELLS, options.minHeight ?? 0), maxHeight);
  const explicitHeight = resolveSize(options.height, termHeight);
  const height = explicitHeight === undefined ? undefined : clamp(explicitHeight, minHeight, maxHeight);
  // 定位用的框高:给了高度用它;没给就用内容撑出来的高度;连内容都还没量
  // (第一帧)才按封顶算——宁可第一帧靠上一点,也别把底边顶出终端。
  const boxHeight = height ?? (contentHeight === undefined ? maxHeight : clamp(contentHeight, minHeight, maxHeight));

  // row / col 给了哪个,哪个方向就按绝对位置放,另一个方向照锚点算;给了绝对
  // 位置时缺省锚点是左上(Pi 同义),否则居中。
  const row = resolveSize(options.row, termHeight);
  const col = resolveSize(options.col, termWidth);
  const ratio = anchorRatio(options.anchor ?? (row !== undefined || col !== undefined ? 'top-left' : 'center'));
  const left = col ?? ml + Math.round((availWidth - width) * ratio.x);
  const top = row ?? mt + Math.round((availHeight - boxHeight) * ratio.y);
  // width ≤ availWidth、boxHeight ≤ availHeight,所以上界永远不小于下界:框绝不探出终端。
  return {
    left: clamp(left + (options.offsetX ?? 0), ml, termWidth - mr - width),
    top: clamp(top + (options.offsetY ?? 0), mt, termHeight - mb - boxHeight),
    width,
    ...(height !== undefined ? { height } : {}),
    maxHeight,
  };
}
