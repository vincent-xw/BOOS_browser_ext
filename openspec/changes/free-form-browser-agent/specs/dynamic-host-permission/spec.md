## ADDED Requirements

### Requirement: host 权限 SHALL 在运行时按域名申请
扩展清单 SHALL 以可选权限方式声明广域 host 访问，安装时 MUST NOT 索取「读取所有网站数据」。
用户在设置中添加域名时，系统 SHALL 发起该域名的权限申请。

#### Scenario: 安装时不索取广域权限
- **WHEN** 用户安装扩展
- **THEN** 浏览器不提示「读取和更改你在所有网站上的数据」

#### Scenario: 添加域名时申请权限
- **WHEN** 用户在设置中添加一个域名并确认
- **THEN** 浏览器弹出该域名的权限申请

#### Scenario: 用户拒绝授权时不加入白名单
- **WHEN** 用户在权限申请中选择拒绝
- **THEN** 该域名不被加入白名单，并提示未获得访问权限

### Requirement: content script SHALL 按已授权域名动态注册
系统 SHALL 依据白名单与已获授权的域名动态注册 content script，使目标页面打开即具备
读取与定位能力。系统 MUST NOT 依赖写死的静态匹配规则来支持新域名。

#### Scenario: 新增域名后脚本自动生效
- **WHEN** 用户添加并授权某域名，随后打开该域名页面
- **THEN** content script 自动注入，无需手动操作

#### Scenario: 只对已授权域名注册
- **WHEN** 白名单中某域名尚未获得 host 权限
- **THEN** 该域名不参与动态注册，避免整次注册失败

#### Scenario: 移除域名后同步注册范围
- **WHEN** 用户移除某条白名单规则
- **THEN** 系统重新同步 content script 的注册范围

#### Scenario: 脚本未就绪时按需注入兜底
- **WHEN** 目标页面尚无 content script 且收到定位请求
- **THEN** 系统按需注入并重试一次，仍失败则返回结构化失败结果

### Requirement: 系统 SHALL 提供白名单的管理界面
系统 SHALL 在设置中提供白名单的查看、添加与移除。添加时 SHALL 支持从当前标签页快速填入域名。
非法规则 MUST 被拒绝并给出原因。

#### Scenario: 查看现有规则
- **WHEN** 用户打开设置界面
- **THEN** 界面展示已配置的域名与其路径限制

#### Scenario: 白名单为空时的提示
- **WHEN** 白名单尚未配置任何规则
- **THEN** 界面明确提示写操作会全部被拒绝

#### Scenario: 用当前站点快速填入
- **WHEN** 用户点击「用当前站点」
- **THEN** 域名输入框填入当前标签页的域名

#### Scenario: 拒绝非法规则
- **WHEN** 用户提交空域名、含空格的域名、不以 / 开头的路径前缀或非法路径正则
- **THEN** 系统拒绝添加并说明具体原因

#### Scenario: 拒绝重复规则
- **WHEN** 用户添加一条与既有规则完全等价的规则
- **THEN** 系统拒绝添加并提示该规则已存在
