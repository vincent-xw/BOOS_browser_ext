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

export interface SseErrorEvent {
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
type ErrorHandler = (event: SseErrorEvent) => void
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
      // SSE 'error' events from the server carry JSON data;
      // EventSource connection errors have no data.
      if (e.data) {
        for (const h of errorHandlers) h(parse<SseErrorEvent>(e))
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
