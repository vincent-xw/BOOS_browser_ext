import { afterEach, describe, expect, it, vi } from 'vitest';

import { BffError, checkBffConnectivity, runAgentSession, submitToolResult } from './agentClient';
import type { AgentRunResult } from './agentClient';
import type { ExtensionRequest } from '../types/messages';

const config = { baseUrl: 'http://localhost:8787', apiToken: 'token-1' };

/** 一个总是成功的消息发送器。 */
const okSender = (async () => ({ ok: true, message: 'done' })) as unknown as <T>(message: ExtensionRequest) => Promise<T>;

/** 按顺序返回预设响应的 fetch stub。 */
function stubResponses(...responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const current = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: (current?.status ?? 200) < 400,
      status: current?.status ?? 200,
      json: async () => current?.body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const finalResult: AgentRunResult = { type: 'final', output: '完成' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runAgentSession', () => {
  it('直接返回 final 时不执行任何工具', async () => {
    stubResponses({ body: finalResult });
    const steps: string[] = [];
    const result = await runAgentSession('你好', {
      config,
      sessionId: 's-1',
      tabId: 1,
      send: okSender,
      onStep: (event) => steps.push(event.toolName),
    });
    expect(result).toEqual({ output: '完成', steps: 0 });
    expect(steps).toEqual([]);
  });

  it('执行挂起工具并回填后拿到 final', async () => {
    stubResponses(
      { body: { type: 'pending_tool_calls', calls: [{ callId: 'c1', toolName: 'browser.click', input: { x: 1, y: 2 } }] } },
      { body: finalResult },
    );
    const result = await runAgentSession('点击', { config, sessionId: 's-1', tabId: 1, send: okSender });
    expect(result.output).toBe('完成');
    expect(result.steps).toBe(1);
  });

  it('同轮多个调用逐个回填', async () => {
    const { calls } = stubResponses(
      {
        body: {
          type: 'pending_tool_calls',
          calls: [
            { callId: 'c1', toolName: 'browser.click', input: { x: 1, y: 2 } },
            { callId: 'c2', toolName: 'browser.press_key', input: { key: 'Enter' } },
          ],
        },
      },
      // 第一个回填后仍挂起（还剩 c2），第二个回填后才 final。
      { body: { type: 'pending_tool_calls', calls: [{ callId: 'c2', toolName: 'browser.press_key', input: { key: 'Enter' } }] } },
      { body: finalResult },
    );
    const result = await runAgentSession('组合动作', { config, sessionId: 's-1', tabId: 1, send: okSender });
    expect(result.steps).toBe(2);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:8787/v1/agent/sessions/s-1/run',
      'http://localhost:8787/v1/agent/sessions/s-1/tool-results/c1',
      'http://localhost:8787/v1/agent/sessions/s-1/tool-results/c2',
    ]);
  });

  it('白名单外的工具回填未授权结果且不执行页面动作', async () => {
    const sent: ExtensionRequest[] = [];
    const send = (async (message: ExtensionRequest) => {
      sent.push(message);
      return { ok: true };
    }) as unknown as <T>(message: ExtensionRequest) => Promise<T>;
    const { calls } = stubResponses(
      { body: { type: 'pending_tool_calls', calls: [{ callId: 'c1', toolName: 'browser.evaluate', input: {} }] } },
      { body: finalResult },
    );
    const events: Array<{ toolName: string; allowed: boolean }> = [];
    await runAgentSession('注入脚本', { config, sessionId: 's-1', tabId: 1, send, onStep: (event) => events.push(event) });
    expect(events[0]).toMatchObject({ toolName: 'browser.evaluate', allowed: false });
    expect(sent).toHaveLength(0);
    expect(calls[1]?.body).toMatchObject({ output: { code: 'TOOL_NOT_ALLOWED' } });
  });

  it('达到最大步数时中止', async () => {
    // 模型持续要求工具调用时必须有硬上限，否则会一直循环下去。
    stubResponses({ body: { type: 'pending_tool_calls', calls: [{ callId: 'c1', toolName: 'browser.click', input: { x: 1, y: 1 } }] } });
    await expect(
      runAgentSession('循环', { config, sessionId: 's-1', tabId: 1, send: okSender, maxSteps: 3 }),
    ).rejects.toMatchObject({ code: 'STEP_LIMIT' });
  });

  it('收到停止信号时中止', async () => {
    stubResponses({ body: { type: 'pending_tool_calls', calls: [{ callId: 'c1', toolName: 'browser.click', input: { x: 1, y: 1 } }] } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgentSession('停止', { config, sessionId: 's-1', tabId: 1, send: okSender, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('请求携带 Bearer 接入 token', async () => {
    const { fetchMock } = stubResponses({ body: finalResult });
    await runAgentSession('你好', { config, sessionId: 's-1', tabId: 1, send: okSender });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-1');
  });
});

describe('错误处理', () => {
  it('401 转为可操作的配置提示', async () => {
    stubResponses({ status: 401, body: { code: 'UNAUTHORIZED', requestId: 'req-1', message: '未通过 BFF 鉴权' } });
    await expect(runAgentSession('你好', { config, sessionId: 's-1', tabId: 1, send: okSender })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('401 提示指向设置项而非底层原因', async () => {
    stubResponses({ status: 401, body: { code: 'UNAUTHORIZED', requestId: 'req-1', message: '未通过 BFF 鉴权' } });
    const error = await runAgentSession('你好', { config, sessionId: 's-1', tabId: 1, send: okSender }).catch((e: unknown) => e);
    expect((error as BffError).message).toContain('BFF 地址与接入 token');
  });

  it('网络不可达转为 NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Failed to fetch');
    }));
    await expect(runAgentSession('你好', { config, sessionId: 's-1', tabId: 1, send: okSender })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('业务错误码原样透出', async () => {
    stubResponses({ status: 500, body: { code: 'SECRET_NOT_CONFIGURED', requestId: 'req-2', message: '密钥未配置' } });
    await expect(submitToolResult(config, 's-1', 'c1', {})).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' });
  });
});

describe('checkBffConnectivity', () => {
  it('可达且凭据有效', async () => {
    stubResponses({ body: finalResult });
    await expect(checkBffConnectivity(config)).resolves.toMatchObject({ ok: true, reason: 'reachable' });
  });

  it('凭据无效与地址不可达要能区分开', async () => {
    // 这两种情况的处置完全不同：一个改 token，一个查服务有没有起。
    stubResponses({ status: 401, body: { code: 'UNAUTHORIZED', requestId: 'r', message: 'x' } });
    await expect(checkBffConnectivity(config)).resolves.toMatchObject({ ok: false, reason: 'unauthorized' });
  });

  it('地址不可达', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Failed to fetch');
    }));
    await expect(checkBffConnectivity(config)).resolves.toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('返回业务错误码说明通路与鉴权都是通的', async () => {
    stubResponses({ status: 500, body: { code: 'SECRET_NOT_CONFIGURED', requestId: 'r', message: 'x' } });
    await expect(checkBffConnectivity(config)).resolves.toMatchObject({ ok: true, reason: 'reachable' });
  });
});
