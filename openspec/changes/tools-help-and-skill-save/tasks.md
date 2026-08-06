## 1. 工具能力说明面板

- [x] 1.1 新增 `src/services/toolsCatalog.ts`：9 个工具的中文名称与用途说明，供面板展示。注释标注与 BFF 侧 `browser-tools.ts` 需保持同步。
- [x] 1.2 在 `FreeFormPanel.vue` 的「自由指令」标题旁加 `?` 图标，点击切换说明面板的显示。
- [x] 1.3 说明面板用 `el-collapse` 或列表列出全部 9 个工具，每项含名称与中文说明。
- [x] 1.4 首次引导：用 `chrome.storage.local` 存 `boos.onboarding.toolsHelpSeen` 布尔值；首次打开 sidepanel 时未看过则自动弹出，关闭后标记为已看。
- [x] 1.5 再次点击 `?` 图标关闭面板；面板打开时不阻塞指令输入与执行。

## 2. 错误提示优化

- [x] 2.1 在 `useFreeFormController.ts` 中新增错误码到可读文本的映射函数：`TOOL_NOT_ALLOWED` ->「当前不支持这类操作」、`TOOL_INPUT_INVALID` ->「指令参数不合法」、`TOOL_EXECUTION_FAILED` ->「操作执行失败」。
- [x] 2.2 映射时保留原始 `message` 作为原因附在可读文本后。
- [x] 2.3 `appendTurn` 写入错误轮次时使用映射后的文本，不暴露错误码。
- [x] 2.4 `FreeFormPanel.vue` 的 `stepSummary` 展示错误步骤时用映射文本而非 `{ ok: false, code: ... }` 结构。
- [x] 2.5 测试：映射函数各错误码的输出文本正确、未知错误码有兜底文本。

## 3. 技能存储

- [x] 3.1 新增 `src/services/skillStore.ts`：技能的 CRUD 接口（save / load / rename / delete / getById）。
- [x] 3.2 技能记录结构：`{ id, name, firstInstruction, finalReplySummary, createdAt }`。
- [x] 3.3 存 `chrome.storage.local`，键 `boos.skills`；上限 50 条，超出拒绝新增。
- [x] 3.4 `save` 从 `ConversationTurn[]` 提取首条用户指令与 agent 最终回复摘要。
- [x] 3.5 `name` 默认取首条指令前 30 字，用户可重命名。
- [x] 3.6 测试：保存与读取、重命名、删除、上限拒绝、空会话不保存。

## 4. 技能管理界面

- [x] 4.1 新增 `src/components/SkillPanel.vue`：技能列表（卡片式），每张卡片含名称、摘要、应用与删除按钮。
- [x] 4.2 卡片支持内联重命名（点击名称编辑）。
- [x] 4.3 空状态提示。
- [x] 4.4 新增 `src/composables/useSkillController.ts`：技能列表 ref、刷新、重命名、删除、应用。
- [x] 4.5 在 `App.vue` 头部加技能管理入口（图标按钮），点击打开 `SkillPanel`（el-drawer 或 el-dialog）。
- [x] 4.6 打开时自动刷新列表。

## 5. 保存为技能与一键应用

- [x] 5.1 在 `FreeFormPanel.vue` 对话区域加「保存为技能」按钮，`turns.length === 0` 时禁用。
- [x] 5.2 点击保存时调用 `skillStore.save`，传入当前 `turns`；保存成功后 `ElMessage` 提示。
- [x] 5.3 在 `useFreeFormController.ts` 新增 `applySkill(skill)`：开新会话 -> 把 `firstInstruction` 预填到 `instruction` -> 不自动执行。
- [x] 5.4 `SkillPanel.vue` 的「应用」按钮调用 `applySkill` 后关闭面板。
- [x] 5.5 应用后聚焦指令输入框，让用户直接修改或执行。

## 6. 收尾验证

- [x] 6.1 `pnpm run typecheck` 通过。
- [x] 6.2 `pnpm vitest run` 全绿。
- [x] 6.3 `pnpm run build` 通过。
- [ ] 6.4 手动验证：首次打开自动弹出工具说明 -> 关闭后不再弹 -> 点击 `?` 可再打开。
- [ ] 6.5 手动验证：执行一轮指令 -> 保存为技能 -> 打开技能管理 -> 应用技能 -> 新会话预填指令。
- [ ] 6.6 手动验证：工具失败时步骤摘要展示可读中文而非错误码。
