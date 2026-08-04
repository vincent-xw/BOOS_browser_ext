## MODIFIED Requirements

### Requirement: 系统 SHALL 提供基础设置与高级设置分区
系统 SHALL 提供设置界面，并将配置项分为「基础设置」和「高级设置」两个分区；基础设置至少包含目标域名与页面元素选择器配置，高级设置至少包含 BFF 地址与 BFF 接入 token 配置。

设置界面 MUST NOT 包含 LLM Endpoint、模型名称或 LLM API Key 任何一项。BFF 接入 token 不是 LLM API Key。

#### Scenario: 打开设置界面查看分区
- **WHEN** 用户从主界面点击设置入口
- **THEN** 系统展示包含「基础设置」和「高级设置」的设置界面

#### Scenario: 编辑基础设置目标域名
- **WHEN** 用户修改并保存目标域名配置
- **THEN** 系统更新目标域名值并在后续站点检测中生效

#### Scenario: 编辑高级设置 BFF 配置
- **WHEN** 用户输入并保存 BFF 地址与接入 token
- **THEN** 系统更新 BFF 调用配置并在后续 agent 请求中使用

#### Scenario: 界面不存在模型配置项
- **WHEN** 用户浏览设置界面的全部分区
- **THEN** 界面中不存在 LLM Endpoint、模型名称或 API Key 任何一项

### Requirement: 系统 SHALL 将设置持久化到 localStorage
系统 SHALL 将设置项持久化到 `localStorage`，并在插件界面初始化时恢复；当配置缺失时 MUST 使用默认值。系统 MUST NOT 持久化 LLM API Key。

#### Scenario: 保存后刷新仍可恢复
- **WHEN** 用户保存设置并重新打开插件界面
- **THEN** 系统从 `localStorage` 恢复已保存配置

#### Scenario: 首次使用采用默认配置
- **WHEN** 用户首次打开插件且 `localStorage` 中无设置数据
- **THEN** 系统自动使用默认配置（包括默认目标域名 `www.zhipin.com`）

#### Scenario: 存储中不含模型密钥
- **WHEN** 检查扩展持久化存储的设置内容
- **THEN** 其中不存在 LLM API Key 字段

### Requirement: 系统 SHALL 提供可验证的配置状态反馈
系统 SHALL 在设置保存成功或失败时提供明确反馈，以便用户确认配置是否可用。系统 SHALL 提供一个针对 BFF 配置的连通性检查，用于在真正运行任务前确认地址与接入 token 有效。

#### Scenario: 保存成功反馈
- **WHEN** 用户提交合法设置数据
- **THEN** 系统展示保存成功反馈

#### Scenario: 保存失败反馈
- **WHEN** 用户提交非法设置数据或写入失败
- **THEN** 系统展示可读错误信息并保持原有有效配置

#### Scenario: BFF 连通性检查通过
- **WHEN** 用户对已填写的 BFF 配置触发连通性检查且配置有效
- **THEN** 系统展示检查通过反馈

#### Scenario: BFF 连通性检查失败
- **WHEN** BFF 地址不可达或接入 token 无效
- **THEN** 系统展示可读的失败原因，区分「地址不可达」与「凭据无效」

## ADDED Requirements

### Requirement: 系统 SHALL 迁移并清除历史模型配置
系统 SHALL 在读取旧版本设置时移除已废弃的 LLM Endpoint、模型名称与 API Key 字段，并将清理后的结果写回持久化存储。已存的 API Key MUST 被删除而 MUST NOT 保留在存储中。

#### Scenario: 升级后旧密钥被清除
- **WHEN** 用户从存有 API Key 的旧版本升级并打开插件
- **THEN** 系统移除该字段并写回清理后的配置，存储中不再包含 API Key

#### Scenario: 迁移不影响仍有效的配置
- **WHEN** 旧配置中同时存在目标域名与选择器等仍有效的字段
- **THEN** 这些字段在迁移后被保留
