import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApprovalGate, summarizeAction } from './approvalGate';
import type { ApprovalDecision, ApprovalRequest } from './approvalGate';

/** 内存版 chrome.storage.local，用于隔离持久化授权。 */
function stubStorage(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        },
      },
    },
  });
  return store;
}

/** 总是给出同一决定的审批实现，并记录被问过几次。 */
function countingPrompt(decision: ApprovalDecision) {
  const seen: ApprovalRequest[] = [];
  const prompt = async (request: ApprovalRequest) => {
    seen.push(request);
    return decision;
  };
  return { seen, prompt };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubStorage();
});

describe('只读工具', () => {
  it('自动放行，不打扰用户', async () => {
    const { seen, prompt } = countingPrompt({ approved: false });
    const gate = createApprovalGate({ prompt });
    for (const name of ['browser_snapshot', 'browser_read_page', 'browser_locate_element', 'browser_verify', 'browser_screenshot']) {
      const decision = await gate.requestPermission(name, {}, 'https://example.com/');
      expect(decision.approved, name).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('写工具', () => {
  it('需要用户批准', async () => {
    const { seen, prompt } = countingPrompt({ approved: true, scope: 'once' });
    const gate = createApprovalGate({ prompt });
    expect((await gate.requestPermission('browser_click', { x: 1, y: 2 }, 'https://example.com/')).approved).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('用户拒绝时不放行', async () => {
    const { prompt } = countingPrompt({ approved: false, reason: '用户拒绝' });
    const gate = createApprovalGate({ prompt });
    expect((await gate.requestPermission('browser_click', {}, 'https://example.com/')).approved).toBe(false);
  });

  it('没有审批界面时拒绝而不是放行', async () => {
    // 安全默认：无法征询用户意见时不得擅自执行写操作。
    const gate = createApprovalGate();
    const decision = await gate.requestPermission('browser_click', {}, 'https://example.com/');
    expect(decision.approved).toBe(false);
  });

  it('scope=once 时每次都要重新批准', async () => {
    const { seen, prompt } = countingPrompt({ approved: true, scope: 'once' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', {}, 'https://example.com/');
    await gate.requestPermission('browser_click', {}, 'https://example.com/');
    expect(seen).toHaveLength(2);
  });
});

describe('会话级授权', () => {
  it('批准后同类动作本会话内不再询问', async () => {
    const { seen, prompt } = countingPrompt({ approved: true, scope: 'session-tool' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', {}, 'https://example.com/');
    await gate.requestPermission('browser_click', {}, 'https://example.com/');
    await gate.requestPermission('browser_click', {}, 'https://other.com/');
    expect(seen).toHaveLength(1);
  });

  it('只对被授权的那个工具生效', async () => {
    const { seen, prompt } = countingPrompt({ approved: true, scope: 'session-tool' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', {}, 'https://example.com/');
    await gate.requestPermission('browser_input_text', { text: 'x' }, 'https://example.com/');
    expect(seen.map((request) => request.toolName)).toEqual(['browser_click', 'browser_input_text']);
  });

  it('resetSession 后需要重新批准', async () => {
    const { seen, prompt } = countingPrompt({ approved: true, scope: 'session-tool' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', {}, 'https://example.com/');
    gate.resetSession();
    await gate.requestPermission('browser_click', {}, 'https://example.com/');
    expect(seen).toHaveLength(2);
  });
});

describe('域名级授权', () => {
  it('批准后落库，新会话仍然生效', async () => {
    const { prompt } = countingPrompt({ approved: true, scope: 'domain-tool' });
    const first = createApprovalGate({ prompt });
    await first.requestPermission('browser_click', {}, 'https://example.com/page');

    // 新建 gate 模拟新会话：授权来自存储而非内存。
    const { seen, prompt: secondPrompt } = countingPrompt({ approved: false });
    const second = createApprovalGate({ prompt: secondPrompt });
    expect((await second.requestPermission('browser_click', {}, 'https://example.com/other')).approved).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('不跨域名生效', async () => {
    const { prompt } = countingPrompt({ approved: true, scope: 'domain-tool' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', {}, 'https://example.com/');

    const { seen, prompt: otherPrompt } = countingPrompt({ approved: false });
    const other = createApprovalGate({ prompt: otherPrompt });
    await other.requestPermission('browser_click', {}, 'https://different.com/');
    expect(seen).toHaveLength(1);
  });

  it('不跨工具生效', async () => {
    const { prompt } = countingPrompt({ approved: true, scope: 'domain-tool' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', {}, 'https://example.com/');

    const { seen, prompt: nextPrompt } = countingPrompt({ approved: false });
    const next = createApprovalGate({ prompt: nextPrompt });
    await next.requestPermission('browser_press_key', { key: 'Enter' }, 'https://example.com/');
    expect(seen).toHaveLength(1);
  });

  it('无法解析域名时不落库', async () => {
    const store = stubStorage();
    const { prompt } = countingPrompt({ approved: true, scope: 'domain-tool' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', {}, 'not-a-url');
    expect(store.get('boos.approval.grants')).toBeUndefined();
  });
});

describe('summarizeAction', () => {
  it('点击带上标签与坐标', () => {
    expect(summarizeAction('browser_click', { label: '搜索一下', x: 760, y: 120 })).toContain('搜索一下');
    expect(summarizeAction('browser_click', { label: '搜索一下', x: 760, y: 120 })).toContain('760, 120');
  });

  it('无标签时退化为 ref', () => {
    expect(summarizeAction('browser_click', { ref: 5 })).toContain('ref 5');
  });

  it('输入动作展示待写入文本', () => {
    expect(summarizeAction('browser_input_text', { ref: 2, text: 'Vue3 教程' })).toContain('Vue3 教程');
  });

  it('长文本被截断，避免撑爆对话框', () => {
    const summary = summarizeAction('browser_input_text', { text: 'x'.repeat(200) });
    expect(summary.length).toBeLessThan(80);
    expect(summary).toContain('…');
  });

  it('按键展示键名与修饰符', () => {
    expect(summarizeAction('browser_press_key', { key: 'Enter', modifiers: ['Control'] })).toContain('Enter');
    expect(summarizeAction('browser_press_key', { key: 'Enter', modifiers: ['Control'] })).toContain('Control');
  });

  it('滚动展示距离', () => {
    expect(summarizeAction('browser_scroll', { deltaY: 500 })).toContain('500');
  });
});

describe('审批请求内容', () => {
  it('带上 URL 让用户看清动作发生在哪', async () => {
    const { seen, prompt } = countingPrompt({ approved: true, scope: 'once' });
    const gate = createApprovalGate({ prompt });
    await gate.requestPermission('browser_click', { label: '按钮' }, 'https://example.com/page');
    expect(seen[0]).toMatchObject({ url: 'https://example.com/page', toolName: 'browser_click' });
    expect(seen[0]?.summary).toContain('按钮');
  });
});
