## ADDED Requirements

### Requirement: 系统 SHALL 通过常驻 content script 承担 DOM 读取与定位
系统 SHALL 声明匹配目标站点的 content script，由它负责 DOM 读取、元素定位、坐标计算与结果验证。content script MUST NOT 执行任何页面写操作。

#### Scenario: content script 在目标站点加载
- **WHEN** 用户打开匹配 host 规则的目标站点页面
- **THEN** content script 自动注入并可响应来自 Service Worker 的定位与验证请求

#### Scenario: content script 未就绪
- **WHEN** Service Worker 向尚未注入 content script 的标签页发送定位请求
- **THEN** 系统按需注入后重试一次，仍失败则返回结构化失败结果

### Requirement: 元素定位 SHALL 用户配置选择器优先、站点 fallback 兜底
系统 SHALL 先使用用户在设置中配置的选择器列表定位元素；当全部用户选择器均未命中时，系统 SHALL 回退到内置的站点 fallback 选择器列表。系统 MUST NOT 移除站点 fallback 兜底能力。

#### Scenario: 用户选择器命中
- **WHEN** 用户配置的选择器在页面中匹配到元素
- **THEN** 系统使用该元素，并在结果中标记命中来源为用户配置

#### Scenario: 回退到站点 fallback
- **WHEN** 用户配置的所有选择器均未匹配到元素
- **THEN** 系统依次尝试内置 fallback 选择器，并在结果中标记命中来源为站点 fallback

#### Scenario: 全部选择器均未命中
- **WHEN** 用户选择器与站点 fallback 选择器都未匹配到元素
- **THEN** 系统返回失败结果，其中列出已尝试的选择器，便于用户调整配置

### Requirement: 定位结果 SHALL 包含可点击性判定与视口内坐标
系统 SHALL 在返回定位结果时提供元素中心点坐标、元素矩形、是否在视口内、是否可见以及是否被遮挡的判定。坐标 SHALL 由 `getBoundingClientRect()` 计算得出，且以相对主页面 viewport 的 CSS 像素表达。

#### Scenario: 返回可点击元素的中心坐标
- **WHEN** 定位到一个可见且未被遮挡的元素
- **THEN** 系统返回该元素矩形中心点的 CSS 像素坐标

#### Scenario: 元素不在视口内
- **WHEN** 定位到的元素当前不在视口范围内
- **THEN** 系统先将该元素滚动进视口，重新计算坐标后再返回

#### Scenario: 元素被其他元素遮挡
- **WHEN** 元素中心点处的命中测试返回的不是目标元素或其子元素
- **THEN** 系统返回被遮挡标记与遮挡元素信息，调用方据此中止点击

### Requirement: 每一步动作前 SHALL 重新定位并重新计算坐标
系统 SHALL 在每次执行 CDP 动作之前重新定位目标元素并重新计算坐标。系统 MUST NOT 一次性缓存多个元素坐标后连续执行点击，因为弹窗、滚动、虚拟列表与页面重渲染都会使已缓存坐标失效。

#### Scenario: 连续两步动作各自重新定位
- **WHEN** 一个任务需要先点击按钮再点击弹窗内的输入框
- **THEN** 系统在第二步之前重新执行定位与坐标计算，而不是复用第一步之前的坐标快照

#### Scenario: 重新定位发现元素已消失
- **WHEN** 执行下一步动作前重新定位失败
- **THEN** 系统中止该步骤并返回结构化失败结果，而不使用旧坐标继续点击

### Requirement: 系统 SHALL 在每个动作后执行多维度结果验证
系统 SHALL 在每个动作之后执行验证，且 MUST NOT 仅以「CDP 命令未报错」作为成功判据。验证维度 SHALL 至少覆盖：目标弹窗是否出现、相关 DOM 状态或文案是否变化、输入框内容是否已更新、目标提交按钮是否变为可用、以及相关网络请求是否发出并成功返回。

#### Scenario: 点击后弹窗出现
- **WHEN** 系统点击「打招呼」按钮后进入验证阶段
- **THEN** 系统在等待窗口内检测约定的弹窗选择器是否出现，出现即判定该维度通过

#### Scenario: 输入后内容已更新
- **WHEN** 系统通过 `Input.insertText` 写入文本后进入验证阶段
- **THEN** 系统读取输入框的当前值并与期望文本比对，一致即判定该维度通过

#### Scenario: 提交按钮变为可用
- **WHEN** 输入完成后系统验证提交按钮状态
- **THEN** 系统检测该按钮的 disabled 属性与禁用类名，可用即判定该维度通过

#### Scenario: 命令成功但页面无变化
- **WHEN** CDP 命令返回成功，但所有验证维度在等待窗口内均未观测到预期变化
- **THEN** 系统将该步骤判定为失败，并返回各维度的实际观测值

### Requirement: 验证等待 SHALL 采用轮询与超时而非固定延时
系统 SHALL 通过轮询或 DOM 变化观测配合超时上限来等待页面更新。系统 MUST NOT 依赖固定长度的 `setTimeout` 作为唯一的等待手段。

#### Scenario: 条件提前满足即结束等待
- **WHEN** 验证条件在超时上限之前被满足
- **THEN** 系统立即结束等待并继续下一步，不再消耗剩余等待时间

#### Scenario: 达到超时上限
- **WHEN** 验证条件在超时上限内始终未被满足
- **THEN** 系统结束等待并返回超时失败结果，其中包含已观测到的中间状态

### Requirement: 跨 frame 读取 SHALL 保持聚合取最优
系统在读取页面信息时 SHALL 在所有 frame 中执行并聚合结果，再按评分选出最优结果。系统 MUST NOT 退化为只读取主 frame 的结果。

#### Scenario: 目标内容位于子 frame
- **WHEN** 候选内容实际渲染在子 frame 中
- **THEN** 系统聚合各 frame 的读取结果并选中包含有效内容的那一份

#### Scenario: 多个 frame 均有结果
- **WHEN** 多个 frame 都返回了非空结果
- **THEN** 系统按既有评分规则选出最优结果，并记录被选中的 frame 标识
