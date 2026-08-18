# SSE 控制流翻转 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 agent loop 驱动方从插件侧 HTTP 轮询翻转到 BFF 侧 SSE 推送。

**Architecture:** BFF 通过 SSE 主动推送 `tool_call` 事件给插件，插件执行后 POST 回传结果。BFF 使用 @hono/node-server + EventBus，插件使用 EventSource。计划阶段保持现有 HTTP POST 不变。

**Tech Stack:** Hono, @hono/node-server, hono/streaming (SSE), EventSource (browser native), TypeScript, Vue 3, Vitest

**两个仓库：**
- BFF: `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/`
- 插件: `/Users/xuewen/ai-lab/project/BOOS_browser_ext/`（当前仓库，分支 `feat/sse-control-flow`）

## Global Constraints

- BFF 工具全部 `execution: 'remote'`，BFF 不执行工具
- 计划阶段不变：POST `/v1/agent/sessions/:id/run` with `skipTools=true`
- 审批门 `approvalGate.ts` 不变，逻辑挪到 SSE 事件处理器
- toolExecutor.ts、background.ts、所有 Vue 组件、services、stores 不变
- token 走 SSE query param（EventSource 不支持自定义 header）
- EventBus 缓冲 200 条，支持 Last-Event-ID 断线重放
- 每个任务结束后提交

---

## File Structure

### BFF 侧 (agent-kit/examples/browser-extension-bff/)

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/event-bus.ts` | 新建 | EventBus：seq 编号、缓冲、subscribe + fromSeq 重放 |
| `src/tool-events.ts` | 新建 | llmTraceToBus：LLM trace 转 SSE 事件 |
| `src/execute-loop.ts` | 新建 | dispatchResult：HarnessResult → EventBus 事件 |
| `src/server.ts` | 修改 | 切换 @hono/node-server，装配 bus，添加 /api/execute、/api/tool-results、/api/events |
| `src/server.test.ts` | 修改 | 更新现有测试 + 新增 SSE 测试 |
| `package.json` | 修改 | 添加 @hono/node-server 依赖 |

### 插件侧 (BOOS_browser_ext/)

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/sseClient.ts` | 新建 | EventSource 封装：连接、事件分发、状态 |
| `src/agent/sseClient.test.ts` | 新建 | sseClient 单测 |
| `src/agent/agentClient.ts` | 修改 | 添加 startExecute，改 submitToolResult，删 runAgentSession |
| `src/agent/agentClient.test.ts` | 修改 | 删除 runAgentSession 测试，更新其他测试 |
| `src/composables/useFreeFormController.ts` | 修改 | 使用 SSE 替代轮询循环 |

---

### Task 1: BFF EventBus

**Files:**
- Create: `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/event-bus.ts`
- Test: 同文件 `.test.ts` 或内联在 `event-bus.ts`（纯函数，测试写在 server.test.ts 或独立文件）

**Interfaces:**
- Produces: `createEventBus(options?): EventBus`, `EventBus.emit(event)`, `EventBus.subscribe(listener, fromSeq?): () => void`, `BffEvent` type

- [ ] **Step 1: Write the failing test**

Create `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/event-bus.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'

describe('EventBus', () => {
  it('emits events with incrementing seq and timestamp', () => {
    const bus = createEventBus()
    const received: Array<{ seq: number; type: string }> = []
    bus.subscribe((e) => received.push({ seq: e.seq, type: e.type }))

    bus.emit({ type: 'a' })
    bus.emit({ type: 'b' })

    expect(received[0]!.seq).toBe(1)
    expect(received[1]!.seq).toBe(2)
    expect(received[0]!.type).toBe('a')
    expect(typeof received[0]!.ts).toBe('number')
  })

  it('replays buffered events after fromSeq on subscribe', () => {
    const bus = createEventBus()
    bus.emit({ type: 'first' })
    bus.emit({ type: 'second' })
    bus.emit({ type: 'third' })

    const received: string[] = []
    bus.subscribe((e) => received.push(e.type as string), 1)

    expect(received).toEqual(['second', 'third'])
  })

  it('unsubscribe stops further events', () => {
    const bus = createEventBus()
    const received: string[] = []
    const unsub = bus.subscribe((e) => received.push(e.type as string))
    bus.emit({ type: 'a' })
    unsub()
    bus.emit({ type: 'b' })
    expect(received).toEqual(['a'])
  })

  it('caps buffer to bufferSize', () => {
    const bus = createEventBus({ bufferSize: 2 })
    bus.emit({ type: 'a' })
    bus.emit({ type: 'b' })
    bus.emit({ type: 'c' })

    const received: string[] = []
    bus.subscribe((e) => received.push(e.type as string), 0)
    // Only last 2 events should be in buffer
    expect(received).toEqual(['b', 'c'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run event-bus.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/event-bus.ts`:

```typescript
export interface BffEvent {
  seq: number
  ts: number
  type: string
  [key: string]: unknown
}

export interface EventBus {
  emit(event: { type: string; [key: string]: unknown }): void
  subscribe(listener: (event: BffEvent) => void, fromSeq?: number): () => void
}

export function createEventBus(options: { bufferSize?: number } = {}): EventBus {
  const bufferSize = options.bufferSize ?? 200
  const buffer: BffEvent[] = []
  const listeners = new Set<(event: BffEvent) => void>()
  let seq = 0

  return {
    emit(event) {
      seq += 1
      const full: BffEvent = { ...event, seq, ts: Date.now() }
      buffer.push(full)
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize)
      for (const listener of listeners) listener(full)
    },
    subscribe(listener, fromSeq) {
      if (fromSeq !== undefined) {
        for (const event of buffer) {
          if (event.seq > fromSeq) listener(event)
        }
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run event-bus.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
git add examples/browser-extension-bff/src/event-bus.ts examples/browser-extension-bff/src/event-bus.test.ts
git commit -m "feat(bff): add EventBus for SSE event distribution"
```

---

### Task 2: BFF LLM Trace Events

