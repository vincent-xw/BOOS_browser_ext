## ADDED Requirements

### Requirement: 扩展 SHALL 作为 Tool Host 而不持有模型凭据
扩展 SHALL 仅作为远端工具的执行方（Tool Host）。扩展 MUST NOT 存储或使用 LLM API Key、模型名称或模型 Endpoint，也 MUST NOT 直接请求任何模型推理接口。所有模型调用 SHALL 由 BFF 代为发起。

#### Scenario: 扩展配置中不存在模型字段
- **WHEN** 用户打开扩展设置界面
- **THEN** 界面中不存在 LLM Endpoint、模型名称与 API Key 任何一项配置

#### Scenario: 扩展不直连模型接口
- **WHEN** agent 任务运行
- **THEN** 扩展发出的网络请求只包含 BFF 地址与目标站点地址，不包含任何模型推理接口

### Requirement: 扩展 SHALL 通过 run 与 tool-results 两个接口与 BFF 协作
扩展 SHALL 通过 `POST /v1/agent/sessions/:sessionId/run` 发起 agent 运行，并在响应为 `pending_tool_call` 时执行对应工具，再通过 `POST /v1/agent/sessions/:sessionId/tool-results/:callId` 回填结果。两个请求 MUST 携带 BFF 接入 token 作为 `Authorization: Bearer` 凭据。

#### Scenario: 发起运行并得到最终结果
- **WHEN** 扩展发起 run 请求且 agent 无需调用远端工具
- **THEN** 扩展收到 `final` 类型响应并将结果呈现给用户

#### Scenario: 收到待执行工具调用
- **WHEN** run 响应类型为 `pending_tool_call`
- **THEN** 扩展解析出工具名与 `callId`，执行该工具，并将输出回填到 tool-results 接口

#### Scenario: 回填后继续下一轮
- **WHEN** 工具结果回填成功且 agent 需要继续调用工具
- **THEN** 扩展对新返回的 `pending_tool_call` 重复执行与回填流程，直到收到 `final`

#### Scenario: 接入 token 无效
- **WHEN** BFF 返回 401 与 `UNAUTHORIZED`
- **THEN** 扩展中止任务并提示用户检查 BFF 地址与接入 token 配置

### Requirement: 扩展 SHALL 仅执行白名单内的远端工具
扩展 SHALL 维护一份显式的远端工具白名单，并在执行前校验 BFF 返回的工具名。对于白名单外的工具名，扩展 MUST 拒绝执行并将拒绝原因回填给 BFF。

#### Scenario: 白名单内工具正常执行
- **WHEN** BFF 请求执行 `browser.click` 且该工具在白名单内
- **THEN** 扩展执行该工具并回填结构化输出

#### Scenario: 白名单外工具被拒绝
- **WHEN** BFF 请求执行一个不在白名单内的工具名
- **THEN** 扩展不执行任何页面动作，并回填一个明确表示工具未授权的失败结果

### Requirement: 系统 SHALL 注册覆盖浏览器自动化闭环的远端工具集
系统 SHALL 注册以下远端工具，每个工具的输入与输出 SHALL 有明确的结构定义：读取页面（`browser.read_page`）、定位元素（`browser.locate_element`）、点击（`browser.click`）、输入文本（`browser.input_text`）、按键（`browser.press_key`）、滚动（`browser.scroll`）、验证（`browser.verify`）、截图（`browser.screenshot`）。

#### Scenario: 定位工具返回坐标
- **WHEN** agent 调用 `browser.locate_element` 并传入选择器意图
- **THEN** 扩展返回元素中心坐标、可见性与遮挡判定

#### Scenario: 点击工具执行真实点击
- **WHEN** agent 调用 `browser.click` 并传入坐标
- **THEN** 扩展经 CDP 下发三段鼠标事件并返回执行结果

#### Scenario: 验证工具返回多维度观测
- **WHEN** agent 调用 `browser.verify` 并传入期望条件
- **THEN** 扩展返回各验证维度的实际观测值与总体是否通过

#### Scenario: 工具输入不合法
- **WHEN** BFF 下发的工具输入不满足该工具的输入结构定义
- **THEN** 扩展拒绝执行并回填输入不合法的失败结果

### Requirement: agent 会话状态 SHALL 在 Service Worker 挂起后可恢复
系统 SHALL 将 agent 任务的会话标识、当前待执行工具调用与调试会话状态持久化，使得 Manifest V3 Service Worker 被挂起后重新唤醒时任务仍可继续或安全终止。系统 MUST NOT 仅依赖 Service Worker 的内存变量保存这些状态。

#### Scenario: Service Worker 挂起后恢复任务
- **WHEN** Service Worker 在等待期间被浏览器挂起后重新唤醒
- **THEN** 系统从持久化状态恢复会话标识与待执行工具调用，并继续任务

#### Scenario: 调试会话已失效时安全终止
- **WHEN** Service Worker 唤醒后发现原调试会话已断开
- **THEN** 系统将任务标记为失败并清理持久化状态，而不是向已失效的会话下发命令

### Requirement: 单步闭环 SHALL 由 agent 驱动且逐步验证
agent 任务 SHALL 按「读取 DOM → 定位元素 → 重新计算坐标 → 执行一个 CDP 动作 → 等待页面更新 → 验证结果 → 决定下一步」的闭环推进。每一轮 MUST 只执行一个页面写动作。

#### Scenario: 逐步推进打招呼流程
- **WHEN** agent 执行「打招呼并发送消息」任务
- **THEN** 系统依次完成定位按钮、点击、验证弹窗、定位输入框、点击、输入文本、验证内容、点击发送、验证请求，每步之间均有验证

#### Scenario: 某步验证失败时中止后续步骤
- **WHEN** 闭环中任一步的验证未通过
- **THEN** 系统中止该任务的后续步骤，并向 UI 报告失败发生在哪一步及其观测值

### Requirement: 任务 SHALL 暴露分步状态与可读失败原因
系统 SHALL 为 agent 任务暴露空闲、执行中、成功、失败四种状态，并且失败结果 MUST 包含错误码、可读消息与失败步骤的细节，使用户无需打开开发者工具即可理解失败原因。

#### Scenario: 展示当前执行步骤
- **WHEN** agent 任务正在执行
- **THEN** 界面展示当前所处步骤及已完成步骤数

#### Scenario: 展示可读失败原因
- **WHEN** agent 任务失败
- **THEN** 界面展示错误码、可读消息与失败步骤，而不是原始堆栈
