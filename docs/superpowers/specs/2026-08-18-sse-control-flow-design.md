# 浏览器插件 SSE 控制流翻转设计

日期：2026-08-18

## 背景

当前浏览器插件与 BFF 的通信模式是插件侧驱动的 HTTP 轮询：

1. 插件 POST `/run` → 拿到 `pending_tool_calls`
2. 插件本地执行工具（CDP / content script）
3. 插件 POST `/tool-results/:callId` → 拿到下一轮结果
4. 循环直到 `final`

问题：
- 等待 LLM 响应期间 UI 只能显示"running"，没有实时状态
- 控制逻辑（循环、审批、错误处理）全堆在插件侧，BFF 是被动的
- 每次 tool-results 响应都可能携带下一轮 pending_tool_calls，职责不清晰

## 目标

把 agent loop 的驱动方从插件翻转到 BFF。BFF 通过 SSE 主动推送 `tool_call` 事件给插件，插件执行后通过 HTTP 回传结果。SSE 同时推送 LLM 请求/响应状态。

## 架构

```
插件: POST /api/execute（启动，立即返回 202）
       ↓ SSE 连接 ← ← ← ← ← ← ← ← ← ←
       ↓                            ↑
       ↓ tool_call 事件             │ POST /tool-results（只回结果，返回 202）
       ↓ → 审批 → executeTool → → →┘
       ↓ final/error 事件结束

BFF:  POST /api/execute → harness.run()
       → pending_tool_calls 时通过 EventBus 推 SSE
       → /tool-results 收到后 harness.resume()
       → 继续推事件，直到 final
```

### 职责划分

| 组件 | 职责 |
|---|---|
| BFF | 驱动 agent loop、调 LLM、发 tool_call/final 事件、持有 EventBus |
| 插件 SSE 客户端 | 监听事件、执行工具、回传结果、更新 UI |
| 插件 background | CDP/content script 操作（不变） |
| 插件 sidepanel Vue | UI 展示、审批对话框（不变） |

### 不变的部分

- 计划阶段：POST `/v1/agent/sessions/:id/run` with `skipTools=true`，同步返回 TaskPlan
- 工具执行逻辑：`toolExecutor.ts`、`background.ts` 的 CDP/content script 路由
- 审批门：`approvalGate.ts`，从轮询循环挪到 SSE 事件处理器
- sessionId 机制、SQLite 持久化、prompt 注册
- BFF 仍用 `scopedSessionId = ${subject}:${sessionId}`，插件只传原始 sessionId

## SSE 事件协议

### 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/events?token=xxx` | SSE 事件流（EventSource） |
| POST | `/api/execute` | 启动执行（立即返回 202，后续走 SSE） |

### 现有端点变化

- `POST /v1/agent/sessions/:id/run` — 不变（计划阶段 skipTools=true）
- `POST /v1/agent/sessions/:id/tool-results/:callId` — 改为返回 202，不再返回 agent 结果

### 事件类型

```
tool_call    data: { callId, toolName, input, sessionId }
final        data: { output, reasoning?, sessionId }
error        data: { code, message, sessionId? }
llm_request  data: { model, messageCount, toolCount }
llm_response data: { durationMs, finishReason, toolCallCount }
```

### 执行流程

1. sidepanel 打开时建立 EventSource 连接（必须在提交指令前完成）
2. 用户提交 → POST `/api/execute` with `{ input, context, sessionId, promptName? }`
3. BFF 调 `harness.run()`，拿到 `pending_tool_calls` → 通过 bus 逐个发 `tool_call` 事件
4. 插件收到 `tool_call` → 审批门（写操作）→ `executeTool()` → POST `/tool-results/:callId`
5. BFF 的 `/tool-results` handler 调 `harness.resume()`：
   - 返回新的 `pending_tool_calls` → 继续发 `tool_call`（用 dispatched Set 去重）
   - 返回 `final` → 发 `final` 事件
   - 抛异常 → 发 `error` 事件
6. 插件收到 `final` → 追加 agent turn，标记完成

### 断线重连

EventSource 自动重连，浏览器带 `Last-Event-ID`，EventBus 缓冲 200 条事件（同 Flutter BFF）重放断开期间的事件。