**Files:**
- Create: `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/tool-events.ts`
- Test: `src/tool-events.test.ts`

**Interfaces:**
- Consumes: `EventBus` from Task 1, `LlmTraceEvent` from `@agent-kit/core`
- Produces: `llmTraceToBus(bus): (event: LlmTraceEvent) => void`

- [ ] **Step 1: Write the failing test**

Create `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/tool-events.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'
import { llmTraceToBus } from './tool-events.js'

function collect(bus: ReturnType<typeof createEventBus>) {
  const events: Array<Record<string, unknown>> = []
  bus.subscribe((e) => events.push({ ...e }))
  return events
}

describe('llmTraceToBus', () => {
  it('request phase emits llm_request with summary only', () => {
    const bus = createEventBus()
    const trace = llmTraceToBus(bus)
    const events = collect(bus)

    trace({
      requestId: 'req-1',
      phase: 'request',
      durationMs: 0,
      body: {
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: '绝密提示词' }, { role: 'user', content: '你好' }],
        tools: [{ name: 't1' }],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('llm_request')
    expect(events[0]!.model).toBe('deepseek-chat')
    expect(events[0]!.messageCount).toBe(2)
    expect(events[0]!.toolCount).toBe(1)
    expect(JSON.stringify(events[0])).not.toContain('绝密提示词')
  })

  it('response phase emits llm_response with summary only', () => {
    const bus = createEventBus()
    const trace = llmTraceToBus(bus)
    const events = collect(bus)

    trace({
      requestId: 'req-2',
      phase: 'response',
      durationMs: 1200,
      responseBody: {
        choices: [{ message: { content: '模型完整回复' }, finish_reason: 'tool_calls' }],
      },
    })

    expect(events[0]!.type).toBe('llm_response')
    expect(events[0]!.durationMs).toBe(1200)
    expect(events[0]!.finishReason).toBe('tool_calls')
    expect(JSON.stringify(events[0])).not.toContain('模型完整回复')
  })

  it('error phase emits llm_error', () => {
    const bus = createEventBus()
    const trace = llmTraceToBus(bus)
    const events = collect(bus)

    trace({
      requestId: 'req-3',
      phase: 'error',
      durationMs: 500,
      error: new Error('超时'),
    })

    expect(events[0]!.type).toBe('llm_error')
    expect(String(events[0]!.error)).toContain('超时')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run tool-events.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/tool-events.ts`:

```typescript
import type { LlmTraceEvent } from '@agent-kit/core'
import type { EventBus } from './event-bus.js'

/**
 * 把 LlmTraceEvent 转成只含摘要的事件推给 bus。
 * 绝不推 body 与 responseBody：前者含 system prompt 全文与会话消息，
 * 后者是模型原文，二者都属敏感内容。
 */
export function llmTraceToBus(bus: EventBus): (event: LlmTraceEvent) => void {
  return (event) => {
    if (event.phase === 'request') {
      const body = (event.body ?? {}) as { model?: unknown; messages?: unknown; tools?: unknown }
      bus.emit({
        type: 'llm_request',
        model: typeof body.model === 'string' ? body.model : 'unknown',
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      })
      return
    }
    if (event.phase === 'response') {
      const choices = (event.responseBody as { choices?: unknown } | undefined)?.choices
      const first = Array.isArray(choices)
        ? (choices[0] as { finish_reason?: unknown; message?: { tool_calls?: unknown } } | undefined)
        : undefined
      bus.emit({
        type: 'llm_response',
        durationMs: event.durationMs,
        finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : 'unknown',
        toolCallCount: Array.isArray(first?.message?.tool_calls) ? first.message!.tool_calls!.length : 0,
      })
      return
    }
    bus.emit({
      type: 'llm_error',
      durationMs: event.durationMs,
      error: event.error instanceof Error ? event.error.message : String(event.error),
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run tool-events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
git add examples/browser-extension-bff/src/tool-events.ts examples/browser-extension-bff/src/tool-events.test.ts
git commit -m "feat(bff): add llmTraceToBus for SSE LLM status events"
```

---

### Task 3: BFF Execute-Loop Dispatcher

**Files:**
- Create: `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/execute-loop.ts`
- Test: `src/execute-loop.test.ts`

**Interfaces:**
- Consumes: `EventBus` from Task 1, `HarnessResult` from `@agent-kit/core`
- Produces: `createExecuteLoop(bus): { dispatchResult(result, sessionId): void }`

- [ ] **Step 1: Write the failing test**

Create `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/execute-loop.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'
import { createExecuteLoop } from './execute-loop.js'

function collect(bus: ReturnType<typeof createEventBus>) {
  const events: Array<Record<string, unknown>> = []
  bus.subscribe((e) => events.push({ ...e }))
  return events
}

describe('dispatchResult', () => {
  it('pending_tool_calls emits a tool_call event per call', () => {
    const bus = createEventBus()
    const loop = createExecuteLoop(bus)
    const events = collect(bus)

    loop.dispatchResult(
      {
        type: 'pending_tool_calls',
        calls: [
          { callId: 'c1', toolName: 'browser_click', input: { ref: 1 } },
          { callId: 'c2', toolName: 'browser_press_key', input: { key: 'Enter' } },
        ],
      },
      'sess-1',
    )

    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_call', callId: 'c1', toolName: 'browser_click', sessionId: 'sess-1' })
    expect(events[1]).toMatchObject({ type: 'tool_call', callId: 'c2', toolName: 'browser_press_key', sessionId: 'sess-1' })
  })

  it('final emits a final event with output and sessionId', () => {
    const bus = createEventBus()
    const loop = createExecuteLoop(bus)
    const events = collect(bus)

    loop.dispatchResult({ type: 'final', output: '任务完成', reasoning: '思考过程' }, 'sess-2')

    expect(events[0]).toMatchObject({ type: 'final', output: '任务完成', reasoning: '思考过程', sessionId: 'sess-2' })
  })

  it('final without reasoning omits the field', () => {
    const bus = createEventBus()
    const loop = createExecuteLoop(bus)
    const events = collect(bus)

    loop.dispatchResult({ type: 'final', output: 'done' }, 's-1')

    expect(events[0]!.reasoning).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run execute-loop.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/execute-loop.ts`:

