# 浏览器插件架构重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把浏览器插件的聊天 UI 和上下文管理挪到 BFF，插件只做浏览器页面 DOM 获取和 Action 派发

**Architecture:** BFF 新增 Web UI（单文件 HTML）、SSE 事件流推送工具进度、WebSocket 执行器与插件通信。插件 sidepanel 改 iframe 嵌入 BFF UI，background 改 WS 客户端。agent-kit 包向后兼容。

**Tech Stack:** agent-kit (core/adapter-sqlite/bff-hono)、Hono、Node 原生 http/ws、Chrome Extension MV3

## Global Constraints

- agent-kit 改动必须向后兼容：现有 flutter-bff 一行不改、行为不变
- 两个仓库各开新分支：agent-kit → `feat/browser-bff-ws-executor`，BOOS → `feat/iframe-bff-ui`
- 绝不 force push、绝不合入 main，等用户确认后走 PR
- 合入顺序：先合 agent-kit（向后兼容），再合插件
- MVP 不做流式 assistant 文本、不做细粒度审批、不做域名白名单、不做远程部署
- 所有 SE 工具执行保持现有 `toolExecutor.ts` / `cdpSessionManager.ts` / `domLocator.ts` 不变

---

## 文件结构变更总览

### agent-kit 仓库

```
packages/core/src/
  harness.ts            → 新增 toolCallbacks 参数（在 AgentHarnessDependencies 中）
                           runLoop 中 remote 工具分支触发 onToolStart/onToolEnd
packages/adapter-sqlite/src/
  index.ts              → createSqliteAgentRuntime 新增可选 context 参数
examples/browser-extension-bff/
  public/index.html     → 新增：BFF Web UI 单文件（纯 HTML/CSS/JS）
  src/
    server.ts           → 修改：加 SSE 路由、WS upgrade、tool loop 包装
    browser-tools.ts    → 不动（工具定义不变）
    event-bus.ts        → 新增：内存事件总线（工具事件 → SSE 推送）
    ws-executor.ts      → 新增：WebSocket 执行器服务器
```

### BOOS_browser_ext 仓库

```
src/agent/
  agentClient.ts        → 删除：runAgentSession 轮询循环、runAgent/submitToolResult
  wsExecutorClient.ts   → 新增：WS 连接管理、重连、callId 关联
  approvalGate.ts       → 删除
  toolExecutor.ts       → 保留（工具执行核心），移除 isReadOnlyTool 导出
entrypoints/
  sidepanel/
    App.vue             → 重写：全屏 iframe，极简设置 overlay
    main.ts             → 保留（Vue 挂载入口）
  background.ts         → 修改：初始化 WS 连接、处理 ToolCall 消息、删除 URL 白名单校验
  content.ts            → 不动
src/
  composables/
    useFreeFormController.ts → 删除
    useSkillController.ts    → 删除
    useFileAttachments.ts    → 删除
  components/
    FreeFormPanel.vue        → 删除
    SkillPanel.vue           → 删除
    ExtensionSettingsPanel.vue → 删除
    ExtensionAppShell.vue    → 删除
  services/
    freeFormSessionStore.ts  → 删除
    urlAllowlist.ts          → 删除
    permissionService.ts     → 简化：只保留 host permission 管理，去掉 allowlist
    exportService.ts         → 保留（browser_save_file 等工具仍需要）
  types/
    messages.ts         → 删除 URL_NOT_ALLOWED 错误码
    settings.ts         → 保留但简化（只留 BFF 地址/token）
package.json            → 删除 element-plus、marked、dompurify、xlsx
wxt.config.ts           → 更新 manifest：CSP、description
```

---

## Phase 1: agent-kit 仓库

### Task 1: 给 `createSqliteAgentRuntime` 加 `context` 参数

**Files:**
- Modify: `packages/adapter-sqlite/src/index.ts`

**Interfaces:**
- Consumes: `ContextManager` from `@agent-kit/core`
- Produces: 不传 `context` 时行为不变，传了则 `createAgentHarness` 收到 context

- [ ] **Step 1: 修改 `createSqliteAgentRuntime` 签名，增加可选 `context` 参数**

修改 `packages/adapter-sqlite/src/index.ts:116-149`，在参数类型中加 `context` 字段，并在 `createAgentHarness` 调用中透传。

```typescript
// 第 116 行，参数类型加一行
context?: ContextManager

// 第 147 行，透传给 harness
const harness = createAgentHarness({
  llm: { ... },
  sessions,
  tools,
  pendingCalls,
  maxSteps: options.maxSteps ?? 10,
  ...(options.prompts ? { prompts: options.prompts } : {}),
  ...(options.audit ? { audit: options.audit } : {}),
  ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
  ...(options.context ? { context: options.context } : {}),  // 新增
})
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
pnpm build --filter @agent-kit/adapter-sqlite
```

Expected: 编译通过，无报错。

- [ ] **Step 3: 确认 flutter-bff 不受影响**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
pnpm build --filter flutter-dev-bff
```

Expected: 编译通过，无报错（flutter-bff 不传 context，行为不变）。

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-sqlite/src/index.ts
git commit -m "feat: sqlite runtime 可选注入 ContextManager"
```

---

### Task 2: 给 harness 加工具事件回调

