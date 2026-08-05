import { describe, expect, it, vi } from 'vitest';

import { executeTool, isAllowedTool, TOOL_ALLOWLIST } from './toolExecutor';
import { MessageType } from '../types/messages';
import type { ExtensionRequest } from '../types/messages';

/** 记录所有被发出的消息，便于断言「未授权工具没有触发任何页面动作」。 */
function recordingSender() {
  const sent: ExtensionRequest[] = [];
  const send = vi.fn(async <T>(message: ExtensionRequest): Promise<T> => {
    sent.push(message);
    return { ok: true, message: 'stub' } as T;
  });
  return { sent, send: send as unknown as <T>(message: ExtensionRequest) => Promise<T> };
}

describe('白名单', () => {
  it('包含闭环所需的 8 个工具', () => {
    expect([...TOOL_ALLOWLIST]).toEqual([
      'browser.read_page',
      'browser.locate_element',
      'browser.click',
      'browser.input_text',
      'browser.press_key',
      'browser.scroll',
      'browser.verify',
      'browser.screenshot',
    ]);
  });

  it('识别白名单内的工具', () => {
    expect(isAllowedTool('browser.click')).toBe(true);
  });

  it('拒绝白名单外的工具名', () => {
    expect(isAllowedTool('browser.evaluate')).toBe(false);
    expect(isAllowedTool('chrome.tabs.remove')).toBe(false);
    expect(isAllowedTool('')).toBe(false);
  });
});

describe('未授权工具', () => {
  it('回填未授权失败结果', async () => {
    const { send } = recordingSender();
    const result = await executeTool('browser.evaluate', { code: 'alert(1)' }, { tabId: 1, send });
    expect(result).toMatchObject({ ok: false, code: 'TOOL_NOT_ALLOWED' });
  });

  it('不执行任何页面动作', async () => {
    // 这是扩展作为 Tool Host 的核心安全边界：BFF 被攻破也不能驱动任意浏览器操作。
    const { sent, send } = recordingSender();
    await executeTool('browser.evaluate', { code: 'alert(1)' }, { tabId: 1, send });
    expect(sent).toHaveLength(0);
  });
});

describe('输入校验', () => {
  it('点击缺少坐标时拒绝执行', async () => {
    const { sent, send } = recordingSender();
    const result = await executeTool('browser.click', {}, { tabId: 1, send });
    expect(result).toMatchObject({ ok: false, code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('坐标为 NaN 时拒绝执行', async () => {
    // NaN 传给 CDP 不会报错，只是点不到东西 —— 必须在这里挡掉。
    const { sent, send } = recordingSender();
    const result = await executeTool('browser.click', { x: Number.NaN, y: 10 }, { tabId: 1, send });
    expect(result).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('坐标为字符串时拒绝执行', async () => {
    const { send } = recordingSender();
    expect(await executeTool('browser.click', { x: '100', y: '200' }, { tabId: 1, send })).toMatchObject({
      code: 'TOOL_INPUT_INVALID',
    });
  });

  it('输入文本缺少 text 时拒绝执行', async () => {
    const { sent, send } = recordingSender();
    const result = await executeTool('browser.input_text', { x: 1, y: 2 }, { tabId: 1, send });
    expect(result).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('定位时 role 不受支持则拒绝执行', async () => {
    const { sent, send } = recordingSender();
    const result = await executeTool('browser.locate_element', { role: 'somethingElse' }, { tabId: 1, send });
    expect(result).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('滚动缺少 deltaY 时拒绝执行', async () => {
    const { send } = recordingSender();
    expect(await executeTool('browser.scroll', {}, { tabId: 1, send })).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });
});

describe('工具派发', () => {
  it('点击转为 CDP 点击消息并原样传递坐标', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser.click', { x: 120, y: 340, label: '打招呼按钮' }, { tabId: 9, send });
    expect(sent[0]).toEqual({ type: MessageType.CdpClick, tabId: 9, x: 120, y: 340, label: '打招呼按钮' });
  });

  it('文本输入转为 CDP 输入消息', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser.input_text', { x: 10, y: 20, text: '你好，看到你的简历了' }, { tabId: 3, send });
    expect(sent[0]).toEqual({ type: MessageType.CdpInputText, tabId: 3, x: 10, y: 20, text: '你好，看到你的简历了' });
  });

  it('定位转为 content script 消息', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser.locate_element', { role: 'greetButton', index: 2 }, { tabId: 4, send });
    expect(sent[0]).toEqual({ type: MessageType.ContentLocate, tabId: 4, locator: { role: 'greetButton', index: 2 } });
  });

  it('按键转为 CDP 按键消息并带修饰符', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser.press_key', { key: 'Enter', modifiers: ['Control'] }, { tabId: 5, send });
    expect(sent[0]).toEqual({ type: MessageType.CdpPressKey, tabId: 5, key: 'Enter', modifiers: ['Control'] });
  });

  it('读取页面转为 content script 消息', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser.read_page', { includeCandidateList: true }, { tabId: 6, send });
    expect(sent[0]).toEqual({ type: MessageType.ContentReadPage, tabId: 6, includeCandidateList: true });
  });
});

describe('执行失败', () => {
  it('底层消息失败转为结构化失败结果而非抛出', async () => {
    const send = (async () => {
      throw new Error('NO_DEBUG_SESSION: 没有可用的调试会话');
    }) as unknown as <T>(message: ExtensionRequest) => Promise<T>;
    const result = await executeTool('browser.click', { x: 1, y: 2 }, { tabId: 1, send });
    expect(result).toMatchObject({ ok: false, code: 'TOOL_EXECUTION_FAILED' });
    expect((result as { message: string }).message).toContain('NO_DEBUG_SESSION');
  });
});
