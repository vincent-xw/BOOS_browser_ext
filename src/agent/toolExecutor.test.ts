import { describe, expect, it, vi } from 'vitest';

import { executeTool, isAllowedTool, isReadOnlyTool, normalizeWaitFor, TOOL_ALLOWLIST } from './toolExecutor';
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
  it('包含闭环所需的全部工具', () => {
    expect([...TOOL_ALLOWLIST]).toEqual([
      'browser_snapshot',
      'browser_read_page',
      'browser_locate_element',
      'browser_click',
      'browser_hover',
      'browser_wait_for',
      'browser_input_text',
      'browser_press_key',
      'browser_scroll',
      'browser_go_back',
      'browser_verify',
      'browser_screenshot',
      'browser_save_file',
      'browser_read_file',
      'browser_write_file',
    ]);
  });

  it('识别白名单内的工具', () => {
    expect(isAllowedTool('browser_click')).toBe(true);
    expect(isAllowedTool('browser_snapshot')).toBe(true);
  });

  it('拒绝白名单外的工具名', () => {
    expect(isAllowedTool('browser.evaluate')).toBe(false);
    expect(isAllowedTool('chrome.tabs.remove')).toBe(false);
    expect(isAllowedTool('')).toBe(false);
  });

  it('只读工具与写工具划分正确', () => {
    // 这条划分决定了审批门放行谁：读自动、写需批准。
    for (const name of ['browser_snapshot', 'browser_read_page', 'browser_locate_element', 'browser_verify', 'browser_screenshot', 'browser_hover', 'browser_wait_for']) {
      expect(isReadOnlyTool(name), `${name} 应为只读`).toBe(true);
    }
    for (const name of ['browser_click', 'browser_input_text', 'browser_press_key', 'browser_scroll']) {
      expect(isReadOnlyTool(name), `${name} 应为写操作`).toBe(false);
    }
  });
});

