import { describe, expect, it, vi } from 'vitest';

import { createStepRunner, locateForAction, runGreetFlow, summarizeSteps } from './stepLoop';
import { MessageType } from '../types/messages';
import type { ExtensionRequest } from '../types/messages';

/**
 * 按消息类型返回预设响应的 sender，并记录调用顺序。
 * 顺序是这些测试的核心断言对象：闭环要求「每个写动作前都重新定位」。
 */
function scriptedSender(overrides: Record<string, unknown[]> = {}) {
  const order: string[] = [];
  const queues = new Map<string, unknown[]>(Object.entries(overrides));
  const defaults: Record<string, unknown> = {
    [MessageType.ContentLocate]: { found: true, x: 100, y: 200, matchedSelector: '.btn', selectorSource: 'site-fallback', occluded: false },
    [MessageType.CdpClick]: { ok: true, message: 'clicked' },
    [MessageType.CdpInputText]: { ok: true, message: 'typed', focused: true, actualValue: '你好' },
    [MessageType.CdpPressKey]: { ok: true, message: 'key sent' },
    [MessageType.ContentVerify]: { passed: true, dimensions: [], message: 'ok' },
    [MessageType.CdpNetworkStart]: { observing: true },
  };

  const send = (async (message: ExtensionRequest) => {
    order.push(message.type);
    const queue = queues.get(message.type);
    if (queue && queue.length > 0) return queue.shift();
    return defaults[message.type];
  }) as unknown as <T>(message: ExtensionRequest) => Promise<T>;

  return { order, send };
}

describe('locateForAction', () => {
  it('命中且可点击时返回坐标', async () => {
    const { send } = scriptedSender();
    const result = await locateForAction('greetButton', { tabId: 1, send });
    expect(result).toMatchObject({ ok: true, x: 100, y: 200 });
  });

  it('未命中时返回失败与原因', async () => {
    const { send } = scriptedSender({
      [MessageType.ContentLocate]: [{ found: false, message: '未定位到 greetButton', triedSelectors: ['.a'] }],
    });
    const result = await locateForAction('greetButton', { tabId: 1, send });
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toContain('未定位到');
  });

  it('被遮挡时拒绝点击', async () => {
    // 中心点命中的不是目标元素，点下去会作用在遮挡物上。
    const { send } = scriptedSender({
      [MessageType.ContentLocate]: [{ found: true, x: 1, y: 2, occluded: true, occludedBy: 'div.mask' }],
    });
    const result = await locateForAction('greetButton', { tabId: 1, send });
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toContain('div.mask');
  });

  it('缺少坐标时视为失败', async () => {
    const { send } = scriptedSender({ [MessageType.ContentLocate]: [{ found: true }] });
    expect((await locateForAction('greetButton', { tabId: 1, send })).ok).toBe(false);
  });
});

