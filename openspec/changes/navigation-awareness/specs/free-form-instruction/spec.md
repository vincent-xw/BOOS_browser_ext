## MODIFIED Requirements

### Requirement: 系统 SHALL 在写操作后检测页面导航
系统 SHALL 在执行 click、input_text、press_key 后读取标签页当前 URL，与操作前比较。若发生跨域名或同域路径跳转，SHALL 在工具返回值中追加 `navigation` 字段，明确告知模型导航到了哪里以及下一步建议。

#### Scenario: 点击导致跨域名导航
- **WHEN** 模型点击一个元素后，标签页的 host 发生变化（例如从 example.com 跳到 github.com）
- **THEN** 工具返回值包含 `navigation.changedDomain = true`、`from` 与 `to`，以及一段中文提示说明已离开原页面、若非预期跳转应调用 browser_go_back 返回

#### Scenario: 点击导致同域路径跳转
- **WHEN** 点击后 host 不变但 pathname 变化
- **THEN 工具返回值包含 `navigation`，标注页面已跳转且旧 ref 全部失效，建议重新快照

#### Scenario: 未发生导航
- **WHEN** 点击后 URL 未变化
- **THEN** 工具返回值不包含 `navigation` 字段，保持原有返回结构

### Requirement: 系统 SHALL 提供 browser_go_back 工具
系统 SHALL 新增 browser_go_back 工具，调用浏览器原生返回上一页。go_back 后 SHALL 同样检测 URL 变化并返回结果，让模型确认是否回到了预期页面。

#### Scenario: 模型调用 go_back 返回
- **WHEN** 模型发现导航到了非预期页面，调用 browser_go_back
- **THEN** 系统执行浏览器返回，并返回返回后的 URL 与是否成功

#### Scenario: go_back 需要审批
- **WHEN** go_back 被调用
- **THEN** 作为写操作走正常的审批流程（它改变浏览历史）

### Requirement: 系统提示词 SHALL 指导模型处理导航偏离
系统提示词 SHALL 明确写入：写操作（尤其点击链接）可能导致导航；返回值的 `navigation` 字段说明去了哪里；如果导航不是任务预期的（例如下载链接跳到外部站点），应先调用 browser_go_back 回到原页面，不要在错误的页面上继续操作；在未授权域名上写操作会被拒绝。

#### Scenario: 模型收到跨域导航提示
- **WHEN** 工具返回 `navigation.changedDomain = true` 且提示非预期跳转
- **THEN** 模型应优先调用 browser_go_back，而不是在新页面上继续操作

#### Scenario: 模型在未授权域名上
- **WHEN** 模型发现当前域名未授权、写操作被拒绝
- **THEN** 模型应调用 browser_go_back 回到已授权的原页面继续任务，而非停止
