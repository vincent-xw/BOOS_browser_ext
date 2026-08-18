import { afterEach, describe, expect, it, vi } from 'vitest';

import { BffError, checkBffConnectivity, runAgent, startExecute, submitToolResult } from './agentClient';
import type { AgentRunResult } from './agentClient';

const config = { baseUrl: 'http://localhost:8787', apiToken: 'token-1' };

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

describe('startExecute', () => {
  it('POSTs to /api/execute and returns on 202', async () => {
    const { calls } = stubResponses({ status: 202, body: { accepted: true } });
    await startExecute(config, 's-1', '你好', { currentUrl: 'https://example.com' });
    expect(calls[0]!.url).toBe('http://localhost:8787/api/execute');
    expect(calls[0]!.body).toMatchObject({ sessionId: 's-1', input: '你好' });
  });

  it('passes promptName when provided', async () => {
    const { calls } = stubResponses({ status: 202, body: { accepted: true } });
    await startExecute(config, 's-1', '评估', {}, 'candidate-assessment');
    expect(calls[0]!.body).toMatchObject({ promptName: 'candidate-assessment' });
  });

  it('omits promptName when not provided', async () => {
    const { calls } = stubResponses({ status: 202, body: { accepted: true } });
    await startExecute(config, 's-1', 'hi', {});
    expect(calls[0]!.body).not.toHaveProperty('promptName');
  });

  it('sends Bearer token', async () => {
    const { fetchMock } = stubResponses({ status: 202, body: { accepted: true } });
    await startExecute(config, 's-1', 'hi', {});
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-1');
  });
});

describe('submitToolResult', () => {
  it('POSTs to /api/tool-results/:callId with sessionId in body', async () => {
    const { calls } = stubResponses({ status: 202, body: { accepted: true } });
    await submitToolResult(config, 'c1', 's-1', { ok: true });
    expect(calls[0]!.url).toBe('http://localhost:8787/api/tool-results/c1');
    expect(calls[0]!.body).toMatchObject({ sessionId: 's-1', output: { ok: true } });
  });
});

describe('runAgent', () => {
  it('returns final result for planning phase', async () => {
    stubResponses({ body: finalResult });
    const result = await runAgent(config, 's-1', '计划', {}, 'planning', true);
    expect(result).toEqual({ type: 'final', output: '完成' });
  });
});

describe('错误处理', () => {
  it('401 转为可操作的配置提示', async () => {
    stubResponses({ status: 401, body: { code: 'UNAUTHORIZED', requestId: 'req-1', message: '未通过 BFF 鉴权' } });
    await expect(startExecute(config, 's-1', '你好', {})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('401 提示指向设置项而非底层原因', async () => {
    stubResponses({ status: 401, body: { code: 'UNAUTHORIZED', requestId: 'req-1', message: '未通过 BFF 鉴权' } });
    const error = await startExecute(config, 's-1', '你好', {}).catch((e: unknown) => e);
    expect((error as BffError).message).toContain('BFF 地址与接入 token');
  });

  it('网络不可达转为 NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Failed to fetch');
    }));
    await expect(startExecute(config, 's-1', '你好', {})).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('业务错误码原样透出', async () => {
    stubResponses({ status: 500, body: { code: 'SECRET_NOT_CONFIGURED', requestId: 'req-2', message: '密钥未配置' } });
    await expect(submitToolResult(config, 'c1', 's-1', {})).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' });
  });
});

describe('checkBffConnectivity', () => {
  it('可达且凭据有效', async () => {
    stubResponses({ body: finalResult });
    await expect(checkBffConnectivity(config)).resolves.toMatchObject({ ok: true, reason: 'reachable' });
  });

  it('凭据无效与地址不可达要能区分开', async () => {
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
