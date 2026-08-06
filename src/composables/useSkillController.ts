import { ref } from 'vue';
import type { ConversationTurn } from '../services/freeFormSessionStore';
import { deleteSkill, loadSkills, renameSkill, saveSkillFromTurns } from '../services/skillStore';
import type { Skill } from '../services/skillStore';

/**
 * 技能管理控制器。
 *
 * 技能 = 收藏的好用指令 + 一键应用。不自动执行 -- 避免在错误页面跑出非预期动作。
 */

export function useSkillController() {
  const skills = ref<Skill[]>([]);

  async function refresh(): Promise<void> {
    skills.value = await loadSkills();
  }

  /** 从当前会话保存为技能。 */
  async function saveFromTurns(turns: readonly ConversationTurn[]): Promise<{ ok: boolean; message: string }> {
    const result = await saveSkillFromTurns(turns);
    if (result.ok) {
      await refresh();
      return { ok: true, message: `已保存技能「${result.skill.name}」` };
    }
    return { ok: false, message: result.reason };
  }

  async function rename(id: string, name: string): Promise<void> {
    await renameSkill(id, name);
    await refresh();
  }

  async function remove(id: string): Promise<void> {
    await deleteSkill(id);
    await refresh();
  }

  return { skills, refresh, saveFromTurns, rename, remove };
}
