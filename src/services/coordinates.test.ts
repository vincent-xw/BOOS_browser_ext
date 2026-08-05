import { describe, expect, it } from 'vitest';

import {
  elementCenterInMainFrame,
  isPointInViewport,
  isRectInViewport,
  rectCenter,
  roundPoint,
  toMainFrameCoords,
} from './coordinates';

describe('rectCenter', () => {
  it('取矩形中心点', () => {
    expect(rectCenter({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 60, y: 40 });
  });

  it('零尺寸矩形中心为其原点', () => {
    expect(rectCenter({ x: 5, y: 7, width: 0, height: 0 })).toEqual({ x: 5, y: 7 });
  });
});

describe('坐标契约：不乘 devicePixelRatio', () => {
  // 这是整个 CDP 方案最容易错的一点。乘了 DPR 在 Retina 上会点到约两倍偏移处，
  // 且因为通常仍落在页面某个元素上，症状是「点了但点错」而不是报错。
  it('devicePixelRatio 为 2 时坐标与 CSS 像素一致', () => {
    const originalDpr = globalThis.devicePixelRatio;
    Object.defineProperty(globalThis, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const rect = { x: 100, y: 200, width: 80, height: 40 };
      expect(elementCenterInMainFrame(rect)).toEqual({ x: 140, y: 220 });
    } finally {
      Object.defineProperty(globalThis, 'devicePixelRatio', { value: originalDpr, configurable: true });
    }
  });

  it('devicePixelRatio 为 3 时结果不变', () => {
    const originalDpr = globalThis.devicePixelRatio;
    Object.defineProperty(globalThis, 'devicePixelRatio', { value: 3, configurable: true });
    try {
      expect(elementCenterInMainFrame({ x: 0, y: 0, width: 200, height: 100 })).toEqual({ x: 100, y: 50 });
    } finally {
      Object.defineProperty(globalThis, 'devicePixelRatio', { value: originalDpr, configurable: true });
    }
  });

  it('输出与 getBoundingClientRect 的 CSS 像素严格相等', () => {
    const rect = { x: 12.5, y: 34.5, width: 15, height: 21 };
    expect(elementCenterInMainFrame(rect)).toEqual({ x: 20, y: 45 });
  });
});

describe('toMainFrameCoords', () => {
  it('主 frame 内坐标不变', () => {
    expect(toMainFrameCoords({ x: 30, y: 40 })).toEqual({ x: 30, y: 40 });
  });

  it('单层 frame 偏移叠加', () => {
    expect(toMainFrameCoords({ x: 30, y: 40 }, [{ x: 100, y: 50 }])).toEqual({ x: 130, y: 90 });
  });

  it('多层嵌套 frame 逐层叠加', () => {
    expect(
      toMainFrameCoords({ x: 10, y: 10 }, [
        { x: 100, y: 100 },
        { x: 20, y: 30 },
      ]),
    ).toEqual({ x: 130, y: 140 });
  });

  it('负偏移（frame 被滚出视口）同样叠加', () => {
    expect(toMainFrameCoords({ x: 50, y: 50 }, [{ x: -20, y: -80 }])).toEqual({ x: 30, y: -30 });
  });
});

describe('elementCenterInMainFrame', () => {
  it('把子 frame 内元素中心换算到主页面坐标系', () => {
    const rect = { x: 10, y: 20, width: 100, height: 40 };
    expect(elementCenterInMainFrame(rect, [{ x: 200, y: 300 }])).toEqual({ x: 260, y: 340 });
  });
});

describe('isRectInViewport', () => {
  const viewport = { width: 1280, height: 800 };

  it('完全在视口内', () => {
    expect(isRectInViewport({ x: 100, y: 100, width: 50, height: 50 }, viewport)).toBe(true);
  });

  it('部分相交视为在视口内', () => {
    expect(isRectInViewport({ x: -10, y: 100, width: 50, height: 50 }, viewport)).toBe(true);
  });

  it('完全在视口下方', () => {
    expect(isRectInViewport({ x: 100, y: 900, width: 50, height: 50 }, viewport)).toBe(false);
  });

  it('完全在视口右侧', () => {
    expect(isRectInViewport({ x: 1300, y: 100, width: 50, height: 50 }, viewport)).toBe(false);
  });

  it('零尺寸元素视为不可见', () => {
    expect(isRectInViewport({ x: 100, y: 100, width: 0, height: 50 }, viewport)).toBe(false);
    expect(isRectInViewport({ x: 100, y: 100, width: 50, height: 0 }, viewport)).toBe(false);
  });
});

describe('isPointInViewport', () => {
  const viewport = { width: 1280, height: 800 };

  it('视口内的点', () => {
    expect(isPointInViewport({ x: 640, y: 400 }, viewport)).toBe(true);
  });

  it('边界上的点算在内', () => {
    expect(isPointInViewport({ x: 0, y: 0 }, viewport)).toBe(true);
    expect(isPointInViewport({ x: 1280, y: 800 }, viewport)).toBe(true);
  });

  it('负坐标不在视口内', () => {
    expect(isPointInViewport({ x: -1, y: 400 }, viewport)).toBe(false);
  });

  it('超出视口的点不在视口内', () => {
    expect(isPointInViewport({ x: 640, y: 801 }, viewport)).toBe(false);
  });
});

describe('roundPoint', () => {
  it('四舍五入到整数', () => {
    expect(roundPoint({ x: 10.4, y: 20.6 })).toEqual({ x: 10, y: 21 });
  });
});
