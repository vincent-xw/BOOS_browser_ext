# bff-ui

## ADDED Requirements

### Requirement: BFF SHALL 承载并通过 iframe 向插件提供聊天 UI
BFF 拥有的 Web UI 聊天界面 SHALL 由 BFF 下托管，浏览器插件通过侧边栏 iframe 嵌入该页面。用户在插件侧栏看到的就是 BFF 的服务页面。

#### Scenario: 插件侧栏加载 BFF UI
- **WHEN** 用户打开浏览器插件的侧边栏
- **THEN** 侧边栏以 iframe 渲染 BFF 提供的聊天页面，页面内容由 BFF 静态托管

#### Scenario: BFF 未运行
- **WHEN** 用户打开插件侧边栏但 BFF 服务不可达
- **THEN** 侧边栏 iframe 无法加载，并展示一个明确的连接失败提示而非白屏

### Requirement: BFF UI SHALL 通过 SSE 实时展示模型思考与工具进度
BFF 聊天页面 SHALL 订阅 BFF 的 SSE 事件流，实时展示模型执行过程中的工具调用开始/结束、进行中的步骤，而不是在每次 HTTP 响应后才刷新。

#### Scenario: 模型调用工具时实时更新
- **WHEN** BFF 开始执行一个工具调用
- **THEN** 页面通过 SSE 的 `tool_start` 事件立即添加一条"运行中"的步骤卡片

#### Scenario: 工具完成后更新结果
- **WHEN** 一个工具执行完成
- **THEN** 页面通过 SSE 的 `tool_end` 事件将该步骤更新为成功/失败并展示耗时与输出摘要

### Requirement: BFF UI SHALL 支持"评估→计划→确认→执行"交互
聊天页面 SHALL 支持用户先发起规划（评估可行性），展示包含步骤、风险、置信度的计划卡片，由用户确认后进入执行；用户也可取消或直接执行。

#### Scenario: 评估并预览计划
- **WHEN** 用户输入指令并点击"评估"
- **THEN** 页面调用 BFF 规划接口，展示可行性、置信度、步骤列表、风险与模型思考过程，等待用户确认

#### Scenario: 确认后执行
- **WHEN** 用户在计划卡片点击"确认执行"
- **THEN** 页面发起执行，通过 SSE 实时展示工具执行进度

### Requirement: BFF UI SHALL 管理会话、技能与文件
聊天页面 SHALL 提供多会话的新建/切换/删除、技能的保存/加载/删除、文件的查看/上传/下载/勾选注入上下文能力，数据由 BFF 持久化。

#### Scenario: 切换会话恢复历史
- **WHEN** 用户在会话下拉中切换到另一个会话
- **THEN** 页面从 BFF 加载该会话的历史消息并渲染

#### Scenario: 将当前对话保存为技能
- **WHEN** 用户点击"保存为技能"并输入名称
- **THEN** BFF 持久化该技能的指令与摘要，之后可从技能列表加载复用

#### Scenario: 下载 agent 生成的文件
- **WHEN** 用户在对话或文件管理中触发下载
- **THEN** 浏览器从 BFF 的文件下载接口获取该文件

### Requirement: BFF UI SHALL 提供消息与诊断日志复制
聊天页面 SHALL 允许用户复制任一轮的消息文本；对于错误轮次，SHALL 提供复制供排查用的结构化诊断日志（含会话号、错误信息与步骤入参出参）。

#### Scenario: 复制单条消息
- **WHEN** 用户悬停某条消息并点击复制
- **THEN** 该消息文本被复制到剪贴板并给出成功提示

#### Scenario: 复制错误诊断日志
- **WHEN** 用户对一条错误消息点击"复制诊断日志"
- **THEN** 剪贴板获得包含会话号、错误、步骤详情的诊断文本