注意：首次连接不重放缓冲（无 Last-Event-ID），因此插件必须在 POST `/api/execute` 前建立 SSE 连接。sidepanel 挂载时即连接，提交时连接已存在，正常使用不会有竞态。`llm_request`/`llm_response` 事件不带 sessionId（LLM trace 回调不感知会话），因为本地 BFF 同时只有一个用户、一次只跑一个任务。

## BFF 侧改造

### 文件变化（agent-kit/examples/browser-extension-bff/）

1. **`src/server.ts`** — 从 Node 原生 http 切换到 `@hono/node-server`，装配 EventBus 和 SSE 端点
2. **新建 `src/event-bus.ts`** — 复用 Flutter BFF 的 createEventBus 实现（seq 编号 + Last-Event-ID 重放）
3. **新建 `src/execute-loop.ts`** — `dispatchResult(result, bus, sessionId)`: pending_tool_calls → 发 tool_call；final → 发 final；error → 发 error
4. **新建 `src/tool-events.ts`** — 从 Flutter BFF 复制 `llmTraceToBus`，发 llm_request/llm_response 事件
5. **路由改造：**
   - `POST /api/execute`：认证 → harness.run() → dispatchResult() → 返回 202
   - `POST /v1/agent/sessions/:id/tool-results/:callId`：认证 → harness.resume() → dispatchResult() → 返回 202
   - `GET /api/events?token=...`：streamSSE，同 Flutter BFF 模式
   - `POST /v1/agent/sessions/:id/run`：不变

### 关键实现细节

- 不需要 `instrumentTools`——浏览器工具全是 remote，BFF 不执行工具
- `tool_call` 事件在 harness 返回 pending_tool_calls 时由 dispatchResult 统一发送
- 多 callId 去重：用 `dispatchedCalls: Set<string>` 防止 resume 后重发同一个 callId
- harness.run/resume 抛异常时 catch 住发 `error` 事件，不让 SSE 连接崩掉
- token 走 query param（EventSource 不支持自定义 header，loopback 可接受）

### package.json

- 新增 `@hono/node-server` 依赖

## 插件侧改造

### 文件变化（BOOS_browser_ext/）

1. **新建 `src/agent/sseClient.ts`** — EventSource 封装：
   - `connect(url, token)`：建立 EventSource
   - `onToolCall(handler)`、`onFinal(handler)`、`onError(handler)`、`onLlmStatus(handler)`
   - 暴露 `connectionStatus` ref
   - `disconnect()`
   - 按 sessionId 过滤事件

2. **改造 `src/agent/agentClient.ts`：**
   - 新增 `startExecute(config, sessionId, input, context, promptName?)`：POST `/api/execute`
   - `submitToolResult()`：改为返回 202 即成功
   - 保留 `runAgent()`（计划阶段）
   - 删除 `runAgentSession()` 和轮询循环

3. **改造 `src/composables/useFreeFormController.ts`：**
   - 初始化时创建 sseClient 并连接
   - `submitInstruction()` 改为调 `startExecute()`
   - SSE 事件处理器：
     - `tool_call` → 审批 → executeTool → submitToolResult，更新 currentSteps
     - `final` → appendTurn，succeeded，生成标题
     - `error` → 设置 runError，failed
     - `llm_request`/`llm_response` → 更新状态文案
   - `requestPlan()` 不变
   - 审批逻辑不变

4. **不变：** toolExecutor.ts、background.ts、approvalGate.ts、所有 Vue 组件、services、stores

### 生命周期

- sidepanel 挂载时 connect，卸载时 disconnect
- 提交指令前检查 SSE 已连接，未连接则先连接再提交
- 切换会话不需重连，事件按 sessionId 过滤（llm_* 事件为全局，当前活跃任务消费）
- SSE 断线 → EventSource 自动重连 + Last-Event-ID 重放
- 任务停止：abort 进行中的工具执行，SSE 连接不断开，后续到达的事件忽略

## 测试策略

- BFF 侧：execute-loop 的 dispatchResult 纯函数可单测（pending/final/error 三种路径）
- 插件侧：sseClient 的事件分发和 sessionId 过滤可单测
- 现有 toolExecutor、agentClient、useFreeFormController 的测试需要更新以匹配新接口
- 端到端：手动验证提交指令 → 看到思考状态 → 工具执行 → final 完整链路