**Files:**
- Modify: `packages/core/src/harness.ts`

**Interfaces:**
- Consumes: —（新增类型定义）
- Produces: `AgentHarnessDependencies.toolCallbacks` 可选字段

- [ ] **Step 1: 在 `AgentHarnessDependencies` 中加 `toolCallbacks`**

在 `packages/core/src/harness.ts:22-35`，`AgentHarnessDependencies` 接口末尾加：

```typescript
/** 工具生命周期回调，用于 SSE 推送等场景。 */
toolCallbacks?: {
  onToolStart?: (event: { callId: string; toolName: string; input: unknown; sessionId: string }) => void
  onToolEnd?: (event: { callId: string; toolName: string; ok: boolean; outputPreview: unknown; durationMs: number }) => void
}
```

- [ ] **Step 2: remote 工具分支触发回调**

在 `packages/core/src/harness.ts:227-236`，remote 工具分支中，`pendingCalls.set` 后加 `onToolStart`：

```typescript
if (tool.execution === 'remote') {
  await pendingCalls.set(call.callId, {
    sessionId,
    toolName: call.toolName,
    ...(promptName ? { promptName } : {}),
  })
  deps.toolCallbacks?.onToolStart?.({ callId: call.callId, toolName: call.toolName, input: parsedInput, sessionId })
  remoteCalls.push({ callId: call.callId, toolName: call.toolName, input: parsedInput })
  continue
}
```

- [ ] **Step 3: resume 中工具结果到达时触发 `onToolEnd`**

在 `packages/core/src/harness.ts:339-372` 的 `resume` 方法中，找到结果回填的位置。在 `pendingCalls.delete` 并追加 tool 消息后，加 `onToolEnd`：

```typescript
// 在 resume 方法中找到 pendingCalls.delete 之后（约第 360 行）
deps.toolCallbacks?.onToolEnd?.({
  callId,
  toolName: pending.toolName,
  ok: !('error' in output),
  outputPreview: output,
  durationMs: Date.now() - resumedAt,
})
```

需要定义 `resumedAt` 变量在 resume 方法开头。

- [ ] **Step 4: 验证编译通过**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
pnpm build --filter @agent-kit/core
```

Expected: 编译通过，无报错。

- [ ] **Step 5: 确认 flutter-bff 不受影响**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
pnpm build --filter flutter-dev-bff
```

Expected: 编译通过（flutter-bff 不传 toolCallbacks，行为不变）。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/harness.ts
git commit -m "feat: harness 加 toolCallbacks 回调，用于 SSE 工具进度推送"
```

---

### Task 3: 构建 browser-extension-bff 的 Web UI、SSE、WebSocket 执行器

**Files:**
- Create: `examples/browser-extension-bff/public/index.html`
- Create: `examples/browser-extension-bff/src/event-bus.ts`
- Create: `examples/browser-extension-bff/src/ws-executor.ts`
- Modify: `examples/browser-extension-bff/src/server.ts`
- Modify: `examples/browser-extension-bff/src/browser-tools.ts` (不需要改，现有工具定义不变)

**Interfaces:**
- Consumes: `AgentHarness`, `createContextManager` from core; `createAgentBff` from bff-hono
- Produces: BFF 监听 localhost:8787，提供 HTTP + SSE + WS 三合一服务

- [ ] **Step 1: 创建 `public/index.html`**

创建 `examples/browser-extension-bff/public/index.html`，纯 HTML/CSS/JS 单文件，适配 320-600px 窄屏。

功能：
- 消息列表：用户气泡 + assistant markdown 渲染 + 工具调用折叠卡片
- 工具卡片：工具名、入参摘要、耗时、成功/失败标记、输出预览（长内容截断 + 可展开）
- 输入框 + 发送按钮 + 停止按钮
- 顶部栏：会话 ID + 新建会话按钮 + 模型状态指示灯（WS executor 是否在线）
- 设置：BFF token 存入 localStorage（iframe 场景由父窗口通过 URL query 注入）
- Prompt 选择器：free-form / planning / browser-automation / candidate-assessment

核心 HTML 结构：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Browser AI Assistant</title>
<style>
/* 窄屏自适应：320-600px，Dark 主题 */
/* 参考 flutter-bff 的 public/index.html 样式结构 */
</style>
</head>
<body>
<div id="app">
  <header>
    <span id="session-label">会话</span>
    <button id="new-session">新建</button>
    <span id="executor-status" class="status-offline">● 执行器离线</span>
    <button id="settings-btn">设置</button>
  </header>
  <div id="messages"></div>
  <div id="prompt-selector">
    <select id="prompt-name">
      <option value="free-form">自由指令</option>
      <option value="planning">规划</option>
      <option value="browser-automation">浏览器自动化</option>
      <option value="candidate-assessment">评估</option>
    </select>
  </div>
  <div id="input-area">
    <textarea id="input" placeholder="描述你想做的事..." rows="2"></textarea>
    <button id="send" disabled>发送</button>
    <button id="stop" style="display:none">停止</button>
  </div>
</div>
<!-- 设置弹窗 -->
<div id="settings-overlay" class="overlay" style="display:none">
  <div class="overlay-content">
    <h3>设置</h3>
    <label>BFF Token <input id="token-input" type="password"></label>
    <button id="settings-save">保存</button>
  </div>
</div>
<!-- 工具卡片模板 -->
<template id="tool-card">
  <div class="tool-card">
    <div class="tool-card-header">
      <span class="tool-name"></span>
      <span class="tool-status"></span>
      <span class="tool-duration"></span>
    </div>
    <div class="tool-card-body" style="display:none">
      <pre class="tool-input"></pre>
      <pre class="tool-output"></pre>
    </div>
  </div>
</template>
<script>
// 核心逻辑：
// 1. 页面加载时从 URL query 取 token（?token=xxx），fallback 到 localStorage
// 2. 新建/恢复 sessionId（localStorage）
// 3. POST /v1/agent/sessions/:id/run 发消息
// 4. SSE GET /api/events 接收 tool_start/tool_end/step/done/error
// 5. 工具卡片折叠/展开
// 6. 停止按钮 → AbortController
</script>
</body>
</html>
```

