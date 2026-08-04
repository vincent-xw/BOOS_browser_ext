## MODIFIED Requirements

### Requirement: 插件 SHALL 通过 Chrome MCP 集成层写入页面内容
系统 SHALL 暴露一个专用的页面 I/O 集成层，用于发送页面写入操作；写入流程 SHALL 向调用方 UI 提供标准化的成功或失败结果。写入能力 SHALL 支持候选人收藏动作触发、打招呼动作触发与消息文本输入。

所有页面写入 MUST 经由 Service Worker 的 `chrome.debugger` 会话以 Chrome DevTools Protocol `Input` 域下发真实事件。集成层 MUST NOT 使用 `element.click()`、`element.dispatchEvent()`、`input.value` 赋值或 `element.textContent` 赋值等 DOM 合成方式完成写入。

#### Scenario: 成功写入页面内容
- **WHEN** 用户在插件界面中提交一个有效的页面写入操作
- **THEN** 系统通过 CDP 下发真实输入事件，并向 UI 报告一个成功结果

#### Scenario: 页面写入失败
- **WHEN** 页面写入请求无法完成
- **THEN** 系统返回一个结构化的失败结果，其中包含足够的信息，以便 UI 展示面向用户的错误消息

#### Scenario: 成功触发收藏按钮写入动作
- **WHEN** 模型判定某候选人值得收藏
- **THEN** 系统重新定位收藏按钮、重新计算坐标，并通过 CDP 三段鼠标事件完成点击，随后验证结果

#### Scenario: 写入前调试会话不可用
- **WHEN** 提交写入操作时目标标签页没有可用的调试会话
- **THEN** 系统返回失败结果并提示需要先启动任务以建立调试连接

### Requirement: 插件 SHALL 通过 Chrome MCP 集成层读取页面信息
系统 SHALL 暴露一个专用的页面 I/O 集成层，用于读取当前页面信息；UI 模块 SHALL 通过该集成层使用此能力，而不是直接调用底层传输细节。该读取能力 SHALL 支持候选人列表读取与候选人详情（在线简历）读取两个阶段，并 SHALL 支持元素定位与坐标计算。

读取 SHALL 在所有 frame 中执行并聚合结果后按评分取最优，MUST NOT 退化为仅读取主 frame。

#### Scenario: 成功读取当前页面信息
- **WHEN** 用户在插件界面中触发页面读取操作
- **THEN** 系统请求页面信息，并返回一个可供 UI 展示的结果

#### Scenario: 页面读取时能力不可用
- **WHEN** 用户触发页面读取操作，且底层读取通道不可用或拒绝该请求
- **THEN** 系统返回一个结构化的失败结果，以便 UI 将其展示为错误状态

#### Scenario: 顺序读取候选人列表与详情信息
- **WHEN** 自动化流程启动并进入候选人处理阶段
- **THEN** 系统先读取候选人列表，再逐项读取候选人在线简历信息

#### Scenario: 读取元素定位与坐标
- **WHEN** 上层需要对某元素执行写操作
- **THEN** 系统返回该元素的中心坐标、可见性与遮挡判定，供写操作使用

### Requirement: 页面 I/O 交互 SHALL 暴露明确的操作状态
系统 SHALL 为页面读写交互暴露明确的操作状态，包括空闲、执行中、成功和失败，以便 UI 能一致地反映读取和写入动作的生命周期。对于多步骤候选人流程，系统 SHALL 暴露每步状态与最终汇总结果。

结果封装 SHALL 标明本次操作所使用的执行通道，并 SHALL 将 CDP 通道作为可识别的通道类型之一。

#### Scenario: 从空闲切换到执行中
- **WHEN** 读取或写入操作开始执行
- **THEN** 系统暴露执行中状态，直到该操作完成或失败

#### Scenario: 返回终态
- **WHEN** 读取或写入操作结束
- **THEN** 系统暴露成功状态或失败状态之一，供 UI 使用

#### Scenario: 多步骤流程返回汇总终态
- **WHEN** 候选人批量流程结束
- **THEN** 系统返回包含成功数、失败数与失败原因摘要的终态结果

#### Scenario: 结果标明执行通道
- **WHEN** 一次写操作通过 CDP 完成
- **THEN** 返回结果中标明该操作使用的是 CDP 通道

## ADDED Requirements

### Requirement: 写操作结果 SHALL 经过独立验证后才判定成功
集成层 SHALL 在每次写操作之后执行独立的结果验证，并 MUST NOT 以底层命令未报错作为成功判据。

#### Scenario: 命令成功但页面未变化
- **WHEN** 写操作的底层命令返回成功，但验证阶段未观测到任何预期的页面变化
- **THEN** 集成层将该操作判定为失败并返回观测细节

#### Scenario: 验证通过后判定成功
- **WHEN** 写操作后验证阶段观测到预期的页面变化或网络结果
- **THEN** 集成层判定该操作成功

## REMOVED Requirements

### Requirement: 通过改写页面全局请求对象观测写操作副作用
**Reason**: 在页面上下文中 monkey-patch `window.fetch` 与 `XMLHttpRequest.prototype` 侵入站点运行时、易与站点自身逻辑冲突，且在恢复失败时会污染页面。CDP `Network` 域提供了非侵入的等价观测能力。
**Migration**: 改用 `cdp-real-interaction` 能力中定义的 CDP `Network` 域事件观测；`startFavoriteNetworkRecording` / `stopFavoriteNetworkRecording` / `replayFavoriteNetworkRequests` 这组基于注入改写的接口一并移除，由 CDP 观测接口替代。
