/**
 * URL 白名单。
 *
 * 「防止用户过于自由」这层限制的实现。写操作在下发前必须过这道校验，
 * 且校验点在 Service Worker 侧 —— 放在 UI 侧的话，绕过 UI 直接发消息就失效了。
 */

/** 白名单在 chrome.storage.local 中的键。Service Worker 与设置界面共享同一份数据。 */
export const ALLOWLIST_STORAGE_KEY = 'boos.urlAllowlist';

/** 一条允许规则。domain 必填，路径限制可选。 */
export interface UrlAllowRule {
  /** 域名。支持 `*.example.com` 形式的子域通配。 */
  domain: string;
  /** 路径前缀。给出时要求 pathname 以此开头。 */
  pathPrefix?: string;
  /** 路径正则（字符串形式）。给出时要求 pathname 匹配。 */
  pathPattern?: string;
  /** 备注，仅用于 UI 展示。 */
  note?: string;
}

export interface AllowCheckResult {
  allowed: boolean;
  /** 命中的规则，便于 UI 说明「为什么放行」。 */
  matched?: UrlAllowRule;
  reason: string;
}

/** 解析 URL；非法或非 http(s) 协议一律视为不可用。 */
function parseUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    // 只允许 http(s)。chrome://、file:// 等一律拒绝——扩展不该在那些页面上做写操作。
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/** 域名是否匹配规则。支持前导 `*.` 通配子域。 */
export function matchesDomain(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const rule = pattern.trim().toLowerCase();
  if (!rule) return false;
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    // `*.example.com` 同时匹配 example.com 本身与其子域。
    return host === base || host.endsWith(`.${base}`);
  }
  return host === rule;
}

/** 路径是否匹配规则。两个路径条件都给出时需同时满足。 */
function matchesPath(pathname: string, rule: UrlAllowRule): { ok: boolean; reason?: string } {
  if (rule.pathPrefix && !pathname.startsWith(rule.pathPrefix)) {
    return { ok: false, reason: `路径不以 ${rule.pathPrefix} 开头` };
  }
  if (rule.pathPattern) {
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pathPattern);
    } catch {
      // 非法正则视为不匹配，而不是放行 —— 配置写错时应当更严格而非更宽松。
      return { ok: false, reason: `路径规则 ${rule.pathPattern} 不是合法正则` };
    }
    if (!regex.test(pathname)) return { ok: false, reason: `路径不匹配 ${rule.pathPattern}` };
  }
  return { ok: true };
}

/**
 * 判断 URL 是否被白名单允许。
 * 空白名单一律拒绝 —— 默认不允许任何写操作，用户必须显式添加域名。
 */
export function isUrlAllowed(rawUrl: string, rules: readonly UrlAllowRule[]): AllowCheckResult {
  const url = parseUrl(rawUrl);
  if (!url) {
    return { allowed: false, reason: `无法解析或不支持的地址：${rawUrl || '(空)'}。仅支持 http/https 页面。` };
  }
  if (rules.length === 0) {
    return { allowed: false, reason: '白名单为空。请先在设置中添加允许操作的域名。' };
  }

  const domainMatches = rules.filter((rule) => matchesDomain(url.hostname, rule.domain));
  if (domainMatches.length === 0) {
    return { allowed: false, reason: `域名 ${url.hostname} 不在白名单中。` };
  }

  const pathReasons: string[] = [];
  for (const rule of domainMatches) {
    const pathCheck = matchesPath(url.pathname, rule);
    if (pathCheck.ok) {
      return { allowed: true, matched: rule, reason: `命中白名单规则 ${describeRule(rule)}` };
    }
    if (pathCheck.reason) pathReasons.push(pathCheck.reason);
  }

  return {
    allowed: false,
    reason: `域名 ${url.hostname} 已在白名单，但路径 ${url.pathname} 不满足限制（${pathReasons.join('；')}）。`,
  };
}

/** 规则的可读描述，用于 UI 与日志。 */
export function describeRule(rule: UrlAllowRule): string {
  const parts = [rule.domain];
  if (rule.pathPrefix) parts.push(`前缀 ${rule.pathPrefix}`);
  if (rule.pathPattern) parts.push(`正则 ${rule.pathPattern}`);
  return parts.join(' + ');
}

/** 规则是否可用。domain 为空的规则会被静默忽略，需要在保存时挡掉。 */
export function validateRule(rule: UrlAllowRule): { valid: boolean; issue?: string } {
  if (!rule.domain.trim()) return { valid: false, issue: '域名不能为空。' };
  if (/\s/.test(rule.domain.trim())) return { valid: false, issue: '域名不能包含空格。' };
  if (rule.pathPrefix && !rule.pathPrefix.startsWith('/')) {
    return { valid: false, issue: '路径前缀必须以 / 开头。' };
  }
  if (rule.pathPattern) {
    try {
      new RegExp(rule.pathPattern);
    } catch {
      return { valid: false, issue: `路径正则不合法：${rule.pathPattern}` };
    }
  }
  return { valid: true };
}

/** 从 URL 生成一条最小规则，供「添加当前站点」这类快捷操作使用。 */
export function ruleFromUrl(rawUrl: string): UrlAllowRule | null {
  const url = parseUrl(rawUrl);
  if (!url) return null;
  return { domain: url.hostname };
}

/**
 * 白名单涉及的 host 权限模式，用于 chrome.permissions.request。
 * `*.example.com` 与裸域名在 match pattern 里的写法一致，都是 `*://<domain>/*`；
 * 裸域名不会自动覆盖子域，这与 isUrlAllowed 的判定保持一致。
 */
export function toHostPermissions(rules: readonly UrlAllowRule[]): string[] {
  const patterns = new Set<string>();
  for (const rule of rules) {
    const domain = rule.domain.trim().toLowerCase();
    if (!domain) continue;
    patterns.add(`*://${domain}/*`);
  }
  return [...patterns];
}
