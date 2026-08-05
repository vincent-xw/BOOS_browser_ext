import type { ObservedRequest, VerifyDimension } from '../types/cdp';

/**
 * 网络维度验证。
 *
 * 单独成模块的原因：其余验证维度在 content script 里读 DOM，而网络观测的数据源是
 * Service Worker 侧的 CDP Network 事件 —— 两者不在同一个执行上下文。
 *
 * 这替代了原先在页面上下文里改写 window.fetch 与 XMLHttpRequest.prototype 的做法。
 * 那种做法不只是不优雅：一旦 finally 没跑到（比如页面中途导航），
 * 站点的 fetch 就被永久留在被改写状态。CDP 观测在页面外部，没有这个失败模式。
 */

export interface NetworkExpectation {
  urlPattern: string;
  expectSuccess?: boolean;
}

/** 判定请求是否成功返回。2xx / 3xx 视为成功。 */
export function isSuccessful(request: ObservedRequest): boolean {
  if (request.failed) return false;
  if (request.status === undefined) return false;
  return request.status >= 200 && request.status < 400;
}

/**
 * 按期望评估已观测到的请求。
 * 预期请求在等待窗口内未发出即判定失败 —— 这正是「点击没报错但实际没生效」的典型症状。
 */
export function evaluateNetworkDimension(
  requests: readonly ObservedRequest[],
  expectation: NetworkExpectation,
): VerifyDimension {
  const matched = requests.filter((request) => request.url.includes(expectation.urlPattern));

  if (matched.length === 0) {
    return {
      dimension: 'networkRequest',
      passed: false,
      observed: `未观测到匹配 "${expectation.urlPattern}" 的请求（窗口内共 ${requests.length} 个请求）`,
    };
  }

  if (expectation.expectSuccess === false) {
    return {
      dimension: 'networkRequest',
      passed: true,
      observed: `已发出 ${matched.length} 个匹配请求：${summarize(matched)}`,
    };
  }

  const successful = matched.filter(isSuccessful);
  if (successful.length === 0) {
    return {
      dimension: 'networkRequest',
      passed: false,
      observed: `匹配请求已发出但未成功返回：${summarize(matched)}`,
    };
  }

  return {
    dimension: 'networkRequest',
    passed: true,
    observed: `匹配请求已成功返回：${summarize(successful)}`,
  };
}

/** 请求摘要。只含方法、URL 与状态码，不含请求体，避免带出业务数据。 */
function summarize(requests: readonly ObservedRequest[]): string {
  return requests
    .slice(0, 5)
    .map((request) => `${request.method} ${trimUrl(request.url)} → ${request.failed ? 'failed' : (request.status ?? 'pending')}`)
    .join('；');
}

function trimUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  return withoutQuery.length > 90 ? `${withoutQuery.slice(0, 90)}…` : withoutQuery;
}
