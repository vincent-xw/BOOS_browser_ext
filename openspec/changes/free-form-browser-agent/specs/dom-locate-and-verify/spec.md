## MODIFIED Requirements

### Requirement: 元素定位 SHALL 用户配置选择器优先、站点 fallback 兜底
系统 SHALL 支持三条定位路径，优先级从高到低为：元素引用（ref）、显式 CSS 选择器、
预设语义角色。三者 SHALL 至少给出一个，全都缺失时 MUST 返回结构化失败。

走预设角色路径时，系统 SHALL 先使用用户在设置中配置的选择器列表；当全部用户选择器均未命中时，
系统 SHALL 回退到内置的站点 fallback 选择器列表。系统 MUST NOT 移除站点 fallback 兜底能力。

角色 MUST NOT 是必填项 —— 自由指令场景下的目标元素不属于任何预设角色。

#### Scenario: 按 ref 定位
- **WHEN** 定位请求给出快照中的 ref
- **THEN** 系统按 ref 解析出当前坐标并返回

#### Scenario: 只给显式选择器即可定位
- **WHEN** 定位请求只给出 CSS 选择器，未给出角色
- **THEN** 系统按该选择器定位，不要求补充角色

#### Scenario: 用户选择器命中
- **WHEN** 走角色路径且用户配置的选择器在页面中匹配到元素
- **THEN** 系统使用该元素，并在结果中标记命中来源为用户配置

#### Scenario: 回退到站点 fallback
- **WHEN** 走角色路径且用户配置的所有选择器均未匹配到元素
- **THEN** 系统依次尝试内置 fallback 选择器，并在结果中标记命中来源为站点 fallback

#### Scenario: 全部选择器均未命中
- **WHEN** 用户选择器与站点 fallback 选择器都未匹配到元素
- **THEN** 系统返回失败结果，其中列出已尝试的选择器，便于用户调整配置

#### Scenario: 三条路径都未给出
- **WHEN** 定位请求既无 ref，也无选择器与角色
- **THEN** 系统返回失败结果，说明缺少定位依据

### Requirement: 跨 frame 读取 SHALL 保持聚合取最优
系统在读取页面信息与定位元素时 SHALL 在所有 frame 中执行并聚合结果，再按评分选出最优结果。
系统 MUST NOT 退化为只读取主 frame 的结果。

元素快照是例外：快照 SHALL **合并**所有 frame 的元素列表而非取最优，因为调用方需要看到
整页的可交互元素，而目标元素可能位于任意子 frame。

#### Scenario: 目标内容位于子 frame
- **WHEN** 候选内容实际渲染在子 frame 中
- **THEN** 系统聚合各 frame 的读取结果并选中包含有效内容的那一份

#### Scenario: 多个 frame 均有结果
- **WHEN** 多个 frame 都返回了非空结果
- **THEN** 系统按既有评分规则选出最优结果，并记录被选中的 frame 标识

#### Scenario: 快照合并而非取最优
- **WHEN** 可交互元素分布在多个 frame 中
- **THEN** 快照结果包含所有 frame 的元素，而不是只保留评分最高的那个 frame