```typescript
import type { HarnessResult } from '@agent-kit/core'
import type { EventBus } from './event-bus.js'

export interface ExecuteLoop {
  dispatchResult(result: HarnessResult, sessionId: string): void
}

export function createExecuteLoop(bus: EventBus): ExecuteLoop {
  return {
    dispatchResult(result, sessionId) {
      if (result.type === 'pending_tool_calls') {
        for (const call of result.calls) {
          bus.emit({
            type: 'tool_call',
            callId: call.callId,
            toolName: call.toolName,
            input: call.input,
            sessionId,
          })
        }
        return
      }
      if (result.type === 'final') {
        bus.emit({
          type: 'final',
          output: result.output,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          sessionId,
        })
      }
      // step_done is not used in the remote-tool flow; ignore.
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run execute-loop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
git add examples/browser-extension-bff/src/execute-loop.ts examples/browser-extension-bff/src/execute-loop.test.ts
git commit -m "feat(bff): add execute-loop dispatcher for SSE tool_call/final events"
```

---

### Task 4: BFF Server Wiring

**Files:**
- Modify: `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/server.ts`
- Modify: `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/package.json`
- Test: `src/sse.test.ts` (new), existing `src/server.test.ts` (update tool-results test)

**Interfaces:**
- Consumes: EventBus (Task 1), llmTraceToBus (Task 2), createExecuteLoop (Task 3)
- Produces:
  - `POST /api/execute` — body `{ sessionId, input, context, promptName? }`, returns 202
  - `POST /api/tool-results/:callId` — body `{ sessionId, output }`, returns 202
  - `GET /api/events?token=...` — SSE stream
  - `createBrowserExtensionBff()` return value adds `bus` field

- [ ] **Step 1: Add @hono/node-server dependency**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
pnpm --filter browser-extension-bff add @hono/node-server hono
```

Verify `package.json` dependencies include `"@hono/node-server"` and `"hono"`.

- [ ] **Step 2: Write the SSE endpoint test**

Create `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/sse.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serve } from '@hono/node-server'
import { createBrowserExtensionBff } from './server.js'

const masterKey = 'A'.repeat(43)
const llm = { apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

afterEach(() => vi.unstubAllGlobals())

async function start() {
  const bff = createBrowserExtensionBff({
    masterKey,
    apiToken: 'token-1',
    databasePath: ':memory:',
    llm,
  })
  await bff.ready
  const server = serve({ fetch: (req) => bff.app.fetch(req), port: 0 }, (info) => info)
  const port = (server.address() as { port: number }).port
  return { bff, port, close: () => server.close() }
}

async function readUntil(body: ReadableStream<Uint8Array>, marker: string, timeoutMs = 3000): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes(marker)) return text
    }
  } finally {
    await reader.cancel()
  }
  return text
}

