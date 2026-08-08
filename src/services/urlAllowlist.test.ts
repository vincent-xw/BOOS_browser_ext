import { describe, expect, it } from 'vitest';

import { describeRule, isUrlAllowed, matchesDomain, ruleFromUrl, toHostPermissions, validateRule } from './urlAllowlist';
import type { UrlAllowRule } from './urlAllowlist';

const example: UrlAllowRule = { domain: 'example.com' };

describe('matchesDomain', () => {
  it('精确匹配', () => {
    expect(matchesDomain('example.com', 'example.com')).toBe(true);
    expect(matchesDomain('other.com', 'example.com')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(matchesDomain('EXAMPLE.com', 'example.COM')).toBe(true);
  });

  it('裸域名不匹配子域', () => {
    // 显式限制：加了 example.com 不等于放开 evil.example.com。
    expect(matchesDomain('sub.example.com', 'example.com')).toBe(false);
  });

  it('通配同时匹配基域与子域', () => {
    expect(matchesDomain('example.com', '*.example.com')).toBe(true);
    expect(matchesDomain('sub.example.com', '*.example.com')).toBe(true);
    expect(matchesDomain('a.b.example.com', '*.example.com')).toBe(true);
  });

  it('通配不匹配同后缀的其他域名', () => {
    // notexample.com 不应被 *.example.com 命中。
    expect(matchesDomain('notexample.com', '*.example.com')).toBe(false);
  });

  it('空规则不匹配任何域名', () => {
    expect(matchesDomain('example.com', '')).toBe(false);
    expect(matchesDomain('example.com', '   ')).toBe(false);
  });
});

describe('isUrlAllowed', () => {
  it('空白名单一律拒绝', () => {
    // 默认不允许任何写操作，用户必须显式添加域名。
    const result = isUrlAllowed('https://example.com/', []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('白名单为空');
  });

  it('域名命中即放行', () => {
    expect(isUrlAllowed('https://example.com/any/path', [example]).allowed).toBe(true);
  });

  it('域名不在白名单则拒绝', () => {
    const result = isUrlAllowed('https://evil.com/', [example]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('evil.com');
  });

  it('拒绝非 http(s) 协议', () => {
    // chrome:// 与 file:// 页面不该被写操作触及。
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'about:blank']) {
      expect(isUrlAllowed(url, [{ domain: 'settings' }]).allowed, url).toBe(false);
    }
  });

  it('拒绝无法解析的地址', () => {
    expect(isUrlAllowed('', [example]).allowed).toBe(false);
    expect(isUrlAllowed('not a url', [example]).allowed).toBe(false);
  });

  it('路径前缀满足时放行', () => {
    const rules = [{ domain: 'example.com', pathPrefix: '/app' }];
    expect(isUrlAllowed('https://example.com/app/page', rules).allowed).toBe(true);
  });

  it('路径前缀不满足时拒绝并说明原因', () => {
    const rules = [{ domain: 'example.com', pathPrefix: '/app' }];
    const result = isUrlAllowed('https://example.com/admin', rules);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('/app');
  });

  it('路径正则满足时放行', () => {
    const rules = [{ domain: 'example.com', pathPattern: '^/search' }];
    expect(isUrlAllowed('https://example.com/search?q=1', rules).allowed).toBe(true);
  });

  it('非法路径正则视为不匹配而非放行', () => {
    // 配置写错时应更严格，不能因为规则坏了就放开。
    const rules = [{ domain: 'example.com', pathPattern: '[unclosed' }];
    expect(isUrlAllowed('https://example.com/x', rules).allowed).toBe(false);
  });

  it('同域多条规则中任一满足即放行', () => {
    const rules = [
      { domain: 'example.com', pathPrefix: '/admin' },
      { domain: 'example.com', pathPrefix: '/app' },
    ];
    expect(isUrlAllowed('https://example.com/app/x', rules).allowed).toBe(true);
  });

  it('放行时返回命中的规则', () => {
    const rule = { domain: 'example.com', pathPrefix: '/app' };
    expect(isUrlAllowed('https://example.com/app', [rule]).matched).toEqual(rule);
  });

  it('端口不影响域名判定', () => {
    expect(isUrlAllowed('http://localhost:8787/x', [{ domain: 'localhost' }]).allowed).toBe(true);
  });
});

describe('validateRule', () => {
  it('接受合法规则', () => {
    expect(validateRule({ domain: 'example.com' }).valid).toBe(true);
    expect(validateRule({ domain: '*.example.com', pathPrefix: '/app' }).valid).toBe(true);
  });

  it('拒绝空域名', () => {
    expect(validateRule({ domain: '' }).valid).toBe(false);
    expect(validateRule({ domain: '   ' }).valid).toBe(false);
  });

  it('拒绝含空格的域名', () => {
    expect(validateRule({ domain: 'exa mple.com' }).valid).toBe(false);
  });

  it('要求路径前缀以 / 开头', () => {
    expect(validateRule({ domain: 'example.com', pathPrefix: 'app' }).valid).toBe(false);
  });

  it('拒绝非法路径正则', () => {
    const result = validateRule({ domain: 'example.com', pathPattern: '[unclosed' });
    expect(result.valid).toBe(false);
    expect(result.issue).toContain('正则');
  });
});

describe('ruleFromUrl', () => {
  it('从 URL 提取域名', () => {
    expect(ruleFromUrl('https://example.com/some/path?q=1')).toEqual({ domain: 'example.com' });
  });

  it('非法地址返回 null', () => {
    expect(ruleFromUrl('chrome://settings')).toBeNull();
    expect(ruleFromUrl('nonsense')).toBeNull();
  });
});

describe('toHostPermissions', () => {
  it('生成 match pattern', () => {
    expect(toHostPermissions([{ domain: 'example.com' }])).toEqual(['*://example.com/*']);
  });

  it('保留子域通配', () => {
    expect(toHostPermissions([{ domain: '*.example.com' }])).toEqual(['*://*.example.com/*']);
  });

  it('同域名去重', () => {
    const rules = [
      { domain: 'example.com', pathPrefix: '/a' },
      { domain: 'example.com', pathPrefix: '/b' },
    ];
    expect(toHostPermissions(rules)).toEqual(['*://example.com/*']);
  });

  it('忽略空域名', () => {
    expect(toHostPermissions([{ domain: '  ' }])).toEqual([]);
  });
});

describe('describeRule', () => {
  it('只有域名时只显示域名', () => {
    expect(describeRule({ domain: 'example.com' })).toBe('example.com');
  });

  it('带路径限制时一并显示', () => {
    expect(describeRule({ domain: 'example.com', pathPrefix: '/app' })).toContain('/app');
    expect(describeRule({ domain: 'example.com', pathPattern: '^/x' })).toContain('^/x');
  });
});
