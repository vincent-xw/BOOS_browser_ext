## ADDED Requirements

### Requirement: 扩展 SHALL 声明调试与目标站点内容脚本能力
扩展清单 SHALL 声明 `debugger` 权限，并 SHALL 声明匹配目标站点的 content script。清单 SHALL 声明 BFF 地址所需的 host 权限。

#### Scenario: 调试权限可用
- **WHEN** 扩展安装完成后首次对目标标签页发起 attach
- **THEN** attach 因清单已声明 `debugger` 权限而成功

#### Scenario: content script 在目标站点自动注入
- **WHEN** 用户打开匹配目标站点 host 规则的页面
- **THEN** content script 自动注入并可响应定位与验证请求

#### Scenario: 可访问 BFF 地址
- **WHEN** 扩展向已配置的 BFF 地址发起请求
- **THEN** 请求因清单已声明该 host 权限而未被拦截

### Requirement: 扩展 SHALL 提供集中的消息路由层
扩展 SHALL 在 Service Worker 中提供集中的消息路由层，用于分发来自 UI 与 content script 的请求。消息类型 SHALL 有显式的类型定义，未知消息类型 MUST 返回结构化失败结果而不是静默忽略。

#### Scenario: 已知消息被正确分发
- **WHEN** UI 或 content script 发送一个已定义类型的消息
- **THEN** 路由层将其分发到对应处理器并返回结构化结果

#### Scenario: 未知消息类型
- **WHEN** 路由层收到未定义类型的消息
- **THEN** 路由层返回结构化失败结果，指明该消息类型未被支持

### Requirement: 扩展 SHALL 向用户说明调试连接的可见影响
系统 SHALL 在建立调试会话前或建立时告知用户目标标签页将出现「正在被调试」提示，并说明手动关闭该提示会中止任务。

#### Scenario: 首次启动任务时提示调试横幅
- **WHEN** 用户首次启动需要调试会话的任务
- **THEN** 界面说明标签页将出现调试提示条，以及关闭它会中止任务

#### Scenario: 调试连接被断开后的引导
- **WHEN** 调试会话因用户操作被断开
- **THEN** 界面展示可读原因与重试引导

## MODIFIED Requirements

### Requirement: 基础架构 SHALL 定义共享状态与反馈约定
项目 SHALL 定义加载中状态、成功反馈和错误反馈的共享约定，以便页面操作在当前与未来的 UI 模块中都能保持一致的表现方式。对于多步骤自动化任务，该约定 SHALL 额外覆盖当前步骤展示与失败步骤定位。

#### Scenario: 展示进行中的页面操作
- **WHEN** 页面操作正在执行中
- **THEN** 界面展示标准化的忙碌状态，而不是让用户处于没有状态反馈的情况

#### Scenario: 展示操作失败
- **WHEN** 页面操作失败或当前不可用
- **THEN** 界面展示一个标准化的错误状态，并且用户无需查看开发者工具即可理解该状态

#### Scenario: 展示多步骤任务的当前步骤
- **WHEN** 多步骤自动化任务正在执行
- **THEN** 界面展示当前步骤名称与已完成步骤数

#### Scenario: 定位失败发生的步骤
- **WHEN** 多步骤任务在某一步失败
- **THEN** 界面指明失败发生在哪一步及该步的观测结果
