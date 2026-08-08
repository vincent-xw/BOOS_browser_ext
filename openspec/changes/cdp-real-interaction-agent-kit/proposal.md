## Why

当前扩展的所有页面写操作都是 DOM 层合成事件（`src/services/chromeMcpService.ts:846-866` 的 `pointerdown/mousedown/mouseup/click` 序列、`:257-280` 的 `input.value = text` + `dispatchEvent('input')`）。这些事件的 `event.isTrusted` 恒为 `false`，无法触发 BOSS 直聘前端框架依赖的真实焦点流转、用户激活（user activation）判定与输入法路径，导致「打招呼 / 收藏 / 发消息」这类关键动作时灵时不灵——现有代码不得不用 monkey-patch `window.fetch` 与 `XMLHttpRequest`（`:785-846`）事后猜测是否成功，且工作流已经退化成「只读列表预览文本、不再点开详情」。

同时 AI 能力目前是 `src/services/llmService.ts` 里一次性的批量评估调用（无工具、无多轮、无会话），Ark API Key 明文存在 `localStorage`（`settingsService.ts:192`），既不具备 agent 的分步决策能力，也不满足密钥不落浏览器的安全要求。

## What Changes

### 一、页面交互改为 chrome.debugger + CDP（真实事件）

- 新增 `debugger` 权限，新增 Service Worker 侧的 CDP 会话管理器：任务开始 `chrome.debugger.attach({ tabId }, '1.3')`，整个任务期间保持单一连接，任务结束/异常/标签页关闭/用户停止时 `detach`，并监听 `chrome.debugger.onDetach` 处理用户关闭调试横幅、打开 DevTools、标签页关闭三类断连。
- 新增真实输入原语：点击走 `Input.dispatchMouseEvent` 的 `mouseMoved → mousePressed → mouseReleased` 三段序列；文本（含中文）走 `Input.insertText`；Enter / 快捷键 / 特殊键走 `Input.dispatchKeyEvent`。坐标使用相对主页面 viewport 的 CSS 像素，**不乘 `devicePixelRatio`**。
- **BREAKING**：删除 `element.click()`、`element.dispatchEvent(new MouseEvent(...))`、`input.value = ...`、`element.textContent = ...` 这四类写路径。`chromeMcpService` 的 `clickFavoriteButton`、`openCandidateDetail`、`writeWithTabsScripting` 全部改为「DOM 只读定位 + CDP 执行」。
- 引入真正的 content script（当前项目**没有** `content_scripts`，全靠 `chrome.scripting.executeScript` 按需注入），承担 DOM 读取、元素定位、`getBoundingClientRect()` 坐标计算与结果验证三件事。
- 新增单步执行闭环：每一步都「重新定位 → 重新算坐标 → 执行一个 CDP 动作 → 等待页面更新 → 验证 → 再下一步」。禁止一次性缓存多个坐标连续点击（弹窗、滚动、虚拟列表、重渲染都会让坐标失效）。
- 新增结果验证器：不再以「点击没抛错」为成功。验证维度包括弹窗是否出现、DOM 状态/文案是否变化、输入框内容是否更新、发送按钮是否变为可用、相关 Network 请求是否发出且成功返回。Network 观测从 monkey-patch 页面全局改为 CDP `Network` 域事件。

### 二、Agent 能力通过 agent-kit 接入，并改为 BFF 模式

- 扩展降级为 **Tool Host**：不再持有模型 Endpoint / 模型名 / API Key。`POST /v1/agent/sessions/:sessionId/run` 拿到 `pending_tool_call` 后，只执行白名单内的 `execution: 'remote'` 工具，再 `POST /v1/agent/sessions/:sessionId/tool-results/:callId` 回填。
- **BREAKING**：设置面板移除 LLM Endpoint、模型、API Key 三项，改为 BFF 地址 + 接入 token（该 token 不是 LLM API Key）。`ark.cn-beijing.volces.com` 从 `host_permissions` 移除。已存的 Ark key 需迁移清理。
- 新增 BFF 服务（基于 agent-kit 的 `@agent-kit/bff-hono` + `@agent-kit/adapter-sqlite`），由它持有 Ark（OpenAI Chat 兼容）配置，环境变量 `AGENT_KIT_MASTER_KEY` + `BFF_API_TOKEN`。
- 把 CDP 原语注册为 agent 工具：`browser.read_page`、`browser.locate_element`、`browser.click`、`browser.input_text`、`browser.press_key`、`browser.scroll`、`browser.verify`、`browser.screenshot`。
- **在 agent-kit 仓库内补齐阻塞性缺陷**（开发期用 pnpm workspace 依赖，生产期由用户手动发布到 npm 后本项目改为 npm 依赖）：
  - `packages/core/src/llm-client.ts:86-89` 请求体缺 `tools` 字段——模型永远收不到工具清单，工具调用链路实际不可达。需新增 zod→JSON Schema 转换并注入 `tools`。
  - `role: 'tool'` 消息缺 `tool_call_id`（`llm-client.ts:33-38`），真实 OpenAI 兼容端点会返回 400。
  - assistant 轮次从不入库（`contracts.ts:15` 的 `SessionMessage` 只有 `user`/`tool`），模型看不到自己的上一轮输出。
  - 每轮只取第一个 tool call（`llm-client.ts:51-64`），需支持并行工具调用。
  - 工具执行无 timeout / AbortSignal，卡住的工具会永久挂住 harness 循环。
  - `RegisteredPrompt.protocol` 与 `ContextManager` 声明了但从未接入。

