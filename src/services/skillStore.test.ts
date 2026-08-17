import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteSkill, extractSkill, loadSkills, renameSkill, saveSkillFromTurns } from './skillStore';

interface ConversationTurn {
  role: 'user' | 'agent' | 'error';
  text: string;
  timestamp: string;
  steps?: unknown[];
  error?: unknown;
}

function stubStorage() {
  const store = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        },
        remove: async (key: string) => void store.delete(key),
      },
    },
  });
  return store;
}

function turn(text: string, role: 'user' | 'agent' = 'user'): ConversationTurn {
  return { role, text, timestamp: '2026-08-06T00:00:00.000Z' };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubStorage();
});

describe('extractSkill', () => {
  it('从对话中提取首条指令与最终回复', () => {
    const result = extractSkill([turn('在搜索框输入 Vue3'), turn('已搜索完成', 'agent')]);
    expect(result?.firstInstruction).toBe('在搜索框输入 Vue3');
    expect(result?.finalReplySummary).toBe('已搜索完成');
    expect(result?.name).toBe('在搜索框输入 Vue3');
  });

  it('首条指令超 30 字时截断为名称', () => {
    const long = 'x'.repeat(40);
    const result = extractSkill([turn(long)]);
    expect(result?.name.length).toBe(30);
  });

  it('无用户指令时返回 null', () => {
    expect(extractSkill([turn('回复', 'agent')])).toBeNull();
    expect(extractSkill([])).toBeNull();
  });
});

describe('saveSkillFromTurns', () => {
  it('保存后可读回', async () => {
    const result = await saveSkillFromTurns([turn('测试指令'), turn('完成', 'agent')]);
    expect(result.ok).toBe(true);
    const skills = await loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.firstInstruction).toBe('测试指令');
  });

  it('无对话时拒绝保存', async () => {
    const result = await saveSkillFromTurns([]);
    expect(result.ok).toBe(false);
  });

  it('按创建时间倒序', async () => {
    await saveSkillFromTurns([turn('第一条')]);
    await saveSkillFromTurns([turn('第二条')]);
    const skills = await loadSkills();
    expect(skills[0]?.firstInstruction).toBe('第二条');
  });
});

describe('renameSkill', () => {
  it('重命名后名称更新', async () => {
    await saveSkillFromTurns([turn('原名称')]);
    const skills = await loadSkills();
    const id = skills[0]!.id;
    await renameSkill(id, '新名称');
    const updated = await loadSkills();
    expect(updated[0]?.name).toBe('新名称');
  });

  it('空名称时保留原名', async () => {
    await saveSkillFromTurns([turn('原名')]);
    const skills = await loadSkills();
    const id = skills[0]!.id;
    await renameSkill(id, '  ');
    const updated = await loadSkills();
    expect(updated[0]?.name).toBe('原名');
  });
});

describe('deleteSkill', () => {
  it('删除后不再出现', async () => {
    await saveSkillFromTurns([turn('待删除')]);
    const skills = await loadSkills();
    await deleteSkill(skills[0]!.id);
    expect(await loadSkills()).toEqual([]);
  });
});

describe('上限', () => {
  it('达到 50 条时拒绝新增', async () => {
    for (let i = 0; i < 50; i += 1) {
      await saveSkillFromTurns([turn(`技能 ${i}`)]);
    }
    const result = await saveSkillFromTurns([turn('第 51 条')]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('上限');
  });
});