describe('SSE /api/events', () => {
  it('rejects missing token with 401', async () => {
    const { port, close } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/events`)
    expect(res.status).toBe(401)
    close()
  })

  it('returns text/event-stream on valid token', async () => {
    const { port, close } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body!.cancel()
    close()
  })

  it('emits tool_call events via bus', async () => {
    const { bff, port, close } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((r) => setTimeout(r, 300))

    bff.bus.emit({ type: 'tool_call', callId: 'c1', toolName: 'browser_click', input: {}, sessionId: 's1' })

    const text = await readUntil(res.body!, 'browser_click')
    expect(text).toContain('event: tool_call')
    expect(text).toContain('browser_click')
    close()
  })
})

describe('POST /api/execute', () => {
  it('starts execution and emits tool_call via SSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'browser_click', arguments: '{}' } }] } }],
        }),
      })),
    )

    const { bff, port, close } = await start()

    // Open SSE connection first
    const sseRes = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((r) => setTimeout(r, 200))

    // Start execution
    const execRes = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ sessionId: 's1', input: '点击', context: {} }),
    })
    expect(execRes.status).toBe(202)

    const text = await readUntil(sseRes.body!, 'tool_call')
    expect(text).toContain('browser_click')

    sseRes.body!.cancel()
    close()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run sse.test.ts`
Expected: FAIL — /api/execute and /api/events not found, bus not exposed

- [ ] **Step 4: Implement server changes**

Rewrite `/Users/xuewen/ai-lab/project/agent-kit/examples/browser-extension-bff/src/server.ts`. The key changes from the existing file:

1. Add imports: `serve` from `@hono/node-server`, `streamSSE` from `hono/streaming`
2. Import `createEventBus`, `llmTraceToBus`, `createExecuteLoop`
3. Create bus instance, llmTrace handler, executeLoop in `createBrowserExtensionBff`
4. Pass llmTrace to `createSqliteAgentRuntime` (wrap to also call bus)
5. Add routes on `app`: `GET /api/events`, `POST /api/execute`, `POST /api/tool-results/:callId`
6. Return `bus` from `createBrowserExtensionBff`
7. Change `startServer` to use `serve()` from @hono/node-server instead of Node native http

Here is the full new `server.ts`:

```typescript
import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function getProgramDir(): string {
  if ((process as { pkg?: unknown }).pkg !== undefined) {
    return dirname(process.execPath)
  }
  if (typeof __filename !== 'undefined') {
    return dirname(__filename)
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url))
    }
  } catch {
    // ignore
  }
  return dirname(process.execPath)
}

import { createSqliteAgentRuntime } from '@agent-kit/adapter-sqlite'
import { createAgentBff } from '@agent-kit/bff-hono'
import { createConsoleAuditLogger, createLlmVerboseLogger, createPromptRegistry } from '@agent-kit/core'
import type { AgentKitError, AuditLogger, LlmSecret, LlmTraceEvent } from '@agent-kit/core'

import {
  browserAutomationPrompt,
  browserToolDefinitions,
  candidateAssessmentPrompt,
  candidateAssessmentProtocol,
  freeFormPrompt,
  planningPrompt,
  planningProtocol,
} from './browser-tools.js'
import { createEventBus } from './event-bus.js'
import type { BffEvent } from './event-bus.js'
import { llmTraceToBus } from './tool-events.js'
import { createExecuteLoop } from './execute-loop.js'

export function createBrowserExtensionBff(options: {
  masterKey: string
  apiToken: string
  databasePath?: string
  llm?: LlmSecret
  audit?: AuditLogger
  llmTrace?: (event: LlmTraceEvent) => void
  llmMaxRetries?: number
}) {
  const database = new DatabaseSync(options.databasePath ?? 'agent-kit.sqlite')
  const audit = options.audit ?? createConsoleAuditLogger({ prefix: '[bff]' })
  const prompts = createPromptRegistry()
  prompts.register({ name: 'free-form', version: '1', prompt: freeFormPrompt })
  prompts.register({ name: 'planning', version: '1', prompt: planningPrompt, protocol: planningProtocol })
  prompts.register({ name: 'browser-automation', version: '1', prompt: browserAutomationPrompt })
  prompts.register({
    name: 'candidate-assessment',
    version: '1',
    prompt: candidateAssessmentPrompt,
    protocol: candidateAssessmentProtocol,
  })

  const bus = createEventBus()
  const executeLoop = createExecuteLoop(bus)
  const traceToBus = llmTraceToBus(bus)

  const runtime = createSqliteAgentRuntime({
    database,
    masterKey: options.masterKey,
    prompts,
    audit,
    llmTrace: (event: LlmTraceEvent) => {
      options.llmTrace?.(event)
      traceToBus(event)
    },
    ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  })
  for (const tool of browserToolDefinitions) runtime.tools.register(tool)

  const app = createAgentBff({
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    harness: runtime.harness,
    audit,
  })

  // ── SSE event stream ──────────────────────────────────
  app.get('/api/events', (c) => {
    if (c.req.query('token') !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const lastEventId = c.req.header('last-event-id')
    const fromSeq = lastEventId !== undefined ? Number(lastEventId) : undefined

    return streamSSE(c, async (stream) => {
      const queue: BffEvent[] = []
      const unsubscribe = bus.subscribe((event) => queue.push(event), fromSeq)
      stream.onAbort(unsubscribe)
      let lastPing = Date.now()
      try {
        while (!stream.aborted) {
          while (queue.length > 0) {
            const event = queue.shift() as BffEvent
            await stream.writeSSE({
              data: JSON.stringify(event),
              event: event.type,
              id: String(event.seq),
            })
          }
          if (Date.now() - lastPing >= 15_000) {
            await stream.write(': ping\n\n')
            lastPing = Date.now()
          }
          await stream.sleep(250)
        }
      } finally {
        unsubscribe()
      }
    })
  })

  // ── Start execution (SSE-driven) ──────────────────────
  app.post('/api/execute', async (c) => {
    const identity = await authenticate(c.req.raw, options.apiToken)
    if (!identity) return c.json({ code: 'UNAUTHORIZED', message: '未通过 BFF 鉴权' }, 401)

    const body = await c.req.json<{ input?: unknown; context?: unknown; sessionId?: unknown; promptName?: unknown }>()
    if (typeof body.input !== 'string' || !body.input.trim()) {
      return c.json({ code: 'REQUEST_INVALID', message: 'input 必须是非空字符串' }, 400)
    }
    if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
      return c.json({ code: 'REQUEST_INVALID', message: 'context 必须是对象' }, 400)
    }
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      return c.json({ code: 'REQUEST_INVALID', message: 'sessionId 必须是非空字符串' }, 400)
    }

    const scopedSessionId = `${identity.subject}:${body.sessionId}`
    // Fire and forget: result is dispatched via SSE.
    runtime.harness
      .run({
        sessionId: scopedSessionId,
        input: body.input,
        context: body.context as Record<string, unknown>,
        ...(typeof body.promptName === 'string' ? { promptName: body.promptName } : {}),
      })
      .then((result) => executeLoop.dispatchResult(result, body.sessionId as string))
      .catch((error: unknown) => {
        const code = error instanceof AgentKitError ? error.code : 'INTERNAL'
        const message = error instanceof Error ? error.message : '服务内部错误'
        bus.emit({ type: 'error', code, message, sessionId: body.sessionId })
      })

    return c.json({ accepted: true }, 202)
  })

  // ── Submit tool result (SSE-driven) ───────────────────
  app.post('/api/tool-results/:callId', async (c) => {
    const identity = await authenticate(c.req.raw, options.apiToken)
    if (!identity) return c.json({ code: 'UNAUTHORIZED', message: '未通过 BFF 鉴权' }, 401)

    const callId = c.req.param('callId')
    const body = await c.req.json<{ output?: unknown; sessionId?: unknown }>()
    if (!Object.prototype.hasOwnProperty.call(body, 'output')) {
      return c.json({ code: 'REQUEST_INVALID', message: '缺少工具输出' }, 400)
    }
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      return c.json({ code: 'REQUEST_INVALID', message: 'sessionId 必须是非空字符串' }, 400)
    }

    const scopedSessionId = `${identity.subject}:${body.sessionId}`
    const rawSessionId = body.sessionId

    runtime.harness
      .resume({
        sessionId: scopedSessionId,
        callId,
        output: body.output,
      })
      .then((result) => executeLoop.dispatchResult(result, rawSessionId))
      .catch((error: unknown) => {
        const code = error instanceof AgentKitError ? error.code : 'INTERNAL'
        const message = error instanceof Error ? error.message : '服务内部错误'
        bus.emit({ type: 'error', code, message, sessionId: rawSessionId })
      })

    return c.json({ accepted: true }, 202)
  })

  const ready = seedSecret(runtime, options.llm)
  return { app, runtime, database, prompts, bus, ready }
}

async function authenticate(request: Request, apiToken: string): Promise<{ subject: string } | null> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
  return token && token === apiToken ? { subject: 'browser-extension' } : null
}

async function seedSecret(
  rt: { secrets: { put(secret: LlmSecret): Promise<void> } },
  llm?: LlmSecret,
): Promise<void> {
  if (!llm) return
  await rt.secrets.put(llm)
}

export function startServer(options: {
  masterKey: string
  apiToken: string
  port?: number
  llm?: LlmSecret
  llmMaxRetries?: number
  llmTrace?: (event: LlmTraceEvent) => void
  databasePath?: string
}) {
  const { app, ready, database } = createBrowserExtensionBff(options)
  return new Promise<{ server: ReturnType<typeof serve>; database: DatabaseSync }>((resolve) => {
    ready.then(() => {
      const server = serve({ fetch: (req) => app.fetch(req), port: options.port ?? 8787, hostname: '127.0.0.1' }, () => {
        console.log(`BFF listening on http://localhost:${options.port ?? 8787}`)
      })
      resolve({ server, database })
    })
  })
}
```

**Important note on the `startServer` change:** The old code used Node native `http.createServer` and manually copied headers. The new code uses `serve` from `@hono/node-server`, which handles this natively. The env-loading and main-module code at the bottom of the file stays the same but must call `startServer` with the same options and handle `server.close()` + `database.close()` on shutdown.

Keep the existing `loadEnvFile()`, `ensureEnvTemplate()`, and main-module block from the old server.ts. The only change in that section is `database.close()` is now available from the `startServer` return value. Update the main block to:

```typescript
  const { server, database } = await startServer({ masterKey, apiToken, llm: { apiKey, baseUrl, model }, ...(llmTrace ? { llmTrace } : {}), llmMaxRetries, port, databasePath: dbPath })

  const shutdown = () => {
    server.close()
    database.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
```

- [ ] **Step 5: Run all BFF tests**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff test -- --run`
Expected: PASS (new SSE tests pass, existing tests may need updates for the tool-results change)

**Note:** The existing test `工具结果回填后继续推进模型` in server.test.ts expects `/tool-results` to return `{ type: 'final', output: ... }`. This endpoint's path has changed to `/api/tool-results/:callId` and now returns `{ accepted: true }`. Update this test to:
1. POST `/api/execute` to start
2. Listen for tool_call via bus (subscribe before starting)
3. POST `/api/tool-results/:callId` with `{ sessionId, output }`
4. Listen for final via bus

Add this updated test to `sse.test.ts` or update `server.test.ts`. The key assertion is that the bus receives a `final` event after resume.

- [ ] **Step 6: Typecheck**

Run: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
cd /Users/xuewen/ai-lab/project/agent-kit
git add examples/browser-extension-bff/
git commit -m "feat(bff): SSE control flow — /api/execute, /api/tool-results, /api/events"
```

---

### Task 5: Extension SSE Client

**Files:**
- Create: `src/agent/sseClient.ts`
- Test: `src/agent/sseClient.test.ts`

**Interfaces:**
- Produces: `createSseClient(): SseClient`, `SseClient` with `connect`, `disconnect`, `onToolCall`, `onFinal`, `onError`, `onLlmStatus`, `status` ref

- [ ] **Step 1: Write the failing test**

Create `/Users/xuewen/ai-lab/project/BOOS_browser_ext/src/agent/sseClient.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal EventSource mock for testing.
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {}
  onopen: (() => void) | null = null
  onerror: ((e: Event) => void) | null = null
  readyState = 0
  CLOSED = 2

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(handler)
  }
  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler)
  }
  close() {
    this.readyState = this.CLOSED
  }
  dispatch(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    for (const h of this.listeners[type] ?? []) h(event)
  }
  dispatchOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  dispatchError() {
    this.onerror?.(new Event('error'))
  }
}