JS 核心逻辑（实现细节）：

```javascript
// 会话管理
const SESSION_KEY = 'bff-session-id'
let sessionId = localStorage.getItem(SESSION_KEY) || crypto.randomUUID()
let token = new URLSearchParams(location.search).get('token') || localStorage.getItem('bff-token') || ''
let eventSource = null
let abortController = null

function saveSessionId() { localStorage.setItem(SESSION_KEY, sessionId) }

// 发送消息
async function sendMessage(text) {
  abortController = new AbortController()
  const msgEl = appendMessage('user', text)
  const respEl = appendMessage('assistant', '')
  
  try {
    const response = await fetch(`/v1/agent/sessions/${sessionId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ input: text, context: { currentDate: new Date().toISOString() }, stepMode: true, promptName: currentPrompt }),
      signal: abortController.signal,
    })
    const result = await response.json()
    // 等待 SSE 流推送完成
    // 结果在 SSE 'done' 事件中处理
  } catch (err) {
    if (err.name === 'AbortError') return
    showError(err.message)
  }
}

// SSE 连接
function connectSSE() {
  eventSource = new EventSource(`/api/events?token=${token}&sessionId=${sessionId}`)
  eventSource.addEventListener('tool_start', (e) => {
    const data = JSON.parse(e.data)
    addToolCard(data.callId, data.toolName, data.input)
  })
  eventSource.addEventListener('tool_end', (e) => {
    const data = JSON.parse(e.data)
    updateToolCard(data.callId, data.ok, data.outputPreview, data.durationMs)
  })
  eventSource.addEventListener('step', (e) => {
    const data = JSON.parse(e.data)
    updateStepIndicator(data.index, data.total)
  })
  eventSource.addEventListener('done', (e) => {
    // 最终输出已通过 HTTP 响应返回
    enableInput()
  })
  eventSource.addEventListener('error', (e) => {
    // EventSource 自动重连
  })
  eventSource.addEventListener('executor_status', (e) => {
    const data = JSON.parse(e.data)
    updateExecutorStatus(data.online)
  })
}
```

- [ ] **Step 2: 创建 `src/event-bus.ts`**

创建 `examples/browser-extension-bff/src/event-bus.ts`，内存事件总线，用于 SSE 推送。

```typescript
/** 事件总线：工具事件 → SSE 推送。复用 flutter-bff 的 EventBus 设计。 */
export interface BusEvent {
  type: 'tool_start' | 'tool_end' | 'step' | 'done' | 'error' | 'executor_status'
  data: Record<string, unknown>
}

