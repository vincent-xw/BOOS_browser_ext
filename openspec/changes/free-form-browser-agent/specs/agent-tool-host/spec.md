## MODIFIED Requirements

### Requirement: 系统 SHALL 注册覆盖浏览器自动化闭环的远端工具集
系统 SHALL 注册以下远端工具，每个工具的输入与输出 SHALL 有明确的结构定义：
页面元素快照（`browser.snapshot`）、读取页面（`browser.read_page`）、
定位元素（`browser.locate_element`）、点击（`browser.click`）、
输入文本（`browser.input_text`）、按键（`browser.press_key`）、滚动（`browser.scroll`）、
验证（`browser.verify`）、截图（`browser.screenshot`）。

每个工具 SHALL 带有供模型理解用途的说明。工具 SHALL 按是否改变页面状态划分为只读与写两类，
该划分是审批门的判定依据。

#### Scenario: 快照工具返回可交互元素
- **WHEN** agent 调用 `browser.snapshot`
- **THEN** 扩展返回视口内可交互元素的 ref、标签、类型与坐标

#### Scenario: 定位工具返回坐标
- **WHEN** agent 调用 `browser.locate_element` 并给出 ref、选择器或预设角色之一
- **THEN** 扩展返回元素中心坐标、可见性与遮挡判定

#### Scenario: 点击工具执行真实点击
- **WHEN** agent 调用 `browser.click`
- **THEN** 扩展经 CDP 下发三段鼠标事件并返回执行结果

#### Scenario: 验证工具返回多维度观测
- **WHEN** agent 调用 `browser.verify` 并传入期望条件
- **THEN** 扩展返回各验证维度的实际观测值与总体是否通过

#### Scenario: 工具输入不合法
- **WHEN** BFF 下发的工具输入不满足该工具的输入结构定义
- **THEN** 扩展拒绝执行并回填输入不合法的失败结果

#### Scenario: 只读与写工具划分明确
- **WHEN** 查询任一已注册工具是否只读
- **THEN** 快照、读取页面、定位、验证、截图为只读；点击、输入文本、按键、滚动为写

### Requirement: 扩展 SHALL 仅执行白名单内的远端工具
扩展 SHALL 维护一份显式的远端工具白名单，并在执行前校验 BFF 返回的工具名。
对于白名单外的工具名，扩展 MUST 拒绝执行并将拒绝原因回填给 BFF。

#### Scenario: 白名单内工具正常执行
- **WHEN** BFF 请求执行 `browser.click` 且该工具在白名单内
- **THEN** 扩展执行该工具并回填结构化输出

#### Scenario: 白名单外工具被拒绝
- **WHEN** BFF 请求执行一个不在白名单内的工具名
- **THEN** 扩展不执行任何页面动作，并回填一个明确表示工具未授权的失败结果

### Requirement: 扩展 SHALL 通过 run 与 tool-results 两个接口与 BFF 协作
扩展 SHALL 通过 `POST /v1/agent/sessions/:sessionId/run` 发起 agent 运行，并在响应为
`pending_tool_calls` 时执行对应工具，再通过
`POST /v1/agent/sessions/:sessionId/tool-results/:callId` 回填结果。
两个请求 MUST 携带 BFF 接入 token 作为 `Authorization: Bearer` 凭据。

run 请求 SHALL 支持指定使用哪个已注册提示词，以区分自由指令与既有的批量评估用途。

#### Scenario: 发起运行并得到最终结果
- **WHEN** 扩展发起 run 请求且 agent 无需调用远端工具
- **THEN** 扩展收到 `final` 类型响应并将结果呈现给用户

#### Scenario: 收到待执行工具调用
- **WHEN** run 响应类型为 `pending_tool_calls`
- **THEN** 扩展解析出工具名与 `callId`，执行该工具，并将输出回填到 tool-results 接口

#### Scenario: 回填后继续下一轮
- **WHEN** 工具结果回填成功且 agent 需要继续调用工具
- **THEN** 扩展对新返回的 `pending_tool_calls` 重复执行与回填流程，直到收到 `final`

#### Scenario: 接入 token 无效
- **WHEN** BFF 返回 401 与 `UNAUTHORIZED`
- **THEN** 扩展中止任务并提示用户检查 BFF 地址与接入 token 配置

#### Scenario: 指定提示词
- **WHEN** 扩展发起 run 请求并指定提示词名称
- **THEN** 该名称随请求发送，BFF 使用对应提示词及其输出协议

#### Scenario: 省略提示词名称
- **WHEN** 扩展发起 run 请求且未指定提示词
- **THEN** 请求体不含该字段，BFF 使用默认提示词

## ADDED Requirements

### Requirement: 动作工具 SHALL 支持以 ref 指定目标并在执行前重解析坐标
点击与输入文本工具 SHALL 接受元素引用（ref）作为目标。传入 ref 时，扩展 MUST 在下发
CDP 动作**之前**按该 ref 重新解析当前坐标，MUST NOT 使用调用方给出的坐标。

这使「每步重新计算坐标」由执行侧保证，而不依赖模型自觉遵守。

#### Scenario: 按 ref 取当前坐标而非调用方给的坐标
- **WHEN** 调用方同时给出 ref 与一组坐标
- **THEN** 扩展按 ref 解析出的坐标执行动作，忽略调用方给出的坐标

#### Scenario: ref 解析先于动作下发
- **WHEN** 调用方以 ref 请求点击
- **THEN** 扩展先解析 ref，再下发点击

#### Scenario: ref 失效时不下发动作
- **WHEN** 按 ref 解析返回失效标记
- **THEN** 扩展不下发任何页面动作，并提示需要重新快照

#### Scenario: 目标被遮挡时不下发动作
- **WHEN** 按 ref 解析发现目标被其他元素遮挡
- **THEN** 扩展不下发点击，并在结果中指出遮挡元素

#### Scenario: 坐标缺失且无 ref 时拒绝执行
- **WHEN** 调用方既未给出 ref，也未给出有效坐标
- **THEN** 扩展拒绝执行并提示应先快照取 ref

### Requirement: 输入文本 SHALL 支持先清空既有内容
输入文本工具 SHALL 提供先清空再写入的选项。未指定时保持追加语义。

#### Scenario: 指定先清空
- **WHEN** 调用方要求写入前先清空输入框
- **THEN** 扩展先聚焦并清除既有内容，再写入新文本

#### Scenario: 未指定清空
- **WHEN** 调用方未要求清空
- **THEN** 扩展直接写入，不清除既有内容
