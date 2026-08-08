## ADDED Requirements

### Requirement: 系统 SHALL 提供可交互元素快照
系统 SHALL 提供快照能力，列出当前视口内的可交互元素，每个元素带一个引用编号（ref）、
标签、可读名称、元素类型与中心坐标。快照 SHALL 覆盖原生控件（链接、按钮、输入框、
选择框、可编辑区域）与带交互语义的 ARIA 角色元素。

#### Scenario: 快照返回带 ref 的元素列表
- **WHEN** 调用方请求当前页面快照
- **THEN** 系统返回元素列表，每项含 ref、标签名、可读名称、元素类型与中心坐标

#### Scenario: 只包含视口内可见元素
- **WHEN** 页面存在视口外或不可见的可交互元素
- **THEN** 这些元素不出现在快照中

#### Scenario: 快照包含遮挡与禁用状态
- **WHEN** 某可交互元素被其他元素遮挡或处于禁用态
- **THEN** 该元素在快照中带有对应标记，调用方据此避免直接点击

#### Scenario: 输入类元素带上当前值
- **WHEN** 快照包含输入框或文本域
- **THEN** 该项带上其当前值，便于判断是否需要先清空

### Requirement: 快照数量超限时 SHALL 显式告知被省略的数量
系统 SHALL 对单次快照的元素数量设上限。当实际可交互元素超出上限时，系统 MUST 在结果中
给出被省略的数量。系统 MUST NOT 静默截断。

#### Scenario: 元素数量超出上限
- **WHEN** 页面可交互元素数量超过快照上限
- **THEN** 系统返回上限内的元素，并给出被省略的元素数量

#### Scenario: 元素数量未超限
- **WHEN** 页面可交互元素数量未超过上限
- **THEN** 结果中不含被省略数量字段

### Requirement: 系统 SHALL 支持按 ref 解析元素当前坐标
系统 SHALL 维护 ref 到元素的引用关系，并支持按 ref 取该元素的**当前**坐标。
坐标 SHALL 在每次解析时重新计算，MUST NOT 返回快照时缓存的坐标。

#### Scenario: 按 ref 取到当前坐标
- **WHEN** 调用方以快照中的 ref 请求解析
- **THEN** 系统返回该元素此刻的中心坐标与矩形

#### Scenario: 元素位置在快照后发生变化
- **WHEN** 快照之后页面发生滚动或重排，随后按同一 ref 解析
- **THEN** 系统返回变化后的新坐标，而不是快照时的旧坐标

#### Scenario: 元素不在视口内时先滚入再取坐标
- **WHEN** 按 ref 解析的元素当前不在视口内
- **THEN** 系统先将其滚入视口，重新计算坐标后返回

#### Scenario: 解析时报告遮挡
- **WHEN** 按 ref 解析的元素中心点被其他元素遮挡
- **THEN** 系统返回遮挡标记与遮挡元素描述

### Requirement: 失效的 ref SHALL 返回明确的失效标记
当 ref 指向的元素已从 DOM 移除或已被回收时，系统 MUST 返回失效（stale）标记，
以便调用方重新快照而不是以旧 ref 重试。

#### Scenario: 元素已从 DOM 移除
- **WHEN** 按 ref 解析，但该元素已不在文档中
- **THEN** 系统返回失效标记与「请重新快照」的可读说明

#### Scenario: 元素已被垃圾回收
- **WHEN** 按 ref 解析，但该元素引用已失效
- **THEN** 系统返回失效标记

#### Scenario: 元素仍在文档中但不可见
- **WHEN** 按 ref 解析，元素仍在文档中但当前不可见
- **THEN** 系统返回未找到而非失效标记，说明该元素当前不可见

### Requirement: 页面导航后 SHALL 清空 ref 注册表
系统 MUST 在页面导航（含单页应用的历史跳转）后清空 ref 注册表，避免旧 ref 命中新页面的元素。

#### Scenario: 历史跳转后旧 ref 失效
- **WHEN** 页面发生前进/后退跳转，随后以跳转前的 ref 解析
- **THEN** 系统返回失效标记

#### Scenario: 页面卸载时清空注册表
- **WHEN** 页面即将卸载
- **THEN** 系统清空 ref 注册表

### Requirement: 快照 SHALL 合并所有 frame 的结果
快照 SHALL 在所有 frame 中执行并合并元素列表，因为目标元素可能位于任意子 frame。
快照 MUST NOT 只返回主 frame 的元素，也 MUST NOT 在多 frame 间只取评分最优的一个。

#### Scenario: 目标元素位于子 frame
- **WHEN** 可交互元素分布在主 frame 与子 frame 中
- **THEN** 快照结果同时包含两者的元素

#### Scenario: ref 解析取命中该 ref 的 frame
- **WHEN** 按 ref 解析，而该 ref 只在某一个 frame 中登记过
- **THEN** 系统返回该 frame 的解析结果