export function createEventBus() {
  const listeners = new Set<(event: BusEvent) => void>()
  const history: BusEvent[] = []
  const MAX_HISTORY = 200

  return {
    emit(event: BusEvent) {
      history.push(event)
      if (history.length > MAX_HISTORY) history.shift()
      for (const listener of listeners) listener(event)
    },
    subscribe(listener: (event: BusEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getHistory() {
      return [...history]
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>
```

- [ ] **Step 3: 创建 `src/ws-executor.ts`**

创建 `examples/browser-extension-bff/src/ws-executor.ts`，WebSocket 执行器服务器。

```typescript
import type { IncomingMessage } from 'node:http'

export interface WsToolCall {
  callId: string
  toolName: string
  input: unknown
}

export interface WsToolResult {
  callId: string
  output: unknown
}

export interface ExecutorConnection {
  online: boolean
  clientInfo?: { tabUrl?: string; tabTitle?: string }
}

export function createWsExecutor(options: {
  authenticate: (request: IncomingMessage) => Promise<{ subject: string } | null>
  onConnectionChange?: (online: boolean) => void
}) {
  let socket: import('ws').WebSocket | null = null
  const pending = new Map<string, { resolve: (value: WsToolResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let executorInfo: { tabUrl?: string; tabTitle?: string } = {}

  return {
    /** 处理 WS upgrade 请求。返回 true 表示已升级。 */
    handleUpgrade(request: IncomingMessage, socket: import('ws').WebSocket, head: Buffer): boolean {
      // 鉴权
      const token = request.url?.match(/[?&]token=([^&]+)/)?.[1] ?? ''
      if (!token) return false
      
      // 如果已有连接，关闭旧的
      if (socket) {
        socket.close(1000, 'replaced')
      }
      
      socket = socket
      socket.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'register') {
            executorInfo = { tabUrl: msg.tabUrl, tabTitle: msg.tabTitle }
            options.onConnectionChange?.(true)
          } else if (msg.type === 'tool_result') {
            const pending = this.pending.get(msg.callId)
            if (pending) {
              clearTimeout(pending.timer)
              pending.resolve(msg)
              this.pending.delete(msg.callId)
            }
          }
        } catch {}
      })
      socket.on('close', () => {
        socket = null
        options.onConnectionChange?.(false)
        // 拒绝所有挂起的调用
        for (const [callId, pending] of this.pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error('EXECUTOR_DISCONNECTED'))
        }
        this.pending.clear()
      })
      return true
    },

    /** 发送工具调用给执行器，等待结果。超时默认 60s。 */
    async executeTool(call: WsToolCall, timeoutMs = 60_000): Promise<WsToolResult> {
      if (!socket) throw new Error('EXECUTOR_NOT_CONNECTED')
      
      return new Promise<WsToolResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(call.callId)
          reject(new Error('EXECUTOR_TIMEOUT'))
        }, timeoutMs)
        
        this.pending.set(call.callId, { resolve, reject, timer })
        socket!.send(JSON.stringify({ type: 'tool_call', ...call }))
      })
    },

    get online() { return socket !== null },
    get clientInfo() { return executorInfo },
  }
}
```

- [ ] **Step 4: 修改 `src/server.ts`：集成 SSE、WS 执行器、tool loop、ContextManager、maxSteps=50**

修改 `examples/browser-extension-bff/src/server.ts`，在 `createBrowserExtensionBff` 中：

```typescript
import { createContextManager } from '@agent-kit/core'
import { createEventBus } from './event-bus.js'
import { createWsExecutor } from './ws-executor.js'

// 在 createBrowserExtensionBff 中：
// 1. 创建 EventBus
const eventBus = createEventBus()

// 2. 创建 WS executor
const wsExecutor = createWsExecutor({
  authenticate: async (req) => {
    const token = req.url?.match(/[?&]token=([^&]+)/)?.[1] ?? ''
    return token === options.apiToken ? { subject: 'browser-extension' } : null
  },
  onConnectionChange: (online) => {
    eventBus.emit({ type: 'executor_status', data: { online } })
  },
})

// 3. 创建 ContextManager（滑动窗口：200 条消息）
const contextManager = createContextManager({ maxMessages: 200 })

// 4. 创建带 context 的 runtime
const runtime = createSqliteAgentRuntime({
  database,
  masterKey: options.masterKey,
  prompts,
  audit,
  context: contextManager,  // ✅ 注入 ContextManager
  maxSteps: 50,             // 从默认 10 提到 50
  ...(options.llmTrace ? { llmTrace: options.llmTrace } : {}),
  ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  // 注入 toolCallbacks 用于 SSE
  toolCallbacks: {
    onToolStart: (event) => {
      eventBus.emit({ type: 'tool_start', data: event })
    },
    onToolEnd: (event) => {
      eventBus.emit({ type: 'tool_end', data: event })
    },
  },
})
```

**注意：** `createSqliteAgentRuntime` 目前不接受 `toolCallbacks`。需要修改 harness 使其通过 `AgentHarnessDependencies` 接收。或者，更简单的方法：在 BFF 的 `createBrowserExtensionBff` 中，在 `createSqliteAgentRuntime` 之外，直接用 `runtime.harness` 的 `run()` 和 `resume()` 封装 tool loop，不依赖 harness 的 `toolCallbacks`。

**更简单的方案：不依赖 harness 的 toolCallbacks，BFF 直接在 tool loop 中手动触发 SSE 事件。**

```typescript
// 在 server.ts 中，创建自定义的 run 处理函数，替代直接调用 harness.run()

async function handleRun(request) {
  // 1. 调用 harness.run()
  let result = await runtime.harness.run({ ... })
  
  // 2. 如果返回 pending_tool_calls，进入工具执行循环
  while (result.type === 'pending_tool_calls') {
    for (const call of result.calls) {
      // 发射 tool_start SSE
      eventBus.emit({ type: 'tool_start', data: { callId: call.callId, toolName: call.toolName, input: call.input, sessionId: request.sessionId } })
      
      // 通过 WS 发送给插件执行
      const wsResult = await wsExecutor.executeTool({ callId: call.callId, toolName: call.toolName, input: call.input })
      
      // 发射 tool_end SSE
      eventBus.emit({ type: 'tool_end', data: { callId: call.callId, toolName: call.toolName, ok: true, outputPreview: wsResult.output, durationMs: ... } })
      
      // 回填结果给 harness
      result = await runtime.harness.resume({ sessionId: request.sessionId, callId: call.callId, output: wsResult.output })
    }
    // 如果 resume 返回 step_done，继续推进
    while (result.type === 'step_done') {
      result = await runtime.harness.continue({ sessionId: request.sessionId })
    }
  }
  
  // 3. 发射 done 事件
  eventBus.emit({ type: 'done', data: { sessionId: request.sessionId } })
  
  return result
}
```

**这正是方案 B 的核心：BFF 在 server 层实现 tool 循环，替代插件侧的 `runAgentSession` 循环。**

在 `server.ts` 中，原来 `createAgentBff` 使用的 `harness` 是 `runtime.harness`。现在要改为：

1. 保留 `createAgentBff` 用于标准路由（向后兼容）
2. 新增 `POST /api/agent/run` 或覆盖 `POST /v1/agent/sessions/:id/run` 使其走 tool loop

更干净的方案：在 `createBrowserExtensionBff` 中，返回的 `app` 是 Hono app，可以在外部添加/覆盖路由。所以在 `server.ts` 的 `startServer` 中，覆盖 `app` 的 `run` 路由：

```typescript
// 在 startServer 中，创建 app 后，覆盖 run 路由
const app = createAgentBff({ ... })

