# chrome-mcp-page-io

## MODIFIED Requirements

### Requirement: 插件 SHALL 通过 WebSocket 执行器响应 BFF 的页面读写调用
系统 SHALL 由 BFF 在驱动 agent 循环时决定调用哪些页面工具，并通过 WebSocket 把 `tool_call` 下发到插件执行器；插件执行器 SHALL 在目标标签页读取/写入页面，并把结构化的成功/失败结果以 `tool_result` 回传给 BFF 继续推理。UI 不再直接驱动页面 I/O。

#### Scenario: BFF 触发的页面读取
- **WHEN** BFF 在推理中决定调用页面读取工具
- **THEN** 插件执行器完成读取并通过 WebSocket 返回结果，BFF 将结果并入上下文继续

#### Scenario: BFF 触发的页面写入
- **WHEN** BFF 在推理中决定调用页面写入工具
- **THEN** 插件执行器在目标页面执行写入并通过 WebSocket 返回标准化成功/失败结果

#### Scenario: 页面 I/O 执行失败
- **WHEN** 页面读写请求无法由插件执行器完成
- **THEN** 插件返回结构化的失败结果（含错误码与面向模型的消息），BFF 将失败反馈给模型而非中断会话