describe('sseClient', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('connects with token in query param', async () => {
    const { createSseClient } = await import('./sseClient')
    const client = createSseClient()
    client.connect('http://localhost:8787', 'tok')
    expect(MockEventSource.instances[0]!.url).toContain('token=tok')
  })

  it('status becomes connected on open', async () => {
    const { createSseClient } = await import('./sseClient')
    const client = createSseClient()
    client.connect('http://localhost:8787', 'tok')
    MockEventSource.instances[0]!.dispatchOpen()
    expect(client.status.value).toBe('connected')
  })

  it('dispatches tool_call events to registered handler', async () => {
    const { createSseClient } = await import('./sseClient')
    const client = createSseClient()
    const received: unknown[] = []
    client.onToolCall((e) => received.push(e))
    client.connect('http://localhost:8787', 'tok')
    MockEventSource.instances[0]!.dispatch('tool_call', {
      callId: 'c1', toolName: 'browser_click', input: { ref: 1 }, sessionId: 's1',
    })
    expect(received[0]).toMatchObject({ callId: 'c1', toolName: 'browser_click' })
  })

  it('dispatches final events', async () => {
    const { createSseClient } = await import('./sseClient')
    const client = createSseClient()
    const received: unknown[] = []
    client.onFinal((e) => received.push(e))
    client.connect('http://localhost:8787', 'tok')
    MockEventSource.instances[0]!.dispatch('final', { output: 'done', sessionId: 's1' })
    expect(received[0]).toMatchObject({ output: 'done' })
  })

  it('dispatches error events', async () => {
    const { createSseClient } = await import('./sseClient')
    const client = createSseClient()
    const received: unknown[] = []
    client.onError((e) => received.push(e))
    client.connect('http://localhost:8787', 'tok')
    MockEventSource.instances[0]!.dispatch('error', { code: 'X', message: 'boom' })
    expect(received[0]).toMatchObject({ code: 'X', message: 'boom' })
  })

  it('dispatches llm_request/llm_response to llm status handler', async () => {
    const { createSseClient } = await import('./sseClient')
    const client = createSseClient()
    const received: unknown[] = []
    client.onLlmStatus((e) => received.push(e))
    client.connect('http://localhost:8787', 'tok')
    MockEventSource.instances[0]!.dispatch('llm_request', { model: 'm', messageCount: 2, toolCount: 1 })
    MockEventSource.instances[0]!.dispatch('llm_response', { durationMs: 100, finishReason: 'stop' })
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ type: 'llm_request' })
    expect(received[1]).toMatchObject({ type: 'llm_response' })
  })

  it('disconnect closes the EventSource', async () => {
    const { createSseClient } = await import('./sseClient')
    const client = createSseClient()
    client.connect('http://localhost:8787', 'tok')
    const es = MockEventSource.instances[0]!
    client.disconnect()
    expect(es.readyState).toBe(es.CLOSED)
    expect(client.status.value).toBe('disconnected')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/agent/sseClient.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `/Users/xuewen/ai-lab/project/BOOS_browser_ext/src/agent/sseClient.ts`:

```typescript
import { ref } from 'vue'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export interface ToolCallEvent {
  type: 'tool_call'
  callId: string
  toolName: string
  input: unknown
  sessionId: string
}

export interface FinalEvent {
  type: 'final'
  output: unknown
  reasoning?: string
  sessionId: string
}

export interface ErrorEvent {
  type: 'error'
  code: string
  message: string
  sessionId?: string
}

export interface LlmStatusEvent {
  type: 'llm_request' | 'llm_response' | 'llm_error'
  model?: string
  messageCount?: number
  toolCount?: number
  durationMs?: number
  finishReason?: string
  toolCallCount?: number
  error?: string
}

type ToolCallHandler = (event: ToolCallEvent) => void
type FinalHandler = (event: FinalEvent) => void
type ErrorHandler = (event: ErrorEvent) => void
type LlmStatusHandler = (event: LlmStatusEvent) => void

export interface SseClient {
  readonly status: ReturnType<typeof ref<ConnectionStatus>>
  connect(baseUrl: string, token: string): void
  disconnect(): void
  onToolCall(handler: ToolCallHandler): void
  onFinal(handler: FinalHandler): void
  onError(handler: ErrorHandler): void
  onLlmStatus(handler: LlmStatusHandler): void
}

export function createSseClient(): SseClient {
  const status = ref<ConnectionStatus>('disconnected')
  let es: EventSource | null = null
  const toolCallHandlers: ToolCallHandler[] = []
  const finalHandlers: FinalHandler[] = []
  const errorHandlers: ErrorHandler[] = []
  const llmStatusHandlers: LlmStatusHandler[] = []

  function parse<T>(e: MessageEvent): T {
    return JSON.parse(e.data as string) as T
  }

  function connect(baseUrl: string, token: string): void {
    if (es) es.close()
    status.value = 'connecting'
    const url = `${baseUrl.replace(/\/+$/, '')}/api/events?token=${encodeURIComponent(token)}`
    es = new EventSource(url)

    es.onopen = () => {
      status.value = 'connected'
    }
    es.onerror = () => {
      status.value = 'connecting'
    }

    es.addEventListener('tool_call', (e) => {
      for (const h of toolCallHandlers) h(parse<ToolCallEvent>(e))
    })
    es.addEventListener('final', (e) => {
      for (const h of finalHandlers) h(parse<FinalEvent>(e))
    })
    es.addEventListener('error', (e) => {
      // SSE 'error' event from server has JSON data; connection errors from EventSource have no data.
      if (e.data) {
        for (const h of errorHandlers) h(parse<ErrorEvent>(e))
      }
    })

    for (const type of ['llm_request', 'llm_response', 'llm_error'] as const) {
      es.addEventListener(type, (e) => {
        for (const h of llmStatusHandlers) h({ ...parse<Record<string, unknown>>(e), type } as LlmStatusEvent)
      })
    }
  }

  function disconnect(): void {
    es?.close()
    es = null
    status.value = 'disconnected'
  }

  return {
    status,
    connect,
    disconnect,
    onToolCall: (h) => toolCallHandlers.push(h),
    onFinal: (h) => finalHandlers.push(h),
    onError: (h) => errorHandlers.push(h),
    onLlmStatus: (h) => llmStatusHandlers.push(h),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run src/agent/sseClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/sseClient.ts src/agent/sseClient.test.ts
git commit -m "feat(ext): add SSE client for BFF event stream"
```

---

### Task 6: Extension agentClient Refactor

**Files:**
- Modify: `src/agent/agentClient.ts`
- Modify: `src/agent/agentClient.test.ts`

**Interfaces:**
- Produces:
  - `startExecute(config, sessionId, input, context, promptName?): Promise<void>` — POST /api/execute, expects 202
  - `submitToolResult(config, callId, sessionId, output): Promise<void>` — POST /api/tool-results/:callId, expects 202
  - Keeps: `runAgent()`, `BffError`, `toBffConfig()`, `checkBffConnectivity()`, `TaskPlan`, `StepEvent`
  - Removes: `runAgentSession()`, `AgentSessionOptions`, `PendingToolCall`, `AgentRunResult` (only the pending_tool_calls variant; keep final-only type for runAgent)

- [ ] **Step 1: Update agentClient.ts**

In `src/agent/agentClient.ts`:

1. Add `startExecute` function after `runAgent`:

```typescript
/** 启动 SSE 驱动的执行。立即返回 202，后续步骤通过 SSE 事件推送。 */
export async function startExecute(
  config: BffConfig,
  sessionId: string,
  input: string,
  context: Record<string, unknown> = {},
  promptName?: string,
): Promise<void> {
  await callBff<{ accepted: boolean }>(config, '/api/execute', {
    sessionId,
    input,
    context,
    ...(promptName ? { promptName } : {}),
  })
}
```

2. Change `submitToolResult` signature — remove sessionId from URL path, add to body, expect 202:

```typescript
/** 回填单个工具结果。SSE 模式下返回 202，后续步骤通过事件推送。 */
export async function submitToolResult(
  config: BffConfig,
  callId: string,
  sessionId: string,
  output: unknown,
): Promise<void> {
  await callBff<{ accepted: boolean }>(
    config,
    `/api/tool-results/${encodeURIComponent(callId)}`,
    { sessionId, output },
  )
}
```

3. Delete `runAgentSession` function (lines ~190-235), `AgentSessionOptions` interface, and `PendingToolCall` interface.

4. Keep `AgentRunResult` type but simplify — `runAgent` (planning) can only return `final` since `skipTools=true`:

Actually, keep `AgentRunResult` as-is for now because `runAgent` still returns it and the planning code checks `result.type !== 'final'`. The type is still valid.

- [ ] **Step 2: Update agentClient.test.ts**

Remove the entire `describe('runAgentSession', ...)` block and `describe('审批门集成', ...)` block (they test the deleted polling loop). Keep `describe('错误处理', ...)` but update the `submitToolResult` test:

Change the existing test:
```typescript
it('业务错误码原样透出', async () => {
  stubResponses({ status: 500, body: { code: 'SECRET_NOT_CONFIGURED', requestId: 'req-2', message: '密钥未配置' } });
  await expect(submitToolResult(config, 's-1', 'c1', {})).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' });
});
```
to:
```typescript
it('业务错误码原样透出', async () => {
  stubResponses({ status: 500, body: { code: 'SECRET_NOT_CONFIGURED', requestId: 'req-2', message: '密钥未配置' } });
  await expect(submitToolResult(config, 'c1', 's-1', {})).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' });
});
```

Add new tests for `startExecute`:

```typescript
describe('startExecute', () => {
  it('POSTs to /api/execute and returns on 202', async () => {
    const { calls } = stubResponses({ status: 202, body: { accepted: true } });
    await startExecute(config, 's-1', '你好', { currentUrl: 'https://example.com' });
    expect(calls[0]!.url).toBe('http://localhost:8787/api/execute');
    expect(calls[0]!.body).toMatchObject({ sessionId: 's-1', input: '你好' });
  });

  it('passes promptName when provided', async () => {
    const { calls } = stubResponses({ status: 202, body: { accepted: true } });
    await startExecute(config, 's-1', '评估', {}, 'candidate-assessment');
    expect(calls[0]!.body).toMatchObject({ promptName: 'candidate-assessment' });
  });

  it('omits promptName when not provided', async () => {
    const { calls } = stubResponses({ status: 202, body: { accepted: true } });
    await startExecute(config, 's-1', 'hi', {});
    expect(calls[0]!.body).not.toHaveProperty('promptName');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm test -- --run src/agent/agentClient.test.ts`
Expected: PASS

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: errors in useFreeFormController.ts (expected — it still imports deleted `runAgentSession`). We fix that in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agentClient.ts src/agent/agentClient.test.ts
git commit -m "refactor(ext): add startExecute, change submitToolResult for SSE, remove runAgentSession"
```

---

### Task 7: Extension useFreeFormController Refactor

**Files:**
- Modify: `src/composables/useFreeFormController.ts`

**Interfaces:**
- Consumes: `createSseClient` (Task 5), `startExecute` + `submitToolResult` (Task 6), `executeTool` + `isAllowedTool` (existing toolExecutor), `createApprovalGate` (existing)
- Produces: same composable return shape (UI doesn't change)

- [ ] **Step 1: Refactor submitInstruction and SSE wiring**

In `src/composables/useFreeFormController.ts`, make these changes:

1. Update imports at top:
   - Remove `runAgentSession` from agentClient import
   - Add `startExecute`, `submitToolResult` (already imported, check signature)
   - Add `createSseClient` import
   - Add `isAllowedTool` to toolExecutor imports (for the allowed check in handleToolCall)

2. Inside `useFreeFormController()`:
   - Create SSE client: `const sse = createSseClient()`
   - Add a ref for LLM status: `const llmStatus = ref('')`
   - Add `let currentTabId = -1` (set in submitInstruction, used by handleToolCall)
   - Add `let currentInstruction = ''` (saved before clearing the input ref, passed as userInstruction to executeTool)
   - Add `executingSessionId` to track which session the current run belongs to (for filtering SSE events)

3. Register SSE handlers once (inside the function body, not inside submitInstruction):

```typescript
sse.onToolCall(async (event) => {
  if (event.sessionId !== sessionId.value || runState.value !== 'running') return
  await handleToolCall(event.callId, event.toolName, event.input)
})

sse.onFinal((event) => {
  if (event.sessionId !== sessionId.value || runState.value !== 'running') return
  appendTurn('agent', formatOutput(event.output), currentSteps.value)
  runState.value = 'succeeded'
  llmStatus.value = ''
  void cdpActionService.detach()
  void generateSessionTitle()
})

sse.onError((event) => {
  if (event.sessionId && event.sessionId !== sessionId.value) return
  runState.value = 'failed'
  runError.value = { code: 'EXECUTION_FAILED', message: event.message }
  appendTurn('error', event.message, currentSteps.value, runError.value)
  llmStatus.value = ''
  void cdpActionService.detach()
})

sse.onLlmStatus((event) => {
  if (runState.value !== 'running') return
  if (event.type === 'llm_request') {
    llmStatus.value = '思考中…'
  } else {
    llmStatus.value = ''
  }
})
```

4. Add the `handleToolCall` function:

```typescript
async function handleToolCall(callId: string, toolName: string, rawInput: unknown): Promise<void> {
  const step = currentSteps.value.length + 1
  const allowed = isAllowedTool(toolName)

  let output: unknown
  let denied = false

  // Match original runAgentSession logic:
  // 1. Not in allowlist → executeTool returns TOOL_NOT_ALLOWED
  // 2. In allowlist + approval enabled → approval gate (gate auto-approves read-only tools)
  // 3. In allowlist + no approval → direct execution
  if (!allowed) {
    output = await executeTool(toolName, rawInput, { tabId: currentTabId, send, userInstruction: currentInstruction })
  } else if (settings.value.advanced.approvalEnabled) {
    const decision = await approvalGate.requestPermission(toolName, rawInput, currentUrl.value)
    if (decision.approved) {
      output = await executeTool(toolName, rawInput, { tabId: currentTabId, send, userInstruction: currentInstruction })
    } else {
      denied = true
      output = {
        ok: false,
        code: 'USER_DENIED',
        message: decision.reason ?? '用户拒绝了该操作，动作未执行。请不要尝试绕过，直接说明该步未获批准。',
      }
    }
  } else {
    output = await executeTool(toolName, rawInput, { tabId: currentTabId, send, userInstruction: currentInstruction })
  }

  currentSteps.value = [...currentSteps.value, {
    step,
    toolName,
    input: rawInput,
    output: humanizeStepOutput(output),
    allowed,
    ...(denied ? { denied } : {}),
  }]

  await submitToolResult(toBffConfig(settings.value), callId, sessionId.value, output)
}
```

**Important:** `currentTabId` needs to be stored. Add a `let currentTabId = -1` variable and set it in `submitInstruction` before starting.

5. Rewrite `submitInstruction`:

```typescript
async function submitInstruction(): Promise<void> {
  const text = instruction.value.trim()
  if (!text || isBusy.value) return

  settings.value = settingsService.load().normalized
  if (!settings.value.advanced.bffBaseUrl || !settings.value.advanced.bffApiToken) {
    runState.value = 'failed'
    runError.value = { code: 'CONFIG_MISSING', message: '请先在设置中配置 BFF 地址与接入 token。' }
    return
  }

  await refreshPageContext()
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tabId = tab?.id
  if (typeof tabId !== 'number') {
    runState.value = 'failed'
    runError.value = { code: 'ACTIVE_TAB_MISSING', message: '未找到活动标签页。' }
    return
  }
  currentTabId = tabId
  currentInstruction = text

  turns.value = [...turns.value, { role: 'user', text, timestamp: new Date().toISOString() }]
  instruction.value = ''
  currentSteps.value = []
  runState.value = 'running'
  runError.value = null
  llmStatus.value = ''

  const attached = await cdpActionService.attach()
  if (!attached.ok) {
    runState.value = 'failed'
    runError.value = attached.error ?? { code: 'NO_DEBUG_SESSION', message: '无法建立调试连接。' }
    appendTurn('error', runError.value.message)
    return
  }

  // Ensure SSE is connected before starting execution.
  if (sse.status.value === 'disconnected') {
    sse.connect(settings.value.advanced.bffBaseUrl, settings.value.advanced.bffApiToken)
  }

  try {
    const fileList = attachments.buildFileList()
    const context: Record<string, unknown> = {}
    if (fileList.length) context.fileList = fileList
    context.currentDate = buildDateContext()
    if (currentUrl.value) context.currentUrl = currentUrl.value
    if (currentTitle.value) context.pageTitle = currentTitle.value

    await startExecute(toBffConfig(settings.value), sessionId.value, text, context)
  } catch (error) {
    const message = error instanceof BffError ? error.message : error instanceof Error ? error.message : String(error)
    const bff = error instanceof BffError ? error : null
    runState.value = 'failed'
    runError.value = {
      code: 'EXECUTION_FAILED',
      message,
      ...(bff?.code ? { bffCode: bff.code } : {}),
      ...(bff?.requestId ? { requestId: bff.requestId } : {}),
    }
    appendTurn('error', message, currentSteps.value, runError.value)
    await cdpActionService.detach()
  }
}
```

6. Add `llmStatus` to the return object. Expose it for the UI to show "思考中…".

7. The `requestPlan()` function stays unchanged.

8. The `stop()` function: keep `abortController?.abort()` and approval denial, but the SSE connection stays open. After stop, events may still arrive but are ignored because `runState` is no longer `'running'`.

9. Connect SSE on `refreshSessions`/initial load. In `refreshSessions()` or an initialization block:

```typescript
// Connect SSE on first use. Reconnect if settings changed.
function ensureSseConnected(): void {
  const { advanced } = settingsService.load().normalized
  if (!advanced.bffBaseUrl || !advanced.bffApiToken) return
  if (sse.status.value === 'disconnected') {
    sse.connect(advanced.bffBaseUrl, advanced.bffApiToken)
  }
}
```

Call `ensureSseConnected()` at the end of `refreshPageContext` or when settings are saved. Since sidepanel lifecycle is managed by Vue, the SSE connection lives as long as the sidepanel is open (the composable is called once in setup).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Run all extension tests**

Run: `pnpm test -- --run`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

1. Start the BFF: `cd /Users/xuewen/ai-lab/project/agent-kit && pnpm --filter browser-extension-bff dev`
2. Build/run extension in dev mode: `pnpm dev`
3. Open sidepanel, configure BFF URL + token
4. Submit a simple instruction (e.g. "快照当前页面")
5. Verify: see "思考中…" status → tool execution step appears → final response appears
6. Test the plan flow: click "规划" → see TaskPlan → confirm → execution via SSE
7. Test stop: during execution click stop → task halts

- [ ] **Step 5: Commit**

```bash
git add src/composables/useFreeFormController.ts
git commit -m "refactor(ext): use SSE event-driven flow instead of HTTP polling in useFreeFormController"
```

---

## Verification Checklist

After all tasks:

- [ ] BFF tests pass: `cd agent-kit && pnpm --filter browser-extension-bff test -- --run`
- [ ] BFF typecheck passes: `cd agent-kit && pnpm --filter browser-extension-bff typecheck`
- [ ] Extension tests pass: `pnpm test -- --run`
- [ ] Extension typecheck passes: `pnpm typecheck`
- [ ] Manual: submit instruction → see LLM status → tool calls execute → final response
- [ ] Manual: plan phase works unchanged
- [ ] Manual: approval gate works for write operations
- [ ] Manual: SSE disconnect/reconnect recovers via Last-Event-ID
