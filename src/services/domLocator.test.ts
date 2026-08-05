import { describe, expect, it } from 'vitest';

import { parseSelectorList, ROLE_FALLBACK_SELECTORS } from './domLocator';

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
});

describe('站点兜底选择器', () => {
  // 用户配置未命中时必须有兜底，这条能力不得移除。
  it('覆盖全部元素角色', () => {
    expect(Object.keys(ROLE_FALLBACK_SELECTORS).sort()).toEqual([
      'candidateListItem',
      'candidateName',
      'dialog',
      'favoriteButton',
      'greetButton',
      'messageInput',
      'resumeContainer',
      'sendButton',
    ]);
  });

  it('每个角色都有非空选择器', () => {
    for (const [role, selector] of Object.entries(ROLE_FALLBACK_SELECTORS)) {
      expect(parseSelectorList(selector).length, `${role} 缺少兜底选择器`).toBeGreaterThan(0);
    }
  });

  it('保留既有的 BOSS 站点关键选择器', () => {
    // 这些是原 chromeMcpService 里 BOSS_FALLBACK_SELECTORS 的值，迁移时不能丢。
    expect(ROLE_FALLBACK_SELECTORS.candidateListItem).toContain('li.card-item');
    expect(ROLE_FALLBACK_SELECTORS.resumeContainer).toContain('canvas#resume');
    expect(ROLE_FALLBACK_SELECTORS.favoriteButton).toContain('.like-icon-and-text');
    expect(ROLE_FALLBACK_SELECTORS.favoriteButton).toContain('button[ka=like]');
  });
});
