## ADDED Requirements

### Requirement: LLM 请求 SHALL 携带已注册工具的 JSON Schema 声明
`@agent-kit/core` 的 LLM 客户端在构造请求体时 SHALL 包含 `tools` 字段，其内容由工具注册表中已注册工具的输入结构转换而来。当注册表为空时 `tools` 字段 SHALL 被省略。

#### Scenario: 已注册工具出现在请求体中
- **WHEN** 工具注册表中存在若干工具且 harness 发起一次 LLM 调用
- **THEN** 请求体包含 `tools` 数组，每个元素带有该工具的名称与 JSON Schema 形式的参数定义

#### Scenario: 注册表为空
- **WHEN** 工具注册表中没有任何工具
- **THEN** 请求体不包含 `tools` 字段

### Requirement: 系统 SHALL 提供工具输入结构到 JSON Schema 的转换
系统 SHALL 提供将工具输入的 zod 结构转换为 JSON Schema 的能力，且 SHALL 至少支持对象、字符串、数值、布尔、枚举、数组、可选字段与嵌套对象。对于无法转换的结构，系统 MUST 抛出带稳定错误码的异常，而不是静默产出不完整的 Schema。

#### Scenario: 转换嵌套对象结构
- **WHEN** 一个工具的输入是包含嵌套对象与可选字段的结构
- **THEN** 转换结果的 `properties` 与 `required` 正确反映字段层级与可选性

#### Scenario: 遇到不支持的结构
- **WHEN** 工具输入包含无法映射到 JSON Schema 的结构
- **THEN** 系统抛出带稳定错误码的异常，指明是哪个工具与哪个字段

### Requirement: 工具结果消息 SHALL 携带 tool_call_id
系统在向模型回传工具执行结果时，`role: 'tool'` 的消息 MUST 携带与该次调用对应的 `tool_call_id`。系统 MUST NOT 发送缺少 `tool_call_id` 的工具结果消息，因为 OpenAI 兼容端点会以 400 拒绝此类请求。

#### Scenario: 工具结果正确关联调用
- **WHEN** 一次工具调用完成并回传结果
- **THEN** 对应的工具结果消息携带该次调用的 `tool_call_id`

#### Scenario: 缺少关联标识
- **WHEN** 试图回传一个无法关联到任何已发起调用的工具结果
- **THEN** 系统拒绝该回传并返回稳定错误码，而不是发出缺少 `tool_call_id` 的请求

### Requirement: 会话历史 SHALL 持久化 assistant 轮次
会话消息结构 SHALL 支持 `assistant` 角色，并且系统 SHALL 将模型每一轮的输出（含其发起的工具调用）写入会话历史，使模型在后续轮次能看到自己的上一轮输出。

#### Scenario: 模型看到自己的上一轮输出
- **WHEN** agent 进入第二轮 LLM 调用
- **THEN** 发送给模型的消息序列中包含第一轮的 assistant 消息及其工具调用

#### Scenario: 工具调用与结果成对入库
- **WHEN** 一轮中模型发起工具调用且结果已回填
- **THEN** 会话历史中该 assistant 消息与对应的 tool 结果消息成对存在且顺序正确

### Requirement: 系统 SHALL 支持一轮内的多个并行工具调用
系统 SHALL 解析并处理模型在一轮响应中返回的全部工具调用，而 MUST NOT 只取第一个。

#### Scenario: 一轮返回多个工具调用
- **WHEN** 模型在单轮响应中返回两个工具调用
- **THEN** 系统为两者分别产生待执行项，并在两者结果都回填后才进入下一轮

#### Scenario: 部分工具调用失败
- **WHEN** 一轮中的多个工具调用里有一个执行失败
- **THEN** 系统将失败结果与成功结果一并回传给模型，而不中断整轮

### Requirement: 工具执行 SHALL 支持超时与取消
工具执行 SHALL 接受取消信号并受超时上限约束。当工具执行超过超时上限时，系统 MUST 以稳定错误码结束该次调用，而 MUST NOT 让 harness 循环无限期挂起。

#### Scenario: 工具执行超时
- **WHEN** 某工具的执行时间超过配置的超时上限
- **THEN** 系统取消该次执行并以超时错误码结束，harness 继续处理后续流程

#### Scenario: 任务被取消时工具随之中止
- **WHEN** 上层任务被取消
- **THEN** 正在执行的工具收到取消信号并尽快中止

### Requirement: 待执行工具调用 SHALL 通过可插拔存储持久化
harness 的待执行工具调用状态 SHALL 通过可替换的存储接口保存，使宿主环境能提供非内存实现。系统 MUST NOT 将待执行调用只保存在进程内存中。

#### Scenario: 宿主提供自定义存储
- **WHEN** 宿主环境在创建 harness 时注入自定义的待执行调用存储实现
- **THEN** harness 通过该实现读写待执行调用状态

#### Scenario: 进程重启后回填仍可关联
- **WHEN** 承载 harness 的进程重启后收到一个此前发起的 `callId` 回填
- **THEN** harness 从持久化存储中找到该待执行调用并正常恢复流程

### Requirement: 上下文管理与输出协议声明 SHALL 被实际接入
系统 SHALL 将上下文裁剪能力接入 harness 的消息构造流程，并 SHALL 在构造请求时读取并应用 prompt 注册表中声明的输出协议。声明但从未生效的配置项 MUST NOT 保留在公开接口中。

#### Scenario: 历史超限时被裁剪
- **WHEN** 会话历史长度超过配置上限且 harness 发起 LLM 调用
- **THEN** 发送给模型的消息序列已按上下文管理策略裁剪

#### Scenario: 输出协议被应用
- **WHEN** 某个 prompt 声明了输出协议
- **THEN** 该声明在构造请求时被实际应用，而不是被忽略

### Requirement: 包 SHALL 同时支持工作区依赖与 npm 发布两种消费方式
agent-kit 各包 SHALL 可通过工作区依赖被本地项目消费，且 SHALL 具备发布到 npm 的条件。发布相关的包元数据 MUST 在发布前解除阻止发布的限制。

#### Scenario: 开发期通过工作区消费
- **WHEN** 本地项目以工作区或本地路径方式依赖 `@agent-kit/core`
- **THEN** 项目可正常解析类型与运行时入口并完成类型检查

#### Scenario: 生产期通过 npm 版本消费
- **WHEN** 包已发布到 npm 且项目改为版本号依赖
- **THEN** 项目无需修改导入语句即可正常构建
