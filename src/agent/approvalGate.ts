import { isReadOnlyTool } from './toolExecutor';

/**
 * 审批门。
 *
 * 「替我审批」模式：只读工具自动放行，写工具需要用户批准。批准时可选择授权范围，
 * 之后同范围内的同类动作不再打扰用户 —— 这是逐步审批与可用性之间的平衡点。
 *
 * 审批发生在 sidepanel（agent 循环所在的上下文），所以不需要跨上下文暂停：
 * 直接 await 一个由对话框 resolve 的 Promise 即可。
 */

/** 授权范围。 */
export type GrantScope =
  /** 只放行本次调用。 */
  | 'once'
  /** 本会话内该类工具都放行。会话结束即失效。 */
  | 'session-tool'
  /** 该域名下该类工具永久放行。持久化到 chrome.storage.local。 */
  | 'domain-tool';

export type ApprovalDecision = { approved: true; scope: GrantScope } | { approved: false; reason?: string };

/** 待审批请求，交给 UI 展示。 */
export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  /** 当前页面 URL，让用户看清动作发生在哪。 */
  url: string;
  /** 人话描述，例如「点击 搜索一下 (760, 120)」。 */
  summary: string;
}

/** UI 提供的审批实现。返回用户的决定。 */
export type ApprovalPrompt = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** 持久化授权的存储键。 */
const GRANT_STORAGE_KEY = 'boos.approval.grants';

/** 持久化的域名级授权：domain → 工具名列表。 */
type PersistedGrants = Record<string, string[]>;

async function loadPersistedGrants(): Promise<PersistedGrants> {
  try {
    const stored = await chrome.storage.local.get(GRANT_STORAGE_KEY);
    const value = stored[GRANT_STORAGE_KEY];
    return value && typeof value === 'object' ? (value as PersistedGrants) : {};
  } catch {
    return {};
  }
}

async function savePersistedGrants(grants: PersistedGrants): Promise<void> {
  try {
    await chrome.storage.local.set({ [GRANT_STORAGE_KEY]: grants });
  } catch {
    // 存储失败只影响「永久允许」的记忆，不影响本次执行。
  }
}

/** 从 URL 取域名；解析失败返回空串（空串不会匹配任何持久化授权）。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 生成动作的人话描述。让用户看到「点什么」而不是一堆坐标。 */
export function summarizeAction(toolName: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  const target = typeof record.label === 'string' ? record.label : typeof record.ref === 'number' ? `ref ${record.ref}` : '';
  const at = typeof record.x === 'number' && typeof record.y === 'number' ? `(${record.x}, ${record.y})` : '';
  switch (toolName) {
    case 'browser_click':
      return `点击 ${target || '目标元素'} ${at}`.trim();
    case 'browser_hover':
      return `悬停在 ${target || '目标元素'} ${at}`.trim();
    case 'browser_input_text': {
      const text = typeof record.text === 'string' ? record.text : '';
      const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      return `在 ${target || '输入框'} 输入「${preview}」`;
    }
    case 'browser_press_key':
      return `按下 ${String(record.key ?? '按键')}${Array.isArray(record.modifiers) && record.modifiers.length ? `（${record.modifiers.join('+')}）` : ''}`;
    case 'browser_scroll':
      return `滚动页面 ${String(record.deltaY ?? '')}px`;
    default:
      return `执行 ${toolName}`;
  }
}

export interface ApprovalGateOptions {
  /** UI 侧的审批实现。未提供时所有写操作都被拒绝（安全默认）。 */
  prompt?: ApprovalPrompt;
}

export function createApprovalGate(options: ApprovalGateOptions = {}) {
  /** 会话级授权：本会话内已放行的工具名。 */
  const sessionGrants = new Set<string>();

  /**
   * 请求执行某工具的许可。
   * 只读工具直接放行；写工具依次查会话级、域名级授权，都没有才弹给用户。
   */
  async function requestPermission(toolName: string, input: unknown, url: string): Promise<ApprovalDecision> {
    if (isReadOnlyTool(toolName)) return { approved: true, scope: 'once' };

    if (sessionGrants.has(toolName)) return { approved: true, scope: 'session-tool' };

    const host = hostOf(url);
    if (host) {
      const persisted = await loadPersistedGrants();
      if (persisted[host]?.includes(toolName)) return { approved: true, scope: 'domain-tool' };
    }

    // 没有 UI 可问时拒绝而不是放行：安全默认。
    if (!options.prompt) {
      return { approved: false, reason: '当前没有可用的审批界面，写操作已被拒绝。' };
    }

    const decision = await options.prompt({
      toolName,
      input,
      url,
      summary: summarizeAction(toolName, input),
    });

    if (decision.approved) {
      if (decision.scope === 'session-tool') sessionGrants.add(toolName);
      if (decision.scope === 'domain-tool' && host) {
        const persisted = await loadPersistedGrants();
        const existing = persisted[host] ?? [];
        if (!existing.includes(toolName)) {
          await savePersistedGrants({ ...persisted, [host]: [...existing, toolName] });
        }
        // 域名级授权同时在本会话生效，避免同一会话内重复读存储。
        sessionGrants.add(toolName);
      }
    }

    return decision;
  }

  /** 清空会话级授权。开始新会话时调用。 */
  function resetSession(): void {
    sessionGrants.clear();
  }

  return { requestPermission, resetSession };
}

export type ApprovalGate = ReturnType<typeof createApprovalGate>;

/** 读取已持久化的域名级授权，供设置界面展示与撤销。 */
export async function listPersistedGrants(): Promise<PersistedGrants> {
  return loadPersistedGrants();
}

/** 撤销某域名的全部持久化授权。 */
export async function revokeDomainGrants(domain: string): Promise<void> {
  const persisted = await loadPersistedGrants();
  delete persisted[domain];
  await savePersistedGrants(persisted);
}