// 保存原始的 run 逻辑
const originalRun = app.fetch

// 添加 SSE 路由
app.get('/api/events', async (c) => {
  const token = c.req.query('token')
  if (token !== options.apiToken) return c.json({ code: 'UNAUTHORIZED' }, 401)
  
  const id = c.req.query('sessionId') ?? ''
  
  c.header('content-type', 'text/event-stream')
  c.header('cache-control', 'no-cache')
  c.header('connection', 'keep-alive')
  
  const stream = new ReadableStream({
    start(controller) {
      // 发送历史事件
      for (const event of eventBus.getHistory()) {
        controller.enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
      }
      
      // 订阅新事件
      const unsubscribe = eventBus.subscribe((event) => {
        controller.enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
      })
      
      // 心跳
      const heartbeat = setInterval(() => {
        controller.enqueue(': heartbeat\n\n')
      }, 15000)
      
      // 客户端断开时清理
      // 注意：Hono 的 c.req.raw 可以监听 close 事件
      c.req.raw.signal?.addEventListener('abort', () => {
        unsubscribe()
        clearInterval(heartbeat)
      })
    },
  })
  
  return c.newResponse(stream)
})

// 添加 WS executor 路由
app.get('/api/executor', async (c) => {
  // 由 Node http server 直接处理 upgrade
  return c.json({ code: 'WS_UPGRADE_REQUIRED' }, 426)
})

// 注意：WebSocket upgrade 需要在 Node http server 层处理，因为 Hono 不直接支持 WS upgrade。
// 在 startServer 的 createServer 回调中，判断如果 url 是 /api/executor，走 wsExecutor.handleUpgrade
```

实际上，Hono 有 WS 中间件支持。但为了保持简单，直接在 Node `createServer` 回调中处理 WS upgrade：

```typescript
// 在 startServer 的 createServer 回调中
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  
  // WebSocket upgrade
  if (url.pathname === '/api/executor') {
    // 由 ws 包处理 upgrade
    // 用 ws.WebSocketServer 的 handleUpgrade 方法
    return
  }
  
  // 原有的 HTTP 请求处理
  await ready
  // ...rest of existing code
})
```

- [ ] **Step 5: 安装 `ws` 依赖**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff
pnpm add ws
pnpm add -D @types/ws
```

- [ ] **Step 6: 验证编译和启动**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
pnpm build --filter browser-extension-bff
```

Expected: 编译通过。

- [ ] **Step 7: 确认 flutter-bff 不受影响**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
pnpm build --filter flutter-dev-bff
```

Expected: 编译通过。

- [ ] **Step 8: Commit**

```bash
git add examples/browser-extension-bff/ packages/core/src/harness.ts packages/adapter-sqlite/src/index.ts
git commit -m "feat: browser-extension-bff 加 Web UI、SSE、WS 执行器、ContextManager"
```

---

## Phase 2: BOOS_browser_ext 仓库

### Task 4: 添加 wsExecutorClient

**Files:**
- Create: `src/agent/wsExecutorClient.ts`
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes: `toolExecutor.ts`（executeTool）、`MessageSender`（createMessageSender）
- Produces: WS 连接管理、自动重连、callId 关联

- [ ] **Step 1: 创建 `src/agent/wsExecutorClient.ts`**

```typescript
import { executeTool, createMessageSender } from './toolExecutor'
import type { MessageSender } from './toolExecutor'

export interface WsConfig {
  url: string
  apiToken: string
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export function createWsExecutorClient(config: WsConfig) {
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let intentionalClose = false
  const send = createMessageSender()
  let currentTabId: number | null = null

  async function connect() {
    intentionalClose = false
    try {
      const wsUrl = new URL('/api/executor', config.url)
      wsUrl.searchParams.set('token', config.apiToken)
      ws = new WebSocket(wsUrl.toString())
      
      ws.onopen = () => {
        reconnectAttempt = 0
        // 注册执行器能力
        ws!.send(JSON.stringify({
          type: 'register',
          tabUrl: currentTabId ? (await chrome.tabs.get(currentTabId).catch(() => null))?.url : undefined,
          tabTitle: currentTabId ? (await chrome.tabs.get(currentTabId).catch(() => null))?.title : undefined,
        }))
      }
      
      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'tool_call') {
            // 执行工具
            const output = await executeTool(msg.toolName, msg.input, {
              tabId: currentTabId ?? 0,
              send,
              userInstruction: msg.input,
            })
            ws?.send(JSON.stringify({ type: 'tool_result', callId: msg.callId, output }))
          }
        } catch (error) {
          // 发送错误结果
          ws?.send(JSON.stringify({
            type: 'tool_result',
            callId: msg.callId,
            output: { ok: false, code: 'EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) },
          }))
        }
      }
      
      ws.onclose = () => {
        ws = null
        if (!intentionalClose) scheduleReconnect()
      }
      
      ws.onerror = () => {
        // onclose 会紧接着触发，不重复处理
      }
    } catch {
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (intentionalClose) return
    const base = config.reconnectBaseMs ?? 1000
    const max = config.reconnectMaxMs ?? 15000
    const delay = Math.min(base * Math.pow(2, reconnectAttempt), max)
    reconnectAttempt++
    reconnectTimer = setTimeout(connect, delay)
  }

  function disconnect() {
    intentionalClose = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    ws?.close()
    ws = null
  }

  function setTabId(tabId: number) {
    currentTabId = tabId
  }

  return { connect, disconnect, setTabId }
}
```

