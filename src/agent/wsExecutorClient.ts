import { executeTool, createMessageSender } from './toolExecutor'

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
        // 注册执行器能力，带上当前标签页信息
        const tabUrl = currentTabId ? chrome.tabs.get(currentTabId).then(t => t?.url).catch(() => undefined) : undefined
        Promise.resolve(tabUrl).then(url => {
          ws?.send(JSON.stringify({ type: 'register', tabUrl: url, tabTitle: currentTabId ? chrome.tabs.get(currentTabId).then(t => t?.title).catch(() => undefined) : undefined }))
        })
      }

      ws.onmessage = async (event) => {
        let msg: { type: string; callId: string; toolName: string; input: unknown } | null = null
        try {
          msg = JSON.parse(event.data)
          if (!msg || msg.type !== 'tool_call') return
          const tabId = currentTabId
          if (tabId === null) {
            ws?.send(JSON.stringify({
              type: 'tool_result',
              callId: msg.callId,
              output: { ok: false, code: 'NO_ACTIVE_TAB', message: '没有活跃标签页，无法执行工具。' },
            }))
            return
          }
          const output = await executeTool(msg.toolName, msg.input, { tabId, send })
          ws?.send(JSON.stringify({ type: 'tool_result', callId: msg.callId, output }))
        } catch (error) {
          console.error('[ws-executor] 消息处理失败:', error)
          const callId = msg?.callId ?? 'unknown'
          ws?.send(JSON.stringify({
            type: 'tool_result',
            callId,
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

export type WsExecutorClient = ReturnType<typeof createWsExecutorClient>