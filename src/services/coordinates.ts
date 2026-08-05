import type { ElementRect } from '../types/cdp';

/**
 * 坐标换算。独立成纯函数模块的唯一原因是要能单测 ——
 * 坐标乘错 devicePixelRatio 的症状是「点了但点错、且不报错」，人工几乎发现不了。
 *
 * 契约：所有返回值都是相对主页面 viewport 的 CSS 像素，**绝不乘 devicePixelRatio**。
 * CDP Input.dispatchMouseEvent 的 x/y 定义就是主页面 viewport 的 CSS 像素。
 */

/** 单个 frame 相对其父 frame 的偏移，CSS 像素。 */
export interface FrameOffset {
  x: number;
  y: number;
}

/** 取矩形中心点。 */
export function rectCenter(rect: ElementRect): { x: number; y: number } {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

/**
 * 把子 frame 内的坐标换算到主页面坐标系。
 * offsets 按 frame 层级从外到内排列；主 frame 内的元素传空数组即可。
 */
export function toMainFrameCoords(
  local: { x: number; y: number },
  offsets: readonly FrameOffset[] = [],
): { x: number; y: number } {
  let { x, y } = local;
  for (const offset of offsets) {
    x += offset.x;
    y += offset.y;
  }
  return { x, y };
}

/** 元素中心点在主页面坐标系中的位置。 */
export function elementCenterInMainFrame(
  rect: ElementRect,
  offsets: readonly FrameOffset[] = [],
): { x: number; y: number } {
  return toMainFrameCoords(rectCenter(rect), offsets);
}

/** 判断矩形是否与视口相交。零宽或零高视为不可见。 */
export function isRectInViewport(
  rect: ElementRect,
  viewport: { width: number; height: number },
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

/** 坐标是否落在视口内。CDP 对视口外坐标不会报错，只是点不到东西。 */
export function isPointInViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height;
}

/** 四舍五入到整数像素。CDP 接受小数，但整数更利于日志比对。 */
export function roundPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}