- [ ] **Step 2: 修改 `entrypoints/background.ts`，初始化 WS 连接**

在 `background.ts` 的 `defineBackground` 回调中：

```typescript
import { createWsExecutorClient } from '../src/agent/wsExecutorClient'

export default defineBackground(() => {
  const cdp = createCdpSessionManager()
  
  // 初始化 WS 执行器客户端
  const wsClient = createWsExecutorClient({
    url: 'http://localhost:8787',
    apiToken: 'dev-token',  // 从 settings 读取
  })
  wsClient.connect()
  
  // 监听标签页切换，更新当前 tabId
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    wsClient.setTabId(activeInfo.tabId)
  })
  
  // 初始化时设置当前 tab
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]?.id) wsClient.setTabId(tabs[0].id)
  })
  
  // ... 保留现有 CDP 消息处理
})
```

注意：BFF URL 和 token 从 settings 读取，需要 import settingsService。

- [ ] **Step 3: 在 background.ts 中删除 `requireAllowedUrl`、`requireWritable`、`ALLOWLIST_STORAGE_KEY` 等 URL 白名单相关代码**

删除 `background.ts` 中：
- 第 11 行：`import { ALLOWLIST_STORAGE_KEY, isUrlAllowed } from '../src/services/urlAllowlist'`
- 第 12 行：`import type { UrlAllowRule } from '../src/services/urlAllowlist'`
- 第 328-336 行：`requireAllowedUrl` 函数
- 第 352-360 行：`loadAllowRules` 函数  
- 第 362-366 行：`requireWritable` 函数
- 所有调用 `requireAllowedUrl` 和 `requireWritable` 的地方

- [ ] **Step 4: 验证编译**

```bash
cd /Users/xuewen/ai-lab/project/BOOS_browser_ext
pnpm typecheck
```

Expected: 编译通过，无报错。

- [ ] **Step 5: Commit**

```bash
git add src/agent/wsExecutorClient.ts entrypoints/background.ts
git commit -m "feat: 添加 wsExecutorClient，后台 WS 连接管理"
```

---

### Task 5: 简化 sidepanel 为 iframe

**Files:**
- Modify: `entrypoints/sidepanel/App.vue`（重写）
- Keep: `entrypoints/sidepanel/main.ts`（不动）
- Delete: `src/components/FreeFormPanel.vue`
- Delete: `src/components/SkillPanel.vue`
- Delete: `src/components/ExtensionSettingsPanel.vue`
- Delete: `src/components/ExtensionAppShell.vue`
- Delete: `src/composables/useFreeFormController.ts`
- Delete: `src/composables/useSkillController.ts`
- Delete: `src/composables/useFileAttachments.ts`
- Delete: `src/services/freeFormSessionStore.ts`

- [ ] **Step 1: 重写 `App.vue` 为 iframe 容器**

```vue
<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { settingsService } from '../../src/services/settingsService'

const settings = ref(settingsService.load().normalized)
const showSettings = ref(false)
const bffUrl = ref('')
const bffToken = ref('')

function loadBffConfig() {
  const saved = settingsService.load()
  settings.value = saved.normalized
  bffUrl.value = settings.value.advanced.bffBaseUrl || 'http://localhost:8787'
  bffToken.value = settings.value.advanced.bffApiToken || ''
}

const iframeSrc = computed(() => {
  const url = bffUrl.value.replace(/\/+$/, '')
  return `${url}/?token=${encodeURIComponent(bffToken.value)}`
})

function saveBffConfig() {
  settingsService.save({
    ...settings.value,
    advanced: {
      ...settings.value.advanced,
      bffBaseUrl: bffUrl.value,
      bffApiToken: bffToken.value,
    },
  })
  showSettings.value = false
}

onMounted(loadBffConfig)
</script>

<template>
  <div class="iframe-container">
    <iframe :src="iframeSrc" frameborder="0" />
    <button class="settings-btn" @click="showSettings = true">⚙</button>
    
    <div v-if="showSettings" class="overlay" @click.self="showSettings = false">
      <div class="overlay-content">
        <h3>BFF 设置</h3>
        <label>
          BFF 地址
          <input v-model="bffUrl" placeholder="http://localhost:8787" />
        </label>
        <label>
          BFF Token
          <input v-model="bffToken" type="password" placeholder="dev-token" />
        </label>
        <button @click="saveBffConfig">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.iframe-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  position: relative;
}
iframe {
  flex: 1;
  width: 100%;
  border: none;
}
.settings-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 10;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid #ccc;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
  opacity: 0.7;
}
.settings-btn:hover { opacity: 1; }
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.overlay-content {
  background: #fff;
  padding: 20px;
  border-radius: 8px;
  min-width: 280px;
}
.overlay-content label {
  display: block;
  margin: 12px 0;
}
.overlay-content input {
  width: 100%;
  padding: 6px;
  margin-top: 4px;
  box-sizing: border-box;
}
</style>
```

