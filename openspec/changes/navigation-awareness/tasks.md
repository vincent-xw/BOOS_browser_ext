## 1. 导航检测

- [ ] 1.1 在 `src/types/messages.ts` 新增 `navigation` 字段类型（from/to/changedDomain/note）与 `CdpGoBack` 消息类型。
- [ ] 1.2 在 background 新增辅助函数 `detectNavigation(tabId, beforeUrl)`：等待约 300ms 后读取当前 URL，比较 host/pathname，返回 navigation 信息或 undefined。
- [ ] 1.3 CdpClick handler：执行前记录 URL，执行后调用 detectNavigation，把结果合并进返回值。
- [ ] 1.4 CdpInputText handler：同上（输入后按回车可能触发导航）。
- [ ] 1.5 CdpPressKey handler：同上（按 Enter/空格可能触发导航）。
- [ ] 1.6 note 文案分两种：跨域名时提示「你已离开 X 到达 Y，若非预期跳转请用 browser_go_back 返回，当前域名未授权写操作会被拒绝」；同域路径变化时提示「页面已跳转，旧 ref 已失效，请重新快照」。

## 2. browser_go_back 工具

- [ ] 2.1 在 `cdpSessionManager` 或 background 新增 `goBack(tabId)`，调用 `chrome.tabs.goBack`。
- [ ] 2.2 新增 `CdpGoBack` 消息，handler 调用 goBack 后同样检测导航并返回结果。
- [ ] 2.3 toolExecutor 新增 `browser_go_back` 分支，走 CDP 消息通道。
- [ ] 2.4 go_back 加入白名单 `TOOL_ALLOWLIST`（写操作，但恢复用）。
- [ ] 2.5 BFF 侧 `browser-tools.ts` 新增 `browser_go_back` 工具定义与 schema，加入工具列表。
- [ ] 2.6 `toolsCatalog.ts` 同步新增 go_back 的中文说明。

## 3. 提示词更新

- [ ] 3.1 `freeFormPrompt` 增加导航偏离处理段：写操作可能导致导航；看返回值的 navigation 字段；非预期跳转先 go_back；未授权域名写操作被拒绝时回去继续。
- [ ] 3.2 在注意事项中补充：不要在错误的页面上继续假装操作原页面。

## 4. 收尾验证

- [ ] 4.1 `pnpm run typecheck` 通过（扩展侧）。
- [ ] 4.2 `pnpm vitest run` 全绿；新增导航检测的单测（host 变化、path 变化、无变化）。
- [ ] 4.3 BFF 侧 typecheck 通过。
- [ ] 4.4 手动：点击链接触发跨域跳转后，模型收到 navigation.changedDomain 提示并调用 go_back。
- [ ] 4.5 手动：go_back 后回到原页面，任务继续。
