/**
 * 技能存储。
 *
 * 用户对某个会话满意时可以把它存为「技能」-- 本质是「收藏好用的指令 + 一键再跑」。
 * 不存完整工具调用日志，那是过程噪音；只存首条指令与最终回复摘要。
 */

/** 一条技能记录。 */
export interface Skill {
  id: string;
  name: string;
  /** 首条用户指令。一键应用时预填到输入框。 */
  firstInstruction: string;
  /** agent 最终回复的摘要，让用户记得这个技能干了什么。 */
  finalReplySummary: string;
  createdAt: string;
}

/** 对话轮次（技能提取用，从 freeFormSessionStore 内联）。 */
interface ConversationTurn {
  role: 'user' | 'agent' | 'error';
  text: string;
  timestamp: string;
  steps?: unknown[];
  error?: unknown;
}

const STORAGE_KEY = 'boos.skills';
const MAX_SKILLS = 50;

/** 从对话轮次中提取技能信息。 */
export function extractSkill(turns: readonly ConversationTurn[]): { firstInstruction: string; finalReplySummary: string; name: string } | null {
  const firstUser = turns.find((turn) => turn.role === 'user');
  if (!firstUser?.text.trim()) return null;

  const agentTurns = turns.filter((turn) => turn.role === 'agent');
  const lastAgent = agentTurns[agentTurns.length - 1];
  const finalReplySummary = (lastAgent?.text ?? '').slice(0, 200);
  const name = firstUser.text.trim().slice(0, 30);

  return { firstInstruction: firstUser.text, finalReplySummary, name };
}

/** 读取全部技能，按创建时间倒序。 */
export async function loadSkills(): Promise<Skill[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (!Array.isArray(value)) return [];
    return (value as Skill[]).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}

async function persist(skills: Skill[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: skills });
  } catch {
    // 存储失败不影响已返回的数据，只是下次加载可能丢。
  }
}

/** 从对话轮次保存一条技能。返回 null 表示无法保存（无对话或已达上限）。 */
export async function saveSkillFromTurns(turns: readonly ConversationTurn[]): Promise<{ ok: true; skill: Skill } | { ok: false; reason: string }> {
  const extracted = extractSkill(turns);
  if (!extracted) return { ok: false, reason: '当前会话没有可保存的内容。' };

  const skills = await loadSkills();
  if (skills.length >= MAX_SKILLS) {
    return { ok: false, reason: `技能数量已达上限（${MAX_SKILLS}），请先删除旧技能。` };
  }

  const skill: Skill = {
    id: `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: extracted.name,
    firstInstruction: extracted.firstInstruction,
    finalReplySummary: extracted.finalReplySummary,
    createdAt: new Date().toISOString(),
  };
  await persist([skill, ...skills]);
  return { ok: true, skill };
}

/** 重命名技能。 */
export async function renameSkill(id: string, name: string): Promise<void> {
  const skills = await loadSkills();
  const target = skills.find((skill) => skill.id === id);
  if (!target) return;
  target.name = name.trim() || target.name;
  await persist(skills);
}

/** 删除技能。 */
export async function deleteSkill(id: string): Promise<void> {
  const skills = await loadSkills();
  await persist(skills.filter((skill) => skill.id !== id));
}

/** 取单个技能。 */
export async function getSkill(id: string): Promise<Skill | undefined> {
  return (await loadSkills()).find((skill) => skill.id === id);
}
