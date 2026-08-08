## Why

自由指令模式通了，但新用户面对一个空白输入框时不知道自己能下什么指令、指令能触发到什么操作边界。同时工具校验失败时用户看到的是 `TOOL_NOT_ALLOWED` 这类机器码，无从理解。另外，用户聊出一个满意的结果后无法保存复用 -- 下次想再跑一遍同样的事得重新描述。

两个功能解决这两件事：让用户知道能力边界，让用户能收藏好用的会话。

## What Changes

### 一、工具能力说明（? 图标 + 首次引导 + 错误提示优化）

- 在「自由指令」标题旁加一个 `?` 图标，点击弹出工具能力说明面板。
- 首次使用时自动弹出一次（用 `chrome.storage.local` 标记已看过），后续仅点击触发。
- 面板用清晰中文列出 9 个工具各自能做什么、模型会怎么调用它们，让用户知道自己的提示词能触发到什么操作边界。
- 工具校验失败的错误提示从机器码改为用户可读的中文：
  - `TOOL_NOT_ALLOWED` -> 「当前不支持这类操作」
  - `TOOL_INPUT_INVALID` -> 「指令参数不合法」并附具体原因
  - `TOOL_EXECUTION_FAILED` -> 「操作执行失败」并附原因
- 这些错误在对话记录和步骤摘要中统一用可读文本展示，不暴露错误码。

### 二、会话保存为技能（skill）

- 在对话区域加「保存为技能」按钮，用户对当前会话满意时点击保存。
- 技能保存：名称（默认取首条指令摘要）、首条用户指令、对话轮次（供后续参考）。
- 技能管理界面：列表查看、重命名、删除。
- 一键应用：从某技能开新会话，把首条指令预填到输入框。用户可直接执行或修改后再执行。
  - 不自动执行 -- 避免在错误的页面上跑出非预期动作。
  - 不重放历史工具调用 -- 那会真实操作页面。只预填指令，让用户决定何时执行。
- 技能存 `chrome.storage.local`，与会话列表同层。

## Capabilities

### New Capabilities
- `tools-help`: 工具能力说明面板与首次引导。
- `skill-management`: 会话保存为技能、技能列表管理、一键应用。

### Modified Capabilities
- `free-form-instruction`: 对话记录与步骤摘要中的错误展示改为可读文本；新增「保存为技能」入口。

## Impact

**扩展侧改动**
- `src/components/FreeFormPanel.vue` - 加 `?` 图标与说明面板；加「保存为技能」按钮；步骤摘要的错误展示优化。
- `src/services/toolsCatalog.ts`（新）- 9 个工具的中文说明，供面板展示。
- `src/services/skillStore.ts`（新）- 技能的存储、列表、删除、重命名。
- `src/components/SkillPanel.vue`（新）- 技能管理界面。
- `src/composables/useFreeFormController.ts` - 接入技能保存与应用；错误文本映射。
- `src/composables/useSkillController.ts`（新）- 技能列表状态与管理操作。
- `entrypoints/sidepanel/App.vue` - 加技能管理入口。

**不动的部分**
- BFF、agent-kit、CDP 会话管理、白名单、审批门 -- 这次纯扩展侧 UI 与本地存储。
