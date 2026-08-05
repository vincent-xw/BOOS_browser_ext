import { ALLOWLIST_STORAGE_KEY, toHostPermissions, validateRule } from './urlAllowlist';
import type { UrlAllowRule } from './urlAllowlist';

/**
 * 白名单与域名权限。
 *
 * 两件事必须同时成立才能在某个域名上工作：
 * 1. 用户已把该域名加入白名单（Service Worker 侧校验写操作时看这个）
 * 2. 扩展已取得该域名的 host 权限（否则 content script 注入与 CDP 都够不着）
 *
 * 权限走 optional_host_permissions + 运行时申请：安装时不索取「读取所有网站数据」。
 */

/** 动态注册的 content script id。注册前先注销同 id 的旧项。 */
const DYNAMIC_SCRIPT_ID = 'boos-dynamic-content';

export async function loadAllowRules(): Promise<UrlAllowRule[]> {
  try {
    const stored = await chrome.storage.local.get(ALLOWLIST_STORAGE_KEY);
    const value = stored[ALLOWLIST_STORAGE_KEY];
    return Array.isArray(value) ? (value as UrlAllowRule[]) : [];
  } catch {
    return [];
  }
}

async function persistAllowRules(rules: UrlAllowRule[]): Promise<void> {
  await chrome.storage.local.set({ [ALLOWLIST_STORAGE_KEY]: rules });
}

/** 已取得 host 权限的域名模式。 */
export async function grantedHostPatterns(): Promise<string[]> {
  try {
    const permissions = await chrome.permissions.getAll();
    return permissions.origins ?? [];
  } catch {
    return [];
  }
}

/** 某条规则的 host 权限是否已授予。 */
export async function hasPermissionFor(rule: UrlAllowRule): Promise<boolean> {
  const origins = toHostPermissions([rule]);
  if (origins.length === 0) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * 添加一条白名单规则，并在需要时申请对应的 host 权限。
 *
 * 权限申请必须由用户手势触发（点击「添加」按钮），因此这个函数只能从 UI 事件里调用。
 */
export async function addAllowRule(rule: UrlAllowRule): Promise<{ ok: boolean; message: string }> {
  const validation = validateRule(rule);
  if (!validation.valid) return { ok: false, message: validation.issue ?? '规则不合法。' };

  const origins = toHostPermissions([rule]);
  let granted = true;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch (error) {
    return { ok: false, message: `申请域名权限失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!granted) {
    return { ok: false, message: `未获得 ${rule.domain} 的访问权限，该域名不会被加入白名单。` };
  }

  const rules = await loadAllowRules();
  // 同 domain + 同路径限制视为重复，避免白名单里堆积等价规则。
  const duplicate = rules.some(
    (existing) =>
      existing.domain.trim().toLowerCase() === rule.domain.trim().toLowerCase() &&
      (existing.pathPrefix ?? '') === (rule.pathPrefix ?? '') &&
      (existing.pathPattern ?? '') === (rule.pathPattern ?? ''),
  );
  if (duplicate) return { ok: false, message: '该规则已存在。' };

  await persistAllowRules([...rules, rule]);
  await syncContentScripts();
  return { ok: true, message: `已允许 ${rule.domain}。` };
}

/** 移除一条白名单规则。不撤销 host 权限 —— 用户可能还有别的规则用着同一域名。 */
export async function removeAllowRule(index: number): Promise<void> {
  const rules = await loadAllowRules();
  if (index < 0 || index >= rules.length) return;
  const next = rules.filter((_, position) => position !== index);
  await persistAllowRules(next);
  await syncContentScripts();
}

/**
 * 把 content script 的注册范围同步到当前白名单。
 *
 * 静态声明的 matches 只覆盖 zhipin.com，动态注册让它跟着白名单走 ——
 * 这样目标页面一打开就有脚本，不必每次靠按需注入兜底。
 */
export async function syncContentScripts(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;
  const rules = await loadAllowRules();
  const matches = toHostPermissions(rules);

  // 先注销旧注册项：注册是幂等的，但同 id 重复注册会抛错。
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  } catch {
    // 尚未注册过，忽略。
  }
  if (matches.length === 0) return;

  // 只对已授权的域名注册，未授权的 match pattern 会让整次注册失败。
  const authorized: string[] = [];
  for (const match of matches) {
    try {
      if (await chrome.permissions.contains({ origins: [match] })) authorized.push(match);
    } catch {
      // 忽略无法判定的项。
    }
  }
  if (authorized.length === 0) return;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: DYNAMIC_SCRIPT_ID,
        matches: authorized,
        js: ['content-scripts/content.js'],
        allFrames: true,
        runAt: 'document_idle',
      },
    ]);
  } catch (error) {
    console.warn('[BOOS] 动态注册 content script 失败：', error);
  }
}

export type { UrlAllowRule };
