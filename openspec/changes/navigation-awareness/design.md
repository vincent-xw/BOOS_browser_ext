## Context

模型点击链接后被导航到新域名（如 GitHub），但工具返回只说「已点击」，模型以为还在原页面，继续操作直到撞权限墙。需要扩展在写操作后主动告知导航结果。

## Goals / Non-Goals

**Goals**
- 写操作后检测是否发生导航，并把结果显式写入工具返回值。
- 提供 go_back 工具，让模型能从非预期导航中恢复。
- 系统提示词明确：导航偏离时先 go_back，不要在错误页面上继续。

**Non-Goals**
- 不自动阻止导航——有些操作本来就要跳转。
- 不自动 go_back——是否返回由模型按任务判断。
- 不做跨域的会话隔离或上下文裁剪。

## Decisions

### D1：在 Service Worker 侧比对操作前后的 URL

`chrome.tabs.get(tabId).url` 可以拿到当前 URL。click/input/press 执行前后各取一次，比较 host 与 pathname：
- host 变了 = 跨域名，最高优先级告警。
- 同 host 但 pathname 变了 = 页面跳转，提示 ref 失效。
- 都没变 = 不追加 navigation 字段，保持返回干净。

导航检测需要在动作后等一拍——CDP 点击触发导航是异步的。用 `chrome.tabs.onUpdated` 或短延时（约 300ms）等 URL 稳定。选短延时，简单可靠，不引入监听器生命周期问题。

### D2：navigation 字段结构

工具返回值追加：
```
navigation?: {
  from: string,
  to: string,
  changedDomain: boolean,
  note: string  // 给模型看的中文提示，含下一步建议
}
```
`note` 直接写模型该怎么做，例如「你已离开 example.com 到达 github.com。如果这不是预期的下载/跳转，调用 browser_go_back 返回。当前域名未授权，写操作会被拒绝。」这样模型不需要自己推理。

### D3：go_back 用 chrome.tabs.goBack

不需要 CDP。`chrome.tabs.goBack(tabId)` 是浏览器原生返回，会触发正常导航。go_back 后同样检测 URL 变化并返回，让模型确认回到了原页面。它是写操作（改变历史），需要白名单与审批——但它的目标是恢复，所以提示词里说明这是合法的恢复动作。

### D4：只在写操作后检测，读操作不检测

snapshot/read_page 本身就能看到当前 URL，不需要额外导航提示。只在 click/input_text/press_key 后检测，因为这三个是导致导航的动作。scroll 不导致导航。

## Risks / Trade-offs

- **300ms 延时拖慢每个写操作**：可接受，相比模型撞墙重试的成本小得多。只在检测到 URL 变化时才追加 note，多数点击不导航，延时后 URL 没变就直接返回。
- **go_back 可能回到非预期页面**：这是浏览器历史语义，模型在 prompt 里被告知用 snapshot 确认结果。
- **模型仍可能忽略导航提示**：但有了明确的结构化信号，比靠自觉可靠得多；prompt 强化「不要在错误页面继续」。

## Migration Plan

纯增量。新增字段向后兼容（旧工具返回无 navigation 字段时行为不变）。新增工具需要在 BFF 的工具列表与扩展白名单里同时登记。
