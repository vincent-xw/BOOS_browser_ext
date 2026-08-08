import { describe, expect, it } from 'vitest';

import { evaluateNetworkDimension, isSuccessful } from './networkVerifier';
import type { ObservedRequest } from '../types/cdp';

/** 构造一条观测记录。 */
function request(overrides: Partial<ObservedRequest> = {}): ObservedRequest {
  return { url: 'https://www.zhipin.com/wapi/zpgeek/favorite', method: 'POST', status: 200, timestamp: 1, ...overrides };
}

describe('isSuccessful', () => {
  it('2xx 视为成功', () => {
    expect(isSuccessful(request({ status: 200 }))).toBe(true);
    expect(isSuccessful(request({ status: 204 }))).toBe(true);
  });

  it('3xx 视为成功', () => {
    expect(isSuccessful(request({ status: 302 }))).toBe(true);
  });

  it('4xx / 5xx 视为失败', () => {
    expect(isSuccessful(request({ status: 403 }))).toBe(false);
    expect(isSuccessful(request({ status: 500 }))).toBe(false);
  });

  it('尚未返回视为未成功', () => {
    expect(isSuccessful(request({ status: undefined }))).toBe(false);
  });

  it('加载失败视为失败', () => {
    expect(isSuccessful(request({ failed: true, status: undefined }))).toBe(false);
  });
});

describe('evaluateNetworkDimension', () => {
  it('匹配请求成功返回时通过', () => {
    const result = evaluateNetworkDimension([request()], { urlPattern: 'favorite' });
    expect(result.passed).toBe(true);
    expect(result.dimension).toBe('networkRequest');
    expect(result.observed).toContain('已成功返回');
  });

  it('预期请求未发出时失败并报告请求总数', () => {
    // 这是「点击没报错但实际没生效」最典型的症状，必须能判出来。
    const result = evaluateNetworkDimension([request({ url: 'https://www.zhipin.com/other' })], { urlPattern: 'favorite' });
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('未观测到匹配');
    expect(result.observed).toContain('共 1 个请求');
  });

  it('完全没有观测到请求时失败', () => {
    const result = evaluateNetworkDimension([], { urlPattern: 'favorite' });
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('共 0 个请求');
  });

  it('请求已发出但返回 4xx 时失败', () => {
    const result = evaluateNetworkDimension([request({ status: 403 })], { urlPattern: 'favorite' });
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('未成功返回');
    expect(result.observed).toContain('403');
  });

  it('请求已发出但尚未返回时失败', () => {
    const result = evaluateNetworkDimension([request({ status: undefined })], { urlPattern: 'favorite' });
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('pending');
  });

  it('expectSuccess 为 false 时只要求请求发出', () => {
    const result = evaluateNetworkDimension([request({ status: 500 })], { urlPattern: 'favorite', expectSuccess: false });
    expect(result.passed).toBe(true);
  });

  it('多个匹配中有一个成功即通过', () => {
    const result = evaluateNetworkDimension(
      [request({ status: 500 }), request({ status: 200 })],
      { urlPattern: 'favorite' },
    );
    expect(result.passed).toBe(true);
  });

  it('摘要不包含请求体，避免带出业务数据', () => {
    const result = evaluateNetworkDimension(
      [request({ url: 'https://www.zhipin.com/wapi/zpgeek/favorite?securityId=SECRET-TOKEN' })],
      { urlPattern: 'favorite' },
    );
    expect(result.observed).not.toContain('SECRET-TOKEN');
  });
});
