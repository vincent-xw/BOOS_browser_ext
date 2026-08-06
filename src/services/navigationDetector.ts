/**
 * 导航检测的纯逻辑部分——抽出来便于单测，也避免 background 闭包过深。
 *
 * 给定操作前后的 URL，判断是否发生了值得告知模型的导航，并生成给模型看的中文提示。
 * 跨域名是最高优先级信号；同域路径变化也提示 ref 失效。
 */

export interface NavigationDetection {
  from: string;
  to: string;
  changedDomain: boolean;
  note: string;
}

/**
 * 比较两个 URL，返回导航信息；未发生有意义的导航时返回 undefined。
 *
 * @param before 操作前的完整 URL
 * @param after 操作后的完整 URL
 */
export function detectUrlChange(before: string | undefined, after: string | undefined): NavigationDetection | undefined {
  if (!before || !after || before === after) return undefined;

  let fromHost = '';
  let toHost = '';
  let fromPath = '';
  let toPath = '';
  try {
    const beforeUrl = new URL(before);
    const afterUrl = new URL(after);
    fromHost = beforeUrl.host;
    toHost = afterUrl.host;
    fromPath = beforeUrl.pathname;
    toPath = afterUrl.pathname;
  } catch {
    return undefined;
  }

  const changedDomain = fromHost !== toHost;
  const changedPath = fromPath !== toPath;
  if (!changedDomain && !changedPath) return undefined;

  let note: string;
  if (changedDomain) {
    note =
      `你已离开原页面 ${fromHost}，当前在 ${toHost}。` +
      '如果这不是预期的跳转（例如下载链接跳到了外部站点），调用 browser_go_back 返回原页面继续。' +
      '在未授权域名上写操作会被拒绝，不要在这个页面继续操作。';
  } else {
    note = '页面已跳转到新路径，之前的 ref 已全部失效，请重新调用 browser_snapshot。';
  }
  return { from: before, to: after, changedDomain, note };
}
