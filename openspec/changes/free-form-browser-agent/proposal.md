## Why

上一轮把页面交互换成了 CDP 真实事件，但动作序列是硬编码的：`runGreetFlow` 写死了
「点打招呼 → 输入 → 发送」，`locate_element` 只接受写死的 8 个 BOSS 角色枚举
（`greetButton` / `favoriteButton` / …）。

两个直接问题：

1. **BOSS 页面反复调试会触发风控**，而调试正是当前最需要做的事。
2. **细化到具体 action 都写死，限制太死**。agent-kit 已经进入 harness 阶段，
   却只被用来跑固定序列，等于 harness 白搭。

目标：调试期换到低风控页面，动作由用户下自然语言指令、agent 自主规划。未来重接 BOSS 时
只需写 prompt 而不必写代码。

一个有利的现状：`runAgentSession` 与 `executeTool` 上一轮已写好但**从未接到 UI**
（UI 走的是 `handleRunWorkflow` 的批量评估路径），所以这次主要是接线 + 补能力。

## What Changes

### 一、先修 agent-kit 的三个缺陷

都在要依赖的 harness/context 层上，均已实测复现。

- **提示词永远只用第一个注册的**：`harness.ts` 死取 `prompts.getDefault()`。BFF 先注册
  `browser-automation`，导致 `candidate-assessment` 的 `protocol` 永远不可达 ——
  上一轮"修好"的输出协议校验在评估路径上根本没生效。`run()` 新增可选 `promptName`，
  `resume()` 沿用发起调用时的提示词（否则一次工具循环的前后两半会用不同协议）。
- **上下文裁剪切断 assistant/tool 配对**：`slice(-maxMessages)` 在 maxMessages=1 时
  把 `[user, assistant(c1), tool(c1)]` 裁成 `[tool(c1)]` —— 孤立的 `tool_call_id`
  会让真实 OpenAI 兼容端点返回 400。改为以「assistant + 其全部 tool 结果」为不可分割单元。
- **裁剪摘要对模型不可见**：`getSummary()` 的返回值从未被读取，模型不知道自己丢了上下文。
  改为作为 system 消息前置。

### 二、快照 + ref 引用（核心）

- 新增 `browser.snapshot`：返回视口内可交互元素的索引表（ref / tag / label / kind /
  坐标 / 遮挡与禁用状态）。模型按 ref 指定目标，不写选择器。
- `browser.click` 与 `browser.input_text` 接受 `ref`，**执行前**按 ref 重新解析坐标 ——
  「每步重算坐标」由执行侧保证，而不是指望模型自觉。ref 稳定、坐标易失效。
- 元素已卸载时返回 `stale`，模型应重新快照而非重试同一个 ref。
- **BREAKING**：`locate_element` 的 `role` 改为可选，`ElementLocator` 支持 `ref`。
  `ElementRole` 与站点兜底选择器保留，降级为预设流程专用。

### 三、权限与执行边界

- **BREAKING**：manifest 改用 `optional_host_permissions: ['*://*/*']`，用户在设置里
  添加域名时才发起 `chrome.permissions.request`；content script 改为
  `chrome.scripting.registerContentScripts` 动态注册，不再硬绑 zhipin.com。
- 新增 URL 白名单（`{domain, pathPrefix?, pathPattern?}`），每个写动作下发前在
  **Service Worker 侧**校验当前 tab URL —— 放 UI 侧的话绕过 UI 直接发消息就失效了。
- 新增逐步审批：读工具自动放行，写工具弹确认，三档授权（本次 / 本会话该类动作 /
  该域名永久）。被拒绝的动作以 `USER_DENIED` 回填给模型，让它知道动作没发生。

### 四、多轮对话

同一 sessionId 连续下指令。harness 本就 load 既有历史再 append 保存，无需改动 ——
UI 侧维持会话 id 与消息列表即可，这样「点第三条结果」「回到上一页」这类指代才成立。

### 五、预设流程并存

`runGreetFlow` / `favoriteCandidate` / `cdpActionService` 与批量评估路径全部保留，
UI 上作为另一个 tab。等自由指令调到可用后再删。

## Capabilities

### New Capabilities
- `page-element-discovery`: 可交互元素快照、ref 注册表与 ref→坐标解析（含 stale 判定）。
- `free-form-instruction`: 用户自然语言指令驱动的 agent 规划执行与多轮会话上下文。
- `write-action-guardrails`: URL 白名单 + 逐步审批双闸门，含三档授权与持久化。
- `dynamic-host-permission`: 运行时按域名申请 host 权限与动态注册 content script。

### Modified Capabilities
- `agent-tool-host`: 工具集增至 9 个；工具按只读/写划分；写工具需过审批门；`run` 支持
  按名选择提示词。
- `dom-locate-and-verify`: 定位支持 ref 与纯 selector，`role` 不再必填；快照跨 frame
  合并而非取最优。
- `agent-kit-runtime-completion`: 提示词按名选择、裁剪配对完整性、摘要注入。
- `extension-settings-management`: 新增写操作白名单与免审批授权的管理界面。
- `extension-foundation`: host 权限改为运行时申请；content script 动态注册。

## Impact

**agent-kit**：`packages/core/src/{harness,prompt-registry,context-manager,contracts,
errors,llm-client}.ts`；`packages/adapter-sqlite`（挂起调用表新增 `prompt_name` 列，
带既有库文件的 ALTER 兼容）；`packages/bff-hono`（run 路由接受 `promptName`）；
`examples/browser-extension-bff/src/{browser-tools,server}.ts`（新增快照工具与自由指令提示词）。

**BOOS_browser_ext**：`wxt.config.ts`；`entrypoints/{background,content}.ts`；
`src/services/{domLocator,urlAllowlist,permissionService}.ts`；
`src/agent/{toolExecutor,agentClient,approvalGate}.ts`；
`src/composables/useFreeFormController.ts`；
`src/components/{FreeFormPanel,ExtensionSettingsPanel}.vue`；`entrypoints/sidepanel/App.vue`。

**风险**
- 自由指令下模型可能规划出预期外的动作序列。缓解手段是双闸门 + 逐步审批，且两者默认都偏严
  （空白名单拒绝一切、无审批界面时拒绝写操作）。
- `optional_host_permissions: ['*://*/*']` 意味着用户理论上可授权任意站点。这是调试期
  自由度的必要代价，通过白名单与审批限制实际可达范围。
- 快照上限 150 条，超出会截断。必须把 `truncated` 告知模型，否则它会以为看到了整页。
