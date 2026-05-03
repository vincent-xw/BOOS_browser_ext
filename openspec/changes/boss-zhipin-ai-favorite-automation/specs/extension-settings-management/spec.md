## ADDED Requirements

### Requirement: 系统 SHALL 提供基础设置与高级设置分区
系统 SHALL 提供设置界面，并将配置项分为“基础设置”和“高级设置”两个分区；基础设置至少包含目标域名配置，高级设置至少包含大模型 API Key 相关配置。

#### Scenario: 打开设置界面查看分区
- **WHEN** 用户从主界面点击设置入口
- **THEN** 系统展示包含“基础设置”和“高级设置”的设置界面

#### Scenario: 编辑基础设置目标域名
- **WHEN** 用户修改并保存目标域名配置
- **THEN** 系统更新目标域名值并在后续站点检测中生效

#### Scenario: 编辑高级设置 API Key
- **WHEN** 用户输入并保存 API Key
- **THEN** 系统更新 API 调用配置并在后续 LLM 请求中使用

### Requirement: 系统 SHALL 将设置持久化到 localStorage
系统 SHALL 将设置项持久化到 `localStorage`，并在插件界面初始化时恢复；当配置缺失时 MUST 使用默认值。

#### Scenario: 保存后刷新仍可恢复
- **WHEN** 用户保存设置并重新打开插件界面
- **THEN** 系统从 `localStorage` 恢复已保存配置

#### Scenario: 首次使用采用默认配置
- **WHEN** 用户首次打开插件且 `localStorage` 中无设置数据
- **THEN** 系统自动使用默认配置（包括默认目标域名 `www.zhipin.com`）

### Requirement: 系统 SHALL 提供可验证的配置状态反馈
系统 SHALL 在设置保存成功或失败时提供明确反馈，以便用户确认配置是否可用。

#### Scenario: 保存成功反馈
- **WHEN** 用户提交合法设置数据
- **THEN** 系统展示保存成功反馈

#### Scenario: 保存失败反馈
- **WHEN** 用户提交非法设置数据或写入失败
- **THEN** 系统展示可读错误信息并保持原有有效配置
