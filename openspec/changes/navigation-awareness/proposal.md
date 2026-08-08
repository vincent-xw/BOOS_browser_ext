## Why

模型在执行写操作（尤其点击）后，页面可能发生**跨域名/跨路径导航**（例如下载链接跳到 GitHub）。模型自己往往察觉不到，继续在「以为的原页面」上操作，要么点空、要么撞上未授权域名的权限墙，然后直接停止。根因是架构缺口：**写操作的返回值只告诉模型「点了」，不告诉它「页面已经跳到别处去了」**。

靠提示词让模型自觉判断不可靠——已经在多个场景复现它会假装还在原页面。需要扩展侧在每个写操作后主动检测导航，把「你已离开原页面」作为明确信号注入工具结果，并提供返回手段。

## What Changes

### 一、写操作后检测导航，结果里显式告知

Service Worker 在执行 click / input_text / press_key 后，读取标签页当前 URL，与操作前比较。若发生以下情况，在工具返回值里追加 `navigation` 字段：

- **跨域名**（host 变化）：最高优先级告警。明确告知模型「你已离开原页面，当前在 X」。
- **同域但路径变化**：提示页面已跳转，旧 ref 全部失效。

这是给模型的**强信号**，不是它自己猜的。

### 二、新增 `browser_go_back` 工具

让模型能返回上一页。用 `chrome.tabs.goBack`。这是「走错页面」后的标准恢复动作——比让模型自己找返回按钮更可靠（返回按钮也是个 ref，可能根本不在当前页上）。

### 三、系统提示词更新

明确写入：
- 写操作（尤其点击链接）可能导致导航，返回值里有 `navigation` 字段说明去了哪里。
- 如果导航不是任务预期的（例如点下载跳到了外部站点），应该先用 `browser_go_back` 回到原页面，不要在错误的页面上继续操作。
- 在未授权域名上无法操作，回到已授权页面继续。

### 四、快照结果包含 URL 变化提示

`browser_snapshot` 的返回里已经有 `url` 和 `title`，模型每次快照本就能看到当前页面。配合导航检测，模型有两次确认页面身份的机会。

## Capabilities

### Modified Capabilities
- `free-form-instruction`: 写操作结果新增导航检测字段；新增 go_back 工具；系统提示词增加导航偏离处理规则。

### 不动的部分
- 不自动阻止导航（用户可能确实想跳转到新页面操作）。
- 不自动 go_back（是否返回应由模型根据任务判断）。
- BFF 侧的会话/上下文管理不动。

## Impact

- `entrypoints/background.ts`: 写操作 handler 增加操作前 URL 记录与操作后导航比对，返回 `navigation` 字段。
- `src/agent/toolExecutor.ts`: 透传 navigation 字段；新增 `browser_go_back` 分支。
- `src/services/cdpSessionManager.ts` 或 background: 新增 `goBack(tabId)`，调用 `chrome.tabs.goBack`。
- `src/types/messages.ts`: 新增 `CdpGoBack` 消息类型与 `navigation` 字段类型。
- `agent-kit/examples/browser-extension-bff/src/browser-tools.ts`: 新增 `browser_go_back` 工具定义；更新 `freeFormPrompt`。
- `src/services/toolsCatalog.ts`: 同步新增 go_back 说明。
