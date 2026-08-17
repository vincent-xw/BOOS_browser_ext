/**
 * 域名权限管理。
 *
 * 扩展需要 host 权限才能注入 content script 和使用 CDP debugger。
 * 权限走 optional_host_permissions + 运行时申请：安装时不索取「读取所有网站数据」。
 */

/** 动态注册的 content script id。注册前先注销同 id 的旧项。 */
const DYNAMIC_SCRIPT_ID = 'boos-dynamic-content';

/** 已取得 host 权限的域名模式。 */
export async function grantedHostPatterns(): Promise<string[]> {
  try {
    const permissions = await chrome.permissions.getAll();
    return permissions.origins ?? [];
  } catch {
    return [];
  }
}

/**
 * 为指定 URL 申请 host 权限。
 *
 * 注意：chrome.permissions.request 必须由用户手势触发，所以这个函数只能从
 * 按钮点击等 UI 事件里调用，不能在自动流程里直接调。
 */
export async function requestPermissionForUrl(url: string): Promise<{ ok: boolean; message: string; origin?: string }> {
  let origin: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: `不支持的协议：${parsed.protocol}` };
    }
    origin = `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return { ok: false, message: '无法解析当前页面地址。' };
  }

  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) return { ok: false, message: '未获得授权。' };
    await syncContentScripts();
    return { ok: true, message: '授权成功。', origin };
  } catch (error) {
    return { ok: false, message: `申请域名权限失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 判断某 URL 是否已授予 host 权限。 */
export async function hasUrlPermission(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return await chrome.permissions.contains({ origins: [`${parsed.protocol}//${parsed.host}/*`] });
  } catch {
    return false;
  }
}

/**
 * 把 content script 注册到已授权的域名上。
 * 页面打开时自动注入脚本，不必每次靠按需注入兜底。
 */
export async function syncContentScripts(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  } catch {
    // 尚未注册过，忽略。
  }

  const permissions = await chrome.permissions.getAll();
  const origins = (permissions.origins ?? []).filter((o) => o.startsWith('http'));
  if (origins.length === 0) return;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: DYNAMIC_SCRIPT_ID,
        matches: origins,
        js: ['content-scripts/content.js'],
        allFrames: true,
        runAt: 'document_idle',
      },
    ]);
  } catch (error) {
    console.warn('[BOOS] 注册 content script 失败：', error);
  }
}