## Capabilities

### New Capabilities
- `cdp-real-interaction`: chrome.debugger 会话生命周期管理、CDP 真实鼠标/键盘/文本原语、坐标计算契约、断连恢复。
- `dom-locate-and-verify`: content script 侧的元素定位（用户配置选择器优先、站点 fallback 兜底）、坐标计算、以及多维度结果验证（DOM / 弹窗 / 输入框 / 按钮可用性 / Network）。
- `agent-tool-host`: 扩展作为 Tool Host 与 BFF 的运行协议——发起 run、接收 pending_tool_call、白名单校验、执行、回填、会话在 SW 挂起后的恢复。
- `agent-kit-runtime-completion`: agent-kit `@agent-kit/core` 的工具调用链路补齐（tools 注入、JSON Schema 转换、tool_call_id、assistant 持久化、并行调用、工具超时）。
- `agent-bff-service`: BFF 服务的部署形态、鉴权、密钥持有边界与日志红线。

### Modified Capabilities
- `chrome-mcp-page-io`: 写操作从「合成事件」改为「CDP 真实事件」；`ProviderKind` 新增 CDP 通道；跨 frame 的「聚合取最优」读取契约需在 CDP 单 target 模型下重新表达；新增单步执行闭环与验证要求。
- `extension-foundation`: 新增 `debugger` 权限与 content script 声明；移除 Ark host permission；新增 BFF host permission。
- `extension-settings-management`: 移除 Endpoint / 模型 / API Key 三项配置，新增 BFF 地址与接入 token；需要对已存旧配置做迁移与清理。

## Impact

**本项目改动面**
- `wxt.config.ts:14-16`：permissions 增 `debugger`，host_permissions 移除 Ark、新增 BFF 地址，新增 `content_scripts`。
- `src/services/chromeMcpService.ts`（1797 行）：所有写路径重写，读路径保留；`:785-873` 的 fetch/XHR monkey-patch 整段废弃。
- `src/services/llmService.ts`（359 行）：Ark 直连删除，改为调 BFF。
- `src/services/settingsService.ts` / `src/types/settings.ts`：配置项增删 + 迁移。
- `entrypoints/background.ts`：新增 CDP 会话管理器与消息路由（当前只有 1 个消息类型 `BOOS_GET_LAST_GEEK_LIST_URL`，需要真正的 message 路由层）；`webRequest` 观测可被 CDP `Network` 域替代。
- `src/composables/usePageIoController.ts:376-522`：线性循环改为 agent 驱动的单步闭环。
- 新增 `entrypoints/content.ts` 与 `src/agent/` 目录。
- `src/services/diagnosticService.ts`：探针需覆盖 attach 状态与 CDP 可用性。

**跨仓库改动**
- `agent-kit/packages/core/src/{llm-client,harness,contracts,tool-registry}.ts` + 新增 JSON Schema 转换模块与对应测试。
- 开发期：`pnpm-workspace.yaml` 纳入 `../agent-kit/packages/*`，或 `"@agent-kit/core": "file:../agent-kit/packages/core"`。生产期：改为 npm 版本号依赖。
- agent-kit 各包 `"private": true` 需在发布前解除。

**风险**
- `chrome.debugger.attach` 会在标签页顶部常驻「正在被调试」横幅，用户手动关闭即触发 `onDetach`——必须有清晰的降级提示，这是不可消除的 UX 成本。
- 同一标签页只能有一个调试客户端，用户打开 DevTools 会抢占连接。
- 引入 BFF 意味着实验门槛变高（需额外跑一个 Node 进程），须在文档中给出一条命令的启动路径。