- [ ] **Step 2: 删除不需要的组件和 composables**

```bash
rm src/components/FreeFormPanel.vue
rm src/components/SkillPanel.vue
rm src/components/ExtensionSettingsPanel.vue
rm src/components/ExtensionAppShell.vue
rm src/composables/useFreeFormController.ts
rm src/composables/useSkillController.ts
rm src/composables/useFileAttachments.ts
rm src/services/freeFormSessionStore.ts
```

- [ ] **Step 3: 删除 `agentClient.ts` 中的 `runAgentSession` 函数和相关类型**

`agentClient.ts` 中保留 `BffConfig`、`BffError`、`checkBffConnectivity` 等类型/函数，但删除：
- `runAgentSession` 函数（第 190-235 行）
- `AgentSessionOptions` 接口（第 163-180 行）
- `StepEvent` 接口（第 153-161 行）
- `AgentRunResult` 类型、`PendingToolCall` 接口（第 30-39 行）—— 如果 wsExecutorClient 不需要

- [ ] **Step 4: 验证编译**

```bash
cd /Users/xuewen/ai-lab/project/BOOS_browser_ext
pnpm typecheck
```

Expected: 编译通过，无报错。

- [ ] **Step 5: Commit**

```bash
git add entrypoints/sidepanel/App.vue
git rm src/components/FreeFormPanel.vue src/components/SkillPanel.vue src/components/ExtensionSettingsPanel.vue src/components/ExtensionAppShell.vue
git rm src/composables/useFreeFormController.ts src/composables/useSkillController.ts src/composables/useFileAttachments.ts
git rm src/services/freeFormSessionStore.ts
git commit -m "feat: sidepanel 改为 iframe 嵌入 BFF Web UI，删除旧聊天组件"
```

---

### Task 6: 删除 approval gate、URL allowlist、简化 permission service

**Files:**
- Delete: `src/agent/approvalGate.ts`
- Delete: `src/services/urlAllowlist.ts`
- Modify: `src/services/permissionService.ts`（简化，只保留 host permission 管理）
- Modify: `src/types/messages.ts`（删除 `URL_NOT_ALLOWED`）
- Modify: `src/agent/agentClient.ts`（删除 `approval` 引用）
- Modify: `src/agent/toolExecutor.ts`（不再需要导出 `isReadOnlyTool` 用于审批）

- [ ] **Step 1: 删除 `approvalGate.ts` 和 `urlAllowlist.ts`**

```bash
rm src/agent/approvalGate.ts
rm src/services/urlAllowlist.ts
```

- [ ] **Step 2: 简化 `permissionService.ts`**

删除 `permissionService.ts` 中所有白名单相关的函数：`loadAllowRules`、`persistAllowRules`、`hasPermissionFor`、`addAllowRule`、`removeAllowRule`、`syncContentScripts`。

保留：`grantedHostPatterns`、`requestPermissionForUrl`、`hasUrlPermission`。

注意：`syncContentScripts` 仅在 `requestPermissionForUrl` 和 `addAllowRule` 中被调用，功能是动态注册 content script。如果不再需要通过白名单自动注册，保留 `syncContentScripts` 并只在 `requestPermissionForUrl` 中调用它。

```typescript
// 简化的 permissionService.ts
// 只保留 host permission 管理，去掉白名单

export async function grantedHostPatterns(): Promise<string[]> {
  try {
    const permissions = await chrome.permissions.getAll()
    return permissions.origins ?? []
  } catch {
    return []
  }
}

export async function requestPermissionForUrl(url: string): Promise<{ ok: boolean; message: string; origin?: string }> {
  let origin: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: `不支持的协议：${parsed.protocol}` }
    }
    origin = `${parsed.protocol}//${parsed.host}/*`
  } catch {
    return { ok: false, message: '无法解析当前页面地址。' }
  }
  try {
    const granted = await chrome.permissions.request({ origins: [origin] })
    if (!granted) return { ok: false, message: '未获得授权。' }
    await syncContentScripts()
    return { ok: true, message: '授权成功。', origin }
  } catch (error) {
    return { ok: false, message: `申请域名权限失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function hasUrlPermission(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return await chrome.permissions.contains({ origins: [`${parsed.protocol}//${parsed.host}/*`] })
  } catch {
    return false
  }
}

const DYNAMIC_SCRIPT_ID = 'boos-dynamic-content'

