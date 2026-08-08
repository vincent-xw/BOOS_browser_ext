import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSessions, deleteSession, deriveTitle, getSession, loadSessions, newSessionId, saveSession } from './freeFormSessionStore';

/** 内存版 chrome.storage.local。 */
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

function turn(text: string, role: 'user' | 'agent' = 'user') {
  return { role, text, timestamp: '2026-08-05T00:00:00.000Z' };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubStorage();
});

describe('deriveTitle', () => {
  it('取首条用户指令并截断', () => {
    expect(deriveTitle([turn('第一条'), turn('第二条')])).toBe('第一条');
    expect(deriveTitle([turn('x'.repeat(40))])).toContain('…');
  });

  it('无用户指令时用默认标题', () => {
    expect(deriveTitle([turn('回复', 'agent')])).toBe('未命名会话');
    expect(deriveTitle([])).toBe('未命名会话');
  });
});

describe('saveSession', () => {
  it('落库并可读回', async () => {
    await saveSession({ id: 's-1', turns: [turn('在搜索框输入 Vue3')] });
    const stored = await getSession('s-1');
    expect(stored).toMatchObject({ id: 's-1', title: '在搜索框输入 Vue3' });
    expect(stored?.turns).toHaveLength(1);
  });

  it('turns 为空时不落库', async () => {
    await saveSession({ id: 's-empty', turns: [] });
    expect(await getSession('s-empty')).toBeUndefined();
    // 用户点了「新会话」但一句话没说，不该在列表里留下空项。
  });

  it('追加后更新时间并覆盖标题', async () => {
    await saveSession({ id: 's-1', turns: [turn('第一条')] });
    await saveSession({ id: 's-1', turns: [turn('第一条'), turn('第二条')] });
    const stored = await getSession('s-1');
    expect(stored?.title).toBe('第一条'); // 标题仍取首条指令
    expect(stored?.turns).toHaveLength(2);
    expect(stored?.createdAt).toBeDefined();
  });

  it('按最近更新排序', async () => {
    await saveSession({ id: 's-old', turns: [turn('旧')] });
    await saveSession({ id: 's-new', turns: [turn('新')] });
    const list = await loadSessions();
    expect(list[0]?.id).toBe('s-new');
  });
});

describe('deleteSession', () => {
  it('删除指定会话', async () => {
    await saveSession({ id: 's-1', turns: [turn('a')] });
    await deleteSession('s-1');
    expect(await getSession('s-1')).toBeUndefined();
  });

  it('不影响其他会话', async () => {
    await saveSession({ id: 's-1', turns: [turn('a')] });
    await saveSession({ id: 's-2', turns: [turn('b')] });
    await deleteSession('s-1');
    expect(await getSession('s-2')).toBeDefined();
  });
});

describe('clearSessions', () => {
  it('清空全部会话', async () => {
    await saveSession({ id: 's-1', turns: [turn('a')] });
    await clearSessions();
    expect(await loadSessions()).toEqual([]);
  });
});

describe('newSessionId', () => {
  it('生成唯一 id', () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it('带 free- 前缀', () => {
    expect(newSessionId()).toMatch(/^free-/);
  });
});

describe('容量上限', () => {
  it('最多保留 30 个会话，超出丢最旧', async () => {
    // 快速灌入 35 个会话。
    for (let index = 0; index < 35; index += 1) {
      await saveSession({ id: `s-${index}`, turns: [turn(`第 ${index} 条`)] });
    }
    const list = await loadSessions();
    expect(list.length).toBeLessThanOrEqual(30);
    // 最旧的应被丢弃：s-0 不在了，最新的 s-34 在。
    expect(list.some((session) => session.id === 's-34')).toBe(true);
  });

  it('单个会话最多保留 60 轮', async () => {
    const turns = Array.from({ length: 80 }, (_, index) => turn(`第 ${index} 条`));
    await saveSession({ id: 's-long', turns });
    const stored = await getSession('s-long');
    expect(stored?.turns.length).toBeLessThanOrEqual(60);
  });
});
