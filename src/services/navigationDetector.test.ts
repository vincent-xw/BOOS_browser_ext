import { describe, expect, it } from 'vitest';

import { detectUrlChange } from './navigationDetector';

describe('detectUrlChange', () => {
  it('未变化时返回 undefined', () => {
    expect(detectUrlChange('https://example.com/a', 'https://example.com/a')).toBeUndefined();
  });

  it('任一 URL 缺失时返回 undefined', () => {
    expect(detectUrlChange(undefined, 'https://example.com')).toBeUndefined();
    expect(detectUrlChange('https://example.com', undefined)).toBeUndefined();
    expect(detectUrlChange(undefined, undefined)).toBeUndefined();
  });

  it('跨域名导航返回 changedDomain 与提示', () => {
    const result = detectUrlChange('https://example.com/themes', 'https://github.com/owner/repo');
    expect(result).toBeDefined();
    expect(result?.changedDomain).toBe(true);
    expect(result?.from).toBe('https://example.com/themes');
    expect(result?.to).toBe('https://github.com/owner/repo');
    expect(result?.note).toContain('github.com');
    expect(result?.note).toContain('browser_go_back');
    expect(result?.note).toContain('未授权域名');
  });

  it('同域路径变化返回 changedDomain=false 与 ref 失效提示', () => {
    const result = detectUrlChange('https://example.com/themes', 'https://example.com/themes/dark');
    expect(result?.changedDomain).toBe(false);
    expect(result?.note).toContain('重新调用 browser_snapshot');
  });

  it('只有 query/hash 变化不算路径导航', () => {
    // host 与 pathname 都没变，只是 query 不同，不算导航（页面内容可能通过 AJAX 更新）。
    const result = detectUrlChange('https://example.com/search', 'https://example.com/search?q=vue');
    expect(result).toBeUndefined();
  });

  it('非法 URL 返回 undefined', () => {
    expect(detectUrlChange('not a url', 'https://example.com')).toBeUndefined();
  });

  it('子域名变化算跨域名', () => {
    const result = detectUrlChange('https://example.com', 'https://api.example.com');
    expect(result?.changedDomain).toBe(true);
    expect(result?.note).toContain('api.example.com');
  });
});
