/**
 * 独立诊断服务——用于排查数据读取能力
 * 不依赖 MCP，直接用 chrome.scripting 测试
 */

import { MessageType } from '../types/messages';

export interface DiagnosticResult {
  canQueryActiveTab: boolean;
  canExecuteScript: boolean;
  candidateListFound: boolean;
  candidateCount: number;
  sampleNames: string[];
  hostPermissionOk: boolean;
  /** debugger 权限是否已授予。没有它所有页面写操作都不可用。 */
  debuggerPermissionOk: boolean;
  /** 该标签页当前是否已挂调试器，以及是否被其他客户端占用。 */
  debuggerAttached: boolean;
  debuggerOccupiedByOther: boolean;
  /** content script 是否已就绪。定位与验证都依赖它。 */
  contentScriptReady: boolean;
  error: string | null;
  details: Record<string, any>;
}

interface DiagnosticFrameData {
  listItemCount: number;
  sampleNames: string[];
  pageTitle: string;
  pageUrl: string;
}

interface AggregatedDiagnosticData extends DiagnosticFrameData {
  frameCount: number;
  allFrames: Array<DiagnosticFrameData & { frameId?: number; documentId?: string }>;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  if (!chrome?.tabs?.query) {
    return null;
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function testExecuteScript(tabId: number): Promise<{
  ok: boolean;
  error: string | null;
  data: Record<string, any>;
}> {
  if (!chrome?.scripting?.executeScript) {
    return {
      ok: false,
      error: 'chrome.scripting.executeScript not available',
      data: {},
    };
  }

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const listItems = Array.from(document.querySelectorAll('li.card-item, .card-item'));
        const names = Array.from(listItems)
          .slice(0, 3)
          .map((item) => item.querySelector('.name')?.textContent?.trim() || '(无名称)');

        return {
          listItemCount: listItems.length,
          sampleNames: names,
          pageTitle: document.title,
          pageUrl: location.href,
        };
      },
    });

    const allFrames: Array<DiagnosticFrameData & { frameId?: number; documentId?: string }> = [];
    for (const item of injectionResults) {
      const frameData = item.result as DiagnosticFrameData | undefined;
      if (!frameData) {
        continue;
      }

      allFrames.push({
        ...frameData,
        frameId: item.frameId,
        documentId: item.documentId,
      });
    }

    const bestFrame =
      allFrames
        .slice()
        .sort((left, right) => {
          if (right.listItemCount !== left.listItemCount) {
            return right.listItemCount - left.listItemCount;
          }

          return (right.pageUrl?.length ?? 0) - (left.pageUrl?.length ?? 0);
        })[0] ?? null;

    const aggregatedData: AggregatedDiagnosticData = {
      listItemCount: bestFrame?.listItemCount ?? 0,
      sampleNames: bestFrame?.sampleNames ?? [],
      pageTitle: bestFrame?.pageTitle ?? '',
      pageUrl: bestFrame?.pageUrl ?? '',
      frameCount: allFrames.length,
      allFrames,
    };

    return {
      ok: true,
      error: null,
      data: aggregatedData as Record<string, any>,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      data: {},
    };
  }
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
    return { permissionOk: false, attached: false, occupiedByOther: false, detail: { reason: 'debugger API 不可用，请确认清单已声明 debugger 权限' } };
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

export async function runDiagnostics(): Promise<DiagnosticResult> {
  const result: DiagnosticResult = {
    canQueryActiveTab: false,
    canExecuteScript: false,
    candidateListFound: false,
    candidateCount: 0,
    sampleNames: [],
    hostPermissionOk: false,
    debuggerPermissionOk: false,
    debuggerAttached: false,
    debuggerOccupiedByOther: false,
    contentScriptReady: false,
    error: null,
    details: {},
  };

  try {
    // 1. Check if we can query active tab
    const tab = await getActiveTab();
    if (!tab?.id) {
      result.error = '无法获取当前活动标签页，请确保插件有 tabs 权限。';
      return result;
    }

    result.canQueryActiveTab = true;
    result.details.activeTabUrl = tab.url;

    // 2. CDP 与 content script 探针：页面写操作与定位分别依赖这两者。
    const [debuggerProbe, contentProbe] = await Promise.all([probeDebugger(tab.id), probeContentScript(tab.id)]);
    result.debuggerPermissionOk = debuggerProbe.permissionOk;
    result.debuggerAttached = debuggerProbe.attached;
    result.debuggerOccupiedByOther = debuggerProbe.occupiedByOther;
    result.contentScriptReady = contentProbe.ready;
    result.details.debugger = debuggerProbe.detail;
    result.details.contentScript = contentProbe.detail;

    // 3. Check if we can execute script
    const scriptResult = await testExecuteScript(tab.id);
    if (!scriptResult.ok) {
      result.error = `脚本注入失败：${scriptResult.error}`;
      result.details.scriptError = scriptResult.error;
      return result;
    }

    result.canExecuteScript = true;
    result.details.injectionData = scriptResult.data;

    // 4. Parse the injection result
    const data = scriptResult.data;
    result.candidateCount = data.listItemCount ?? 0;
    result.sampleNames = data.sampleNames ?? [];
    result.candidateListFound = result.candidateCount > 0;

    if (result.candidateListFound) {
      result.hostPermissionOk = true;
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

export function formatDiagnosticResult(result: DiagnosticResult): string {
  const lines: string[] = [];

  lines.push('=== 浏览器插件数据读取诊断 ===\n');

  lines.push(`✓ 能否查询活动标签页：${result.canQueryActiveTab ? '是' : '否'}`);
  if (result.details.activeTabUrl) {
    lines.push(`  当前 URL: ${result.details.activeTabUrl}`);
  }

  lines.push(`✓ 能否执行脚本注入：${result.canExecuteScript ? '是' : '否'}`);
  if (result.details.injectionData?.pageUrl) {
    lines.push(`  命中 Frame URL: ${result.details.injectionData.pageUrl}`);
  }
  if (result.details.injectionData?.frameCount) {
    lines.push(`  扫描 Frame 数: ${result.details.injectionData.frameCount}`);
  }

  lines.push(`✓ 找到候选人列表：${result.candidateListFound ? '是' : '否'}`);
  if (result.candidateListFound) {
    lines.push(`  候选人总数：${result.candidateCount}`);
    lines.push(`  前 3 个候选人：${result.sampleNames.join(' / ')}`);
  }

  lines.push(`✓ Host 权限检查：${result.hostPermissionOk ? '已授予' : '未授予'}`);

  lines.push('');
  lines.push('=== CDP 真实交互能力 ===');
  lines.push(`✓ debugger 权限：${result.debuggerPermissionOk ? '已授予' : '未授予（页面写操作不可用）'}`);
  if (result.debuggerOccupiedByOther) {
    lines.push('  ⚠ 该标签页已被调试客户端占用。同一标签页只允许一个调试器——如果不是本插件挂的，请先关闭 DevTools。');
  } else {
    lines.push('  当前未挂调试器（启动任务时会自动 attach）');
  }
  lines.push(`✓ content script 就绪：${result.contentScriptReady ? '是' : '否（请刷新目标页面）'}`);

  if (result.error) {
    lines.push(`\n❌ 诊断错误：${result.error}`);
  }

  if (Object.keys(result.details).length > 0) {
    lines.push(`\n详细信息：${JSON.stringify(result.details, null, 2)}`);
  }

  return lines.join('\n');
}