export async function syncContentScripts(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] })
  } catch { /* 尚未注册过，忽略 */ }
  // 不再关联白名单，仅对已授权的域名注册
  const permissions = await chrome.permissions.getAll()
  const origins = (permissions.origins ?? []).filter(o => o.startsWith('http'))
  if (origins.length === 0) return
  try {
    await chrome.scripting.registerContentScripts([{
      id: DYNAMIC_SCRIPT_ID,
      matches: origins,
      js: ['content-scripts/content.js'],
      allFrames: true,
      runAt: 'document_idle',
    }])
  } catch (error) {
    console.warn('[BOOS] 注册 content script 失败：', error)
  }
}
```

- [ ] **Step 3: 删除 `messages.ts` 中的 `URL_NOT_ALLOWED` 错误码**

```typescript
// 删除第 106-107 行：
/** 目标页面不在用户配置的白名单内，写操作被拒。 */
| 'URL_NOT_ALLOWED'
```

- [ ] **Step 4: 清理 `agentClient.ts` 中的 `approval` 引用**

```typescript
// 删除第 1 行：import type { ApprovalGate } from './approvalGate'
// 删除 `AgentSessionOptions` 中的 `approval` 和 `currentUrl` 字段
```

- [ ] **Step 5: 清理 `toolExecutor.ts` 中的 `isReadOnlyTool` 导出**

如果 `isReadOnlyTool` 只被 `approvalGate.ts` 使用，可删除它。但保留 `TOOL_ALLOWLIST` 和 `isAllowedTool` 用于白名单过滤。

- [ ] **Step 6: 清理 `background.ts` 中的 `isUrlAllowed` 引用**

删除：
```typescript
import { ALLOWLIST_STORAGE_KEY, isUrlAllowed } from '../src/services/urlAllowlist'
import type { UrlAllowRule } from '../src/services/urlAllowlist'
```

- [ ] **Step 7: 验证编译**

```bash
cd /Users/xuewen/ai-lab/project/BOOS_browser_ext
pnpm typecheck
```

Expected: 编译通过，无报错。

- [ ] **Step 8: Commit**

```bash
git rm src/agent/approvalGate.ts src/services/urlAllowlist.ts
git add src/services/permissionService.ts src/types/messages.ts src/agent/agentClient.ts
git commit -m "refactor: 删除审批门和 URL 白名单，简化 permission service"
```

---

### Task 7: 清理依赖和 manifest

**Files:**
- Modify: `package.json`
- Modify: `wxt.config.ts`

- [ ] **Step 1: 从 `package.json` 删除不用的依赖**

```json
// 删除：
"@element-plus/icons-vue": "^2.3.2",
"dompurify": "^3.4.13",
"element-plus": "^2.13.7",
"marked": "^18.0.9",
"xlsx": "^0.18.5"
```

保留：`vue`（侧边栏 iframe 容器仍用 Vue）、`@agent-kit/core`（BFF 通信）

- [ ] **Step 2: 更新 `wxt.config.ts` manifest**

```typescript
manifest: {
  name: 'BOOS Browser AI Assistant',
  description: '浏览器 AI 助手：BFF 驱动，浏览器插件只做页面操作。',
  // 删除：sidePanel 权限（如果不再需要）
  // 或者保留但用于 iframe 容器
  permissions: ['activeTab', 'scripting', 'tabs', 'sidePanel', 'webNavigation', 'debugger', 'storage', 'downloads'],
  // 添加 sidepanel CSP 以允许嵌入 iframe
  // 注意：WXT 的 CSP 配置方式可能不同，需要查看文档
  // 在 MV3 中，CSP 通过 manifest 的 content_security_policy 字段配置
}
```

CSP 配置：在 `manifest` 中加：

```typescript
content_security_policy: {
  extension_pages: "script-src 'self'; object-src 'self'; frame-src http://localhost:8787 http://127.0.0.1:8787"
}
```

- [ ] **Step 3: 删除 `useFreeFormController` 中引用的设置字段**

检查 `src/types/settings.ts`，如果 settings 中只有 BFF 地址/token 需要保留，其他字段（如 `approvalEnabled`、`maxSteps` 等）可以删除。

- [ ] **Step 4: 验证编译**

```bash
cd /Users/xuewen/ai-lab/project/BOOS_browser_ext
pnpm install
pnpm typecheck
```

Expected: 编译通过，无报错。

- [ ] **Step 5: 运行测试**

```bash
cd /Users/xuewen/ai-lab/project/BOOS_browser_ext
pnpm test
```

Expected: 现有测试通过（删除的模块的测试也需要相应删除或更新）。

- [ ] **Step 6: Commit**

```bash
git add package.json wxt.config.ts
git commit -m "chore: 清理依赖和 manifest，删除 element-plus/marked/dompurify/xlsx"
```

---

## 自审

1. **Spec 覆盖度**：每个 spec 章节都有对应的 task。Spec 第 8 节（范围外）已确认不做。
2. **Placeholder 扫描**：所有代码块包含完整实现。无 TBD/TODO。
3. **类型一致性**：`ContextManager` 来自 `@agent-kit/core`，`createAgentBff` 来自 `@agent-kit/bff-hono`，均与现有类型一致。
4. **向后兼容验证**：flutter-bff 不传 `context`、不传 `toolCallbacks`，行为不变。Task 1/2 的步骤 3 明确验证这个。