describe('normalizeWaitFor', () => {
  it('appear / disappear 必须给 selector', () => {
    expect(normalizeWaitFor({ condition: 'appear' }).ok).toBe(false);
    expect(normalizeWaitFor({ condition: 'disappear', selector: '  ' }).ok).toBe(false);
    expect(normalizeWaitFor({ condition: 'appear', selector: '.el-select-dropdown' }).ok).toBe(true);
  });

  it('stable 不需要 selector', () => {
    const result = normalizeWaitFor({ condition: 'stable' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ condition: 'stable' });
  });

  it('拒绝未知的 condition', () => {
    expect(normalizeWaitFor({ condition: 'whatever' }).ok).toBe(false);
    expect(normalizeWaitFor({}).ok).toBe(false);
  });

  it('越界的超时值被夹到区间内而不是报错', () => {
    // 模型给出离谱数值时纠正即可，报错只会让它重试一遍同样的错。
    const tooLong = normalizeWaitFor({ condition: 'stable', timeoutMs: 999_999, stableMs: 99_999 });
    expect(tooLong.ok).toBe(true);
    if (tooLong.ok) expect(tooLong.value).toMatchObject({ timeoutMs: 15_000, stableMs: 3_000 });

    const tooShort = normalizeWaitFor({ condition: 'stable', timeoutMs: 1, stableMs: 1 });
    if (tooShort.ok) expect(tooShort.value).toMatchObject({ timeoutMs: 100, stableMs: 100 });
  });

  it('selector 两端空白被裁掉', () => {
    const result = normalizeWaitFor({ condition: 'appear', selector: '  .dropdown  ' });
    if (result.ok) expect(result.value.selector).toBe('.dropdown');
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
    const result = await executeTool('browser_click', {}, { tabId: 1, send });
    expect(result).toMatchObject({ ok: false, code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('坐标为 NaN 时拒绝执行', async () => {
    // NaN 传给 CDP 不会报错，只是点不到东西 —— 必须在这里挡掉。
    const { sent, send } = recordingSender();
    const result = await executeTool('browser_click', { x: Number.NaN, y: 10 }, { tabId: 1, send });
    expect(result).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('坐标为字符串时拒绝执行', async () => {
    const { send } = recordingSender();
    expect(await executeTool('browser_click', { x: '100', y: '200' }, { tabId: 1, send })).toMatchObject({
      code: 'TOOL_INPUT_INVALID',
    });
  });

  it('输入文本缺少 text 时拒绝执行', async () => {
    const { sent, send } = recordingSender();
    const result = await executeTool('browser_input_text', { x: 1, y: 2 }, { tabId: 1, send });
    expect(result).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('定位时 role 不受支持则拒绝执行', async () => {
    const { sent, send } = recordingSender();
    const result = await executeTool('browser_locate_element', { role: 'somethingElse' }, { tabId: 1, send });
    expect(result).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('定位既无 ref 也无 selector 与 role 时拒绝执行', async () => {
    const { sent, send } = recordingSender();
    const result = await executeTool('browser_locate_element', {}, { tabId: 1, send });
    expect(result).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('定位允许只给 selector（不再强制 role）', async () => {
    // role 曾是必填且绑死 BOSS 枚举，自由指令场景下那样限制太死。
    const { sent, send } = recordingSender();
    await executeTool('browser_locate_element', { selector: 'input#kw' }, { tabId: 1, send });
    expect(sent[0]).toEqual({ type: MessageType.ContentLocate, tabId: 1, locator: { selector: 'input#kw' } });
  });

  it('滚动缺少 deltaY 时拒绝执行', async () => {
    const { send } = recordingSender();
    expect(await executeTool('browser_scroll', {}, { tabId: 1, send })).toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });
});

describe('工具派发', () => {
  it('点击转为 CDP 点击消息并原样传递坐标', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser_click', { x: 120, y: 340, label: '打招呼按钮' }, { tabId: 9, send });
    expect(sent[0]).toEqual({ type: MessageType.CdpClick, tabId: 9, x: 120, y: 340, label: '打招呼按钮' });
  });

  it('文本输入转为 CDP 输入消息', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser_input_text', { x: 10, y: 20, text: '你好，看到你的简历了' }, { tabId: 3, send });
    expect(sent[0]).toEqual({ type: MessageType.CdpInputText, tabId: 3, x: 10, y: 20, text: '你好，看到你的简历了' });
  });

  it('定位转为 content script 消息', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser_locate_element', { selector: '#search', index: 2 }, { tabId: 4, send });
    expect(sent[0]).toEqual({ type: MessageType.ContentLocate, tabId: 4, locator: { selector: '#search', index: 2 } });
  });

  it('按键转为 CDP 按键消息并带修饰符', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser_press_key', { key: 'Enter', modifiers: ['Control'] }, { tabId: 5, send });
    expect(sent[0]).toEqual({ type: MessageType.CdpPressKey, tabId: 5, key: 'Enter', modifiers: ['Control'] });
  });

  it('读取页面转为 content script 消息', async () => {
    const { sent, send } = recordingSender();
    await executeTool('browser_read_page', {}, { tabId: 6, send });
    expect(sent[0]).toEqual({ type: MessageType.ContentReadPage, tabId: 6 });
  });
});

describe('ref 引用派发', () => {
  /** 一个能回应 ref 解析的 sender。 */
  function refSender(resolution: unknown) {
    const sent: ExtensionRequest[] = [];
    const send = (async (message: ExtensionRequest) => {
      sent.push(message);
      if (message.type === MessageType.ContentResolveRef) return resolution;
      return { ok: true, message: 'done' };
    }) as unknown as <T>(message: ExtensionRequest) => Promise<T>;
    return { sent, send };
  }

  it('点击按 ref 取当前坐标而非使用模型给的坐标', async () => {
    // 这是「每步重新算坐标」的实现点：模型引用旧快照的 ref，坐标由执行侧保证新鲜。
    const { sent, send } = refSender({ found: true, x: 500, y: 600, label: '搜索按钮' });
    await executeTool('browser_click', { ref: 7, x: 111, y: 222 }, { tabId: 1, send });
    const click = sent.find((message) => message.type === MessageType.CdpClick);
    expect(click).toMatchObject({ x: 500, y: 600 });
  });

  it('ref 解析先于点击发生', async () => {
    const { sent, send } = refSender({ found: true, x: 10, y: 20 });
    await executeTool('browser_click', { ref: 3 }, { tabId: 1, send });
    expect(sent.map((message) => message.type)).toEqual([MessageType.ContentResolveRef, MessageType.CdpClick]);
  });

  it('ref 已失效时不下发点击，并提示重新快照', async () => {
    const { sent, send } = refSender({ found: false, stale: true, message: 'ref 3 指向的元素已从页面移除，请重新快照。' });
    const result = await executeTool('browser_click', { ref: 3 }, { tabId: 1, send });
    expect(sent.some((message) => message.type === MessageType.CdpClick)).toBe(false);
    expect((result as { message: string }).message).toContain('重新快照');
  });

  it('目标被遮挡时不下发点击', async () => {
    const { sent, send } = refSender({ found: true, x: 10, y: 20, occluded: true, occludedBy: 'div.mask' });
    const result = await executeTool('browser_click', { ref: 4 }, { tabId: 1, send });
    expect(sent.some((message) => message.type === MessageType.CdpClick)).toBe(false);
    expect((result as { message: string }).message).toContain('div.mask');
  });

  it('输入文本同样支持 ref', async () => {
    const { sent, send } = refSender({ found: true, x: 640, y: 120 });
    await executeTool('browser_input_text', { ref: 2, text: 'Vue3' }, { tabId: 1, send });
    expect(sent.find((message) => message.type === MessageType.CdpInputText)).toMatchObject({
      x: 640,
      y: 120,
      text: 'Vue3',
    });
  });

  it('输入文本把目标所属 frame 透给 background', async () => {
    // 焦点检查必须在目标 frame 里做：主 frame 的 activeElement 是 <iframe> 本身，
    // 只读主 frame 会把「焦点已正确落在子 frame 输入框」误判成失败，导致 iframe 页面必然写不进去。
    const { sent, send } = refSender({ found: true, x: 844, y: 205, frameId: 357 });
    await executeTool('browser_input_text', { ref: 2, text: '13188889253' }, { tabId: 1, send });
    expect(sent.find((message) => message.type === MessageType.CdpInputText)).toMatchObject({ frameId: 357 });
  });

  it('主 frame 的目标不带 frameId 字段', async () => {
    const { sent, send } = refSender({ found: true, x: 10, y: 20, frameId: 0 });
    await executeTool('browser_input_text', { ref: 2, text: 'x' }, { tabId: 1, send });
    expect(sent.find((message) => message.type === MessageType.CdpInputText)).toMatchObject({ frameId: 0 });
  });

  it('clearFirst 会把清空折叠进写入消息，不再拆成多次消息', async () => {
    const { sent, send } = refSender({ found: true, x: 1, y: 2 });
    await executeTool('browser_input_text', { ref: 2, text: '新内容', clearFirst: true }, { tabId: 1, send });
    const types = sent.map((message) => message.type);
    // 解析 ref → 写入（clearFirst 在 background 同一次消息内完成，
    // 拆成点击+退格两条消息会让后续点击冲掉选区，导致原文本一个字都没删）
    expect(types).toEqual([
      MessageType.ContentResolveRef,
      MessageType.CdpInputText,
    ]);
    expect(sent.find((message) => message.type === MessageType.CdpInputText)).toMatchObject({
      clearFirst: true,
      text: '新内容',
    });
  });

  it('ref 解析出的 label 用作点击日志标签', async () => {
    const { sent, send } = refSender({ found: true, x: 1, y: 2, label: '搜索一下' });
    await executeTool('browser_click', { ref: 9 }, { tabId: 1, send });
    expect(sent.find((message) => message.type === MessageType.CdpClick)).toMatchObject({ label: '搜索一下' });
  });

  it('显式 label 优先于 ref 的 label', async () => {
    const { sent, send } = refSender({ found: true, x: 1, y: 2, label: '自动推断' });
    await executeTool('browser_click', { ref: 9, label: '用户指定' }, { tabId: 1, send });
    expect(sent.find((message) => message.type === MessageType.CdpClick)).toMatchObject({ label: '用户指定' });
  });

  it('快照转为 content script 消息', async () => {
    const { sent, send } = refSender({});
    await executeTool('browser_snapshot', {}, { tabId: 5, send });
    expect(sent[0]).toEqual({ type: MessageType.ContentSnapshot, tabId: 5 });
  });
});

describe('执行失败', () => {
  it('底层消息失败转为结构化失败结果而非抛出', async () => {
    const send = (async () => {
      throw new Error('NO_DEBUG_SESSION: 没有可用的调试会话');
    }) as unknown as <T>(message: ExtensionRequest) => Promise<T>;
    const result = await executeTool('browser_click', { x: 1, y: 2 }, { tabId: 1, send });
    expect(result).toMatchObject({ ok: false, code: 'TOOL_EXECUTION_FAILED' });
    expect((result as { message: string }).message).toContain('NO_DEBUG_SESSION');
  });
});

describe('截图返回 dataUrl', () => {
  function screenshotSender() {
    const sent: ExtensionRequest[] = [];
    const send = (async (message: ExtensionRequest) => {
      sent.push(message);
      if (message.type === MessageType.CdpScreenshot) {
        return { dataUrl: 'data:image/png;base64,xxxx', width: 100, height: 100 };
      }
      return { ok: true };
    }) as unknown as <T>(message: ExtensionRequest) => Promise<T>;
    return { sent, send };
  }

  it('截图始终返回 dataUrl 供 BFF 存盘', async () => {
    const { send } = screenshotSender();
    const result = await executeTool('browser_screenshot', {}, { tabId: 1, send, userInstruction: '查一下订单状态' });
    expect(result).toMatchObject({ dataUrl: 'data:image/png;base64,xxxx', width: 100, height: 100 });
  });
});
