# browser-executor-ws

## ADDED Requirements

### Requirement: 插件 SHALL 通过 WebSocket 执行 BFF 下发的工具调用
插件 background SHALL 建立到 BFF 的 WebSocket 长连接，接收 BFF 下发的 `tool_call` 消息；对于其中的页面操作工具，SHALL 通过既有的 CDP/内容脚本执行并以 `tool_result` 消息回传结果。

#### Scenario: 收到并执行页面工具
- **WHEN** BFF 通过 WebSocket 下发一个页面操作 `tool_call`（如点击、输入）
- **THEN** 插件在目标标签页执行对应页面操作，并把结构化的结果通过 WebSocket 回传

#### Scenario: 无活跃标签页无法执行
- **WHEN** 插件收到 `tool_call` 但当前没有可用的活跃标签页
- **THEN** 插件回传一个带有明确错误码与原因的结果，而不是让 BFF 无响应等待

### Requirement: 插件 SHALL 在连接建立与断开时向 BFF 上报执行器状态
插件 SHALL 在 WebSocket 连接建立时向 BFF 注册执行器能力并上报当前标签页 URL 与标题；断开时应触发 BFF 侧状态更新。

#### Scenario: 连接建立时上报页面信息
- **WHEN** 插件的 WebSocket 连接建立
- **THEN** 插件发送 register 消息，携带当前标签页的 URL 与标题，供 BFF UI 展示页面上下文

#### Scenario: 连接断开时标记离线
- **WHEN** 插件的 WebSocket 连接断开
- **THEN** BFF 将执行器状态标记为离线并推送通知，UI 展示执行器离线指示

### Requirement: 插件 SHALL 维持长连接并自动重连
插件 SHALL 在连接意外断开后按指数退避自动重连，并处理 MV3 Service Worker 生命周期（如通过心跳保持活跃），以保证 BFF 驱动的会话能持续执行工具。

#### Scenario: 断线后自动重连
- **WHEN** 插件的 WebSocket 连接意外断开
- **THEN** 插件按递增间隔自动重连，直至重新建立连接