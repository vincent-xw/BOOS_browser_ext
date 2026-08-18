import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {}
  onopen: (() => void) | null = null
  onerror: ((e: Event) => void) | null = null
  readyState = 0
  readonly CLOSED = 2

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
