/**
 * 页面操作能力诊断。
 *
 * 检查三件自由指令运行所必需的事：能否拿到活动标签页、能否注入脚本、
 * debugger 权限与占用情况、content script 是否就绪。
 * 不读取任何业务数据。
 */

import { MessageType } from '../types/messages';

export interface DiagnosticResult {
  canQueryActiveTab: boolean;
  canExecuteScript: boolean;
  hostPermissionOk: boolean;
  /** debugger 权限是否已授予。没有它所有页面写操作都不可用。 */
  debuggerPermissionOk: boolean;
  /** 该标签页当前是否已挂调试器，以及是否被其他客户端占用。 */
  debuggerAttached: boolean;
  debuggerOccupiedByOther: boolean;
  /** content script 是否已就绪。定位与验证都依赖它。 */
  contentScriptReady: boolean;
  error: string | null;
  details: Record<string, unknown>;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  if (!chrome?.tabs?.query) return null;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/**
 * 探测 CDP 可用性。
 * 三件事要分清：权限有没有、当前标签页是否已挂调试器、是否被别的客户端（DevTools）占用。
 * 这三种情况的处置完全不同，混在一起报告用户无从下手。
 */
async function probeDebugger(tabId: number): Promise<{
  permissionOk: boolean;
  attached: boolean;
  occupiedByOther: boolean;
  detail: Record<string, unknown>;
}> {
  const permissionOk = Boolean(chrome?.debugger?.getTargets);
  if (!permissionOk) {
    return {
      permissionOk: false,
      attached: false,
      occupiedByOther: false,
      detail: { reason: 'debugger API 不可用，请确认清单已声明 debugger 权限' },
    };
  }
  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find((item) => item.tabId === tabId);
    return {
      permissionOk: true,
      attached: Boolean(target?.attached),
      // attached 为真但不是我们挂的，就是被 DevTools 之类占用了 —— 同一标签页只允许一个调试客户端。
      occupiedByOther: Boolean(target?.attached),
      detail: { targetFound: Boolean(target), attached: target?.attached ?? false, targetType: target?.type },
    };
  } catch (error) {
    return {
      permissionOk: true,
      attached: false,
      occupiedByOther: false,
      detail: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** 探测 content script 是否就绪。 */
async function probeContentScript(tabId: number): Promise<{ ready: boolean; detail: Record<string, unknown> }> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MessageType.ContentPing, tabId });
    return { ready: Boolean((response as { ok?: boolean } | undefined)?.ok), detail: { response } };
  } catch (error) {
    return { ready: false, detail: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/** 尝试注入脚本并读取基本页面信息，用于确认 host 权限。 */
async function testExecuteScript(tabId: number): Promise<{
  ok: boolean;
  error: string | null;
  data: Record<string, unknown>;
}> {
  if (!chrome?.scripting?.executeScript) {
    return { ok: false, error: 'chrome.scripting.executeScript 不可用', data: {} };
  }
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        pageTitle: document.title,
        pageUrl: location.href,
        readyState: document.readyState,
        interactiveElements: document.querySelectorAll('a, button, input, [role=button]').length,
      }),
    });

    const frames: Array<Record<string, unknown>> = injectionResults
      .map((item) => item.result as unknown)
      .filter((result): result is Record<string, unknown> => result !== undefined && result !== null);

    return {
      ok: frames.length > 0,
      error: frames.length > 0 ? null : '没有任何 frame 成功执行脚本',
      data: { frameCount: frames.length, mainFrame: frames[0] ?? {} },
    };
  } catch (error) {
    // "Cannot access contents of the page" 这类错误意味着缺 host 权限。
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      data: {},
    };
  }
}

export async function runDiagnostics(): Promise<DiagnosticResult> {
  const result: DiagnosticResult = {
    canQueryActiveTab: false,
    canExecuteScript: false,
    hostPermissionOk: false,
    debuggerPermissionOk: false,
    debuggerAttached: false,
    debuggerOccupiedByOther: false,
    contentScriptReady: false,
    error: null,
    details: {},
  };

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      result.error = '无法获取当前活动标签页，请确保插件有 tabs 权限。';
      return result;
    }
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
      result.error = `浏览器内部页面（${tab.url}）不允许扩展操作，请切换到一个普通网页。`;
      return result;
    }

    result.canQueryActiveTab = true;
    result.details.activeTabUrl = tab.url;

    // CDP 与 content script 探针：页面写操作与定位分别依赖这两者。
    const [debuggerProbe, contentProbe] = await Promise.all([
      probeDebugger(tab.id),
      probeContentScript(tab.id),
    ]);
    result.debuggerPermissionOk = debuggerProbe.permissionOk;
    result.debuggerAttached = debuggerProbe.attached;
    result.debuggerOccupiedByOther = debuggerProbe.occupiedByOther;
    result.contentScriptReady = contentProbe.ready;
    result.details.debugger = debuggerProbe.detail;
    result.details.contentScript = contentProbe.detail;

    // 脚本注入探测：能注入即说明 host 权限已授予。
    const scriptResult = await testExecuteScript(tab.id);
    if (!scriptResult.ok) {
      result.error = `脚本注入失败：${scriptResult.error}`;
      result.details.scriptError = scriptResult.error;
      return result;
    }
    result.canExecuteScript = true;
    result.hostPermissionOk = true;
    result.details.injection = scriptResult.data;

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

export function formatDiagnosticResult(result: DiagnosticResult): string {
  const lines: string[] = [];

  lines.push('=== 页面操作能力诊断 ===\n');

  lines.push(`✓ 活动标签页：${result.canQueryActiveTab ? '可访问' : '不可访问'}`);
  if (result.details.activeTabUrl) lines.push(`  当前 URL: ${result.details.activeTabUrl}`);

  lines.push(`✓ 脚本注入：${result.canExecuteScript ? '成功' : '失败'}`);
  if (result.details.scriptError) lines.push(`  错误：${result.details.scriptError}`);
  lines.push(`✓ Host 权限：${result.hostPermissionOk ? '已授予' : '未授予'}`);

  lines.push('');
  lines.push('=== CDP 真实交互能力 ===');
  lines.push(`✓ debugger 权限：${result.debuggerPermissionOk ? '已授予' : '未授予（页面写操作不可用）'}`);
  if (result.debuggerOccupiedByOther) {
    lines.push('  ⚠ 该标签页已被调试客户端占用。同一标签页只允许一个调试器——如果不是本插件挂的，请先关闭 DevTools。');
  } else {
    lines.push('  当前未挂调试器（启动任务时会自动 attach）');
  }
  lines.push(`✓ content script：${result.contentScriptReady ? '就绪' : '未就绪（请刷新目标页面）'}`);

  if (result.error) lines.push(`\n❌ 诊断错误：${result.error}`);

  return lines.join('\n');
}