describe('单步闭环纪律', () => {
  it('每个写动作之前都重新定位', async () => {
    const { order, send } = scriptedSender();
    const runner = createStepRunner({ tabId: 1, send });
    await runner.clickStep('第一步', 'greetButton');
    await runner.clickStep('第二步', 'sendButton');
    // 关键断言：locate、click、locate、click —— 不是 locate、locate、click、click。
    expect(order).toEqual([
      MessageType.ContentLocate,
      MessageType.CdpClick,
      MessageType.ContentLocate,
      MessageType.CdpClick,
    ]);
  });

  it('定位失败时不下发点击', async () => {
    const { order, send } = scriptedSender({ [MessageType.ContentLocate]: [{ found: false, message: '找不到' }] });
    const runner = createStepRunner({ tabId: 1, send });
    expect(await runner.clickStep('点击', 'greetButton')).toBe(false);
    expect(order).not.toContain(MessageType.CdpClick);
  });

  it('点击失败时不执行验证', async () => {
    const { order, send } = scriptedSender({ [MessageType.CdpClick]: [{ ok: false, message: 'mousePressed 阶段失败' }] });
    const runner = createStepRunner({ tabId: 1, send });
    expect(await runner.clickStep('点击', 'greetButton', { expectDialog: '.dialog' })).toBe(false);
    expect(order).not.toContain(MessageType.ContentVerify);
  });

  it('验证未通过时返回失败', async () => {
    const { send } = scriptedSender({
      [MessageType.ContentVerify]: [{ passed: false, dimensions: [{ dimension: 'dialogAppeared', passed: false, observed: '弹窗未出现' }], message: '弹窗未出现' }],
    });
    const runner = createStepRunner({ tabId: 1, send });
    expect(await runner.clickStep('点击', 'greetButton', { expectDialog: '.dialog' })).toBe(false);
  });

  it('记录每步实际使用的坐标', async () => {
    const { send } = scriptedSender();
    const runner = createStepRunner({ tabId: 1, send });
    await runner.clickStep('点击', 'greetButton');
    const clickStep = runner.steps.find((step) => step.action === 'click');
    expect(clickStep?.coordinates).toEqual({ x: 100, y: 200 });
  });

  it('finish 指出失败发生在哪一步', async () => {
    const { send } = scriptedSender({ [MessageType.CdpClick]: [{ ok: false, message: 'mouseReleased 阶段失败' }] });
    const runner = createStepRunner({ tabId: 1, send });
    await runner.clickStep('点击打招呼按钮', 'greetButton');
    const result = runner.finish(false);
    expect(result.failedStep).toBe('点击打招呼按钮');
    expect(result.message).toContain('mouseReleased');
  });

  it('onStep 逐步回调', async () => {
    const events: string[] = [];
    const { send } = scriptedSender();
    const runner = createStepRunner({ tabId: 1, send, onStep: (record) => events.push(record.name) });
    await runner.clickStep('点击', 'greetButton', { expectDialog: '.dialog' });
    expect(events).toEqual(['点击·定位', '点击', '点击·验证']);
  });
});

describe('runGreetFlow', () => {
  it('全链路成功', async () => {
    const { order, send } = scriptedSender();
    const result = await runGreetFlow({ tabId: 1, send, message: '你好', sendUrlPattern: '/send' });
    expect(result.ok).toBe(true);
    // 三个写动作，每个前面都有一次定位（Enter 除外，这里走的是按钮）。
    expect(order.filter((type) => type === MessageType.ContentLocate)).toHaveLength(3);
    expect(order.filter((type) => type === MessageType.CdpClick)).toHaveLength(2);
    expect(order.filter((type) => type === MessageType.CdpInputText)).toHaveLength(1);
  });

  it('弹窗未出现时中止，不继续输入', async () => {
    const { order, send } = scriptedSender({
      [MessageType.ContentVerify]: [{ passed: false, dimensions: [], message: '弹窗未出现' }],
    });
    const result = await runGreetFlow({ tabId: 1, send, message: '你好' });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toContain('点击打招呼按钮');
    expect(order).not.toContain(MessageType.CdpInputText);
  });

  it('sendVia 为 enter 时用按键发送', async () => {
    const { order, send } = scriptedSender();
    await runGreetFlow({ tabId: 1, send, message: '你好', sendVia: 'enter' });
    expect(order).toContain(MessageType.CdpPressKey);
  });

  it('开启网络观测失败不阻断流程', async () => {
    const order: string[] = [];
    const send = (async (message: ExtensionRequest) => {
      order.push(message.type);
      if (message.type === MessageType.CdpNetworkStart) throw new Error('no session');
      if (message.type === MessageType.ContentLocate) return { found: true, x: 1, y: 2, occluded: false };
      if (message.type === MessageType.ContentVerify) return { passed: true, dimensions: [], message: 'ok' };
      return { ok: true, message: 'done', focused: true };
    }) as unknown as <T>(message: ExtensionRequest) => Promise<T>;
    const result = await runGreetFlow({ tabId: 1, send, message: '你好' });
    expect(result.ok).toBe(true);
  });
});

describe('summarizeSteps', () => {
  it('统计已完成步数', () => {
    expect(summarizeSteps([
      { name: 'a', action: 'click', ok: true, detail: '' },
      { name: 'b', action: 'click', ok: true, detail: '' },
    ])).toMatchObject({ total: 2, completed: 2, current: 'b' });
  });

  it('有失败步时 current 指向失败步', () => {
    expect(summarizeSteps([
      { name: 'a', action: 'click', ok: true, detail: '' },
      { name: 'b', action: 'verify', ok: false, detail: '' },
    ])).toMatchObject({ completed: 1, current: 'b' });
  });

  it('空步骤列表', () => {
    expect(summarizeSteps([])).toEqual({ total: 0, completed: 0 });
  });
});
