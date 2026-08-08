## ADDED Requirements

### Requirement: BFF SHALL 是唯一持有模型凭据的组件
BFF SHALL 独占持有模型 Endpoint、模型名称与 API Key。这些凭据 MUST NOT 出现在扩展代码、扩展配置、扩展存储或任何发往扩展的响应中。

#### Scenario: 模型凭据只存在于服务端
- **WHEN** 检查扩展侧的全部配置与存储
- **THEN** 其中不存在模型 Endpoint、模型名称或 API Key 任何一项

#### Scenario: 响应不回显凭据
- **WHEN** BFF 返回任何成功或失败响应
- **THEN** 响应体中不包含模型凭据

### Requirement: BFF SHALL 使用主密钥加密存储的模型密钥
BFF SHALL 通过环境变量提供的主密钥对持久化存储中的模型密钥做加解密，主密钥 MUST 仅存在于 BFF 进程环境中，MUST NOT 与被加密的数据存放在同一处。

#### Scenario: 主密钥缺失时拒绝启动
- **WHEN** BFF 启动时未提供主密钥环境变量
- **THEN** BFF 拒绝启动并输出明确的缺失配置提示

#### Scenario: 存储中的密钥为密文
- **WHEN** 检查 BFF 的持久化存储内容
- **THEN** 模型密钥以密文形式存在，且主密钥未被一并写入

### Requirement: BFF SHALL 对扩展请求做接入鉴权
BFF SHALL 校验请求携带的接入凭据，未通过鉴权的请求 MUST 返回未授权错误且 MUST NOT 触发任何模型调用。接入凭据 MUST 与 LLM API Key 相互独立。

#### Scenario: 携带有效凭据的请求被受理
- **WHEN** 扩展携带有效接入凭据请求 run 接口
- **THEN** BFF 受理该请求并执行 agent 运行

#### Scenario: 凭据缺失或错误
- **WHEN** 请求未携带接入凭据或凭据不匹配
- **THEN** BFF 返回未授权错误，且未发起任何模型调用

### Requirement: 会话与待执行调用 SHALL 按已认证主体隔离
BFF SHALL 将已认证主体绑定到会话命名空间。跨主体或跨会话的工具结果回填 MUST 被拒绝。

#### Scenario: 同名 sessionId 在不同主体间互不可见
- **WHEN** 两个不同主体使用相同的 sessionId 发起运行
- **THEN** 两者的会话历史彼此隔离，互相不可读取

#### Scenario: 跨主体回填被拒绝
- **WHEN** 某主体尝试回填另一主体发起的待执行调用标识
- **THEN** BFF 拒绝该回填并返回待执行调用不存在的错误

### Requirement: BFF 日志与错误响应 SHALL 不泄露敏感内容
BFF 日志 MUST NOT 记录模型密钥、Prompt 正文、模型原文输出或业务上下文明文。错误响应 SHALL 仅包含错误码、请求标识与可读消息。

#### Scenario: 错误响应结构受限
- **WHEN** BFF 处理请求时发生任意错误
- **THEN** 响应体仅包含错误码、请求标识与可读消息三项

#### Scenario: 日志不含 Prompt 正文
- **WHEN** 一次 agent 运行完成并写入日志
- **THEN** 日志中包含请求标识与耗时，但不包含 Prompt 正文或模型原文

### Requirement: BFF SHALL 提供可复现的本地启动方式
系统 SHALL 提供文档化的 BFF 本地启动路径，包含所需环境变量清单与启动命令，使开发者能在不阅读源码的情况下把服务跑起来。

#### Scenario: 按文档启动成功
- **WHEN** 开发者按文档设置环境变量并执行启动命令
- **THEN** BFF 成功监听并可响应 run 接口

#### Scenario: 扩展侧配置指向本地 BFF
- **WHEN** 开发者在扩展设置中填入本地 BFF 地址与接入 token
- **THEN** 扩展可成功发起一次 agent 运行
