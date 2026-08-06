import { describe, expect, it } from 'vitest';

import { parseSelectorList } from './domLocator';

describe('parseSelectorList', () => {
  it('按逗号拆分并去除空白', () => {
    expect(parseSelectorList('.a, .b ,.c')).toEqual(['.a', '.b', '.c']);
  });

  it('去重', () => {
    expect(parseSelectorList('.a, .a, .b')).toEqual(['.a', '.b']);
  });

  it('空值返回空数组', () => {
    expect(parseSelectorList(undefined)).toEqual([]);
    expect(parseSelectorList('')).toEqual([]);
    expect(parseSelectorList('  ,  ')).toEqual([]);
  });

  it('保留选择器内部的空格（后代选择器）', () => {
    // `.a .b` 是合法的后代选择器，不能被当成两个选择器拆开。
    expect(parseSelectorList('.a .b, .c')).toEqual(['.a .b', '.c']);
  });
});
