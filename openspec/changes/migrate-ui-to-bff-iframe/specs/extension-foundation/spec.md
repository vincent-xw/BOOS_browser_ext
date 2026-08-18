# extension-foundation

## MODIFIED Requirements

### Requirement: 浏览器插件基础架构 SHALL 通过 iframe 嵌入 BFF 提供的 UI 壳层
项目 SHALL 由 BFF 承载浏览器 AI 助手的聊天 UI 壳层，浏览器插件侧边栏 SHALL 通过 iframe 嵌入该 BFF 页面。插件自身不再直接承载聊天 UI 组件，只保留轻量的 iframe 容器与 BFF 连接配置入口。

#### Scenario: 启动初始 UI 入口
- **WHEN** 用户打开插件的侧边栏 UI 入口
- **THEN** 系统以 iframe 渲染 BFF 提供的聊天界面，页面对应已迁入的原有 Vue 3 交互功能

#### Scenario: 扩展新的 UI 入口
- **WHEN** 后续能力需要新增另一个 UI 入口
- **THEN** 系统可复用 BFF 托管的前端工程，而无需在插件侧重复承载 UI 组件

### Requirement: UI 壳层 SHALL 一致性使用 Vue 3 与 Element Plus
BFF 承载的聊天用户界面 SHALL 使用 Vue 3 实现，并 SHALL 使用 Element Plus 作为通用布局、表单、状态展示与反馈元素的默认组件库；该界面经 iframe 嵌入插件侧栏后呈现效果与既有规范保持一致。

#### Scenario: 渲染主界面
- **WHEN** BFF 聊天界面被渲染
- **THEN** 共享 UI 元素遵循 Vue 3 组件约定，并使用基于 Element Plus 的组件完成主要交互

### Requirement: 基础架构 SHALL 定义共享状态与反馈约定
项目 SHALL 定义加载中状态、成功反馈和错误反馈的共享约定，使 BFF UI 在执行页面操作时保持一致的表现方式；模型思考与工具进度 SHALL 通过 SSE 实时呈现，而非等到 HTTP 响应才更新。

#### Scenario: 展示进行中的页面操作
- **WHEN** 页面操作正在执行中
- **THEN** BFF UI 通过 SSE 实时展示标准化的忙碌状态与进行中的工具步骤，而不是让用户处于无反馈等待

#### Scenario: 展示操作失败
- **WHEN** 页面操作失败或当前不可用
- **THEN** BFF UI 展示一个标准化的错误状态，并且用户无需查看开发者工具即可理解该状态