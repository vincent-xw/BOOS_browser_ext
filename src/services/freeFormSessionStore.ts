import type { StepEvent } from '../agent/agentClient';
import type { OperationError } from '../types/page-io';

/**
 * 自由指令的会话存储。
 *
 * 之前 sessionId 只存在内存 ref 里，点「新会话」就直接覆盖 —— 旧会话在 BFF 侧的
 * SQLite 里其实一直存在，只是扩展把 id 丢了，从此再也无法引用。
 * 所以这里持久化的关键不是对话文本（那只是给用户看的），而是 **sessionId** ——
 * 有它才能切回去继续多轮上下文。
 */

/** 对话中的一条消息。 */
export interface ConversationTurn {
  role: 'user' | 'agent' | 'error';
  text: string;
  timestamp: string;
  /** 该轮执行的步骤，仅 agent 轮次有。 */
  steps?: StepEvent[];
  /** 出错详情，仅 error 轮次有。持久化它，隔一段时间再复制诊断日志仍拿得到 requestId。 */
  error?: OperationError;
}

/** 一个会话。 */
export interface StoredSession {
  id: string;
  /** 会话标题。首轮用首条指令截断，agent 回复后用 LLM 生成的标题覆盖。 */
  title: string;
  /** 标题是否已由 LLM 生成。首轮为 false，agent 回复后为 true。 */
  titleGenerated: boolean;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

const STORAGE_KEY = 'boos.freeform.sessions';

/** 保留的会话数上限。超出后丢弃最旧的，避免 storage 无限增长。 */
const MAX_SESSIONS = 30;

/** 单个会话保留的轮次上限。长会话只留最近的，避免单条记录过大。 */
const MAX_TURNS_PER_SESSION = 60;

/** 从首条用户指令生成临时标题（agent 回复前的占位）。 */
export function deriveTitle(turns: readonly ConversationTurn[]): string {
  const firstUser = turns.find((turn) => turn.role === 'user');
  const text = firstUser?.text.trim() ?? '';
  if (!text) return '未命名会话';
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/** 从对话内容中提取供 LLM 生成标题的摘要。 */
export function buildTitlePrompt(turns: readonly ConversationTurn[]): string {
  const firstUser = turns.find((turn) => turn.role === 'user');
  const firstAgent = turns.find((turn) => turn.role === 'agent');
  const userText = (firstUser?.text ?? '').slice(0, 500);
  const agentText = (firstAgent?.text ?? '').slice(0, 500);
  return `用户指令：${userText}\n\n执行结果摘要：${agentText}`;
}

/** 读取全部会话，按最近更新排序。 */
export async function loadSessions(): Promise<StoredSession[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (!Array.isArray(value)) return [];
    return (value as StoredSession[]).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

async function persist(sessions: StoredSession[]): Promise<void> {
  try {
    // 只保留最近的 MAX_SESSIONS 个；chrome.storage.local 有配额，不能无限堆。
    const trimmed = [...sessions]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_SESSIONS);
    await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
  } catch {
    // 写入失败不影响当前会话继续使用，只是切不回来。
  }
}

/**
 * 写入或更新一个会话。
 * turns 为空时不落库 —— 用户点了「新会话」但一句话没说，不该在列表里留下空项。
 */
export async function saveSession(session: { id: string; turns: ConversationTurn[]; createdAt?: string; title?: string; titleGenerated?: boolean }): Promise<void> {
  if (session.turns.length === 0) return;
  const sessions = await loadSessions();
  const existing = sessions.find((item) => item.id === session.id);
  const now = new Date().toISOString();
  const titleGenerated = session.titleGenerated ?? existing?.titleGenerated ?? false;
  const entry: StoredSession = {
    id: session.id,
    title: session.title ?? existing?.title ?? deriveTitle(session.turns),
    titleGenerated,
    createdAt: existing?.createdAt ?? session.createdAt ?? now,
    updatedAt: now,
    turns: session.turns.slice(-MAX_TURNS_PER_SESSION),
  };
  await persist([entry, ...sessions.filter((item) => item.id !== session.id)]);
}

/** 取单个会话。 */
export async function getSession(id: string): Promise<StoredSession | undefined> {
  return (await loadSessions()).find((session) => session.id === id);
}

/**
 * 删除一个会话。
 * 只删本地记录 —— BFF 侧的会话数据仍在，但没有 id 就无法再引用，等价于不可达。
 */
export async function deleteSession(id: string): Promise<void> {
  const sessions = await loadSessions();
  await persist(sessions.filter((session) => session.id !== id));
}

/** 清空全部会话。 */
export async function clearSessions(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    // 忽略。
  }
}

/** 生成新的会话 id。 */
export function newSessionId(): string {
  return `free-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
