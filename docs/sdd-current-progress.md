# BOOS Browser Extension — SDD（当前进度版）

> 文档目的：在上下文窗口受限时，提供可持续迭代的“系统设计与当前进度快照”，用于新会话快速续接。
>
> 更新时间：2026-05-03
>
> 技术栈：WXT + Vue 3 + Element Plus + Chrome MV3

---

## 1. 系统目标与范围

本项目当前目标：在 BOSS 直聘页面实现“页面候选人读取 ->（可选）LLM评估 -> 自动收藏”的半自动流程，并提供可观测、可配置、可回退的扩展侧边栏操作界面。

当前已覆盖范围：
- Sidepanel 交互入口（替代传统 popup）
- 页面候选人数据读取（含 iframe 场景）
- 基础配置与高级配置持久化
- 任务执行进度与结果展示
- 诊断能力（用于排查权限/注入/选择器问题）

不在当前范围（后续迭代）：
- 全量滚动采集（虚拟列表）
- 批量/并发调度策略优化
- 多站点适配框架（当前偏 BOSS 专用）
- 数据持久层升级（目前主要 localStorage）

---

## 2. 当前架构（逻辑分层）

### 2.1 UI 层（Sidepanel）
- 文件：`entrypoints/sidepanel/App.vue`
- 职责：
  - 展示运行状态、页面概览、候选人数据表、处理结果表
  - 承载刷新按钮、设置抽屉、诊断弹窗
  - 触发控制器方法，不直接访问 `chrome.*`

### 2.2 业务编排层（Composable）
- 文件：`src/composables/usePageIoController.ts`
- 职责：
  - 汇总状态：`runState`、`candidateOverview`、`pageCandidates`、`progress`
  - 管理刷新逻辑：`refreshCandidateOverview`
  - 执行流程：`handleRunWorkflow`
  - 处理错误边界、UI友好状态文本

### 2.3 页面 I/O 适配层（Service）
- 文件：`src/services/chromeMcpService.ts`
- 职责：
  - 优先走 `window.chromeMcp`，不可用时回退 `chrome.tabs + chrome.scripting`
  - 封装页面读取：候选人列表、详情点击、简历读取、收藏点击
  - 处理 iframe：`target: { tabId, allFrames: true }`
  - 多 frame 结果选优聚合

### 2.4 配置层
- 文件：`src/types/settings.ts`、`src/services/settingsService.ts`
- 职责：
  - 配置模型定义与默认值
  - 读取/保存 localStorage
  - 输入校验与选择器标准化（裸值自动补 `. / #`）

### 2.5 诊断层
- 文件：`src/services/diagnosticService.ts`
- 职责：
  - 独立验证“活动标签页查询 / 脚本注入 / 候选人读取 / frame 命中”
  - 输出可读诊断报告，辅助定位环境与选择器问题

---

## 3. 关键设计决策（已落地）

1. **入口从 popup 转为 sidepanel**
   - 减少操作阻塞，提升执行流程可视化空间

2. **能力双通路：MCP 优先，scripting 回退**
   - 避免单点依赖，增强实际可用性

3. **iframe 读取策略**
   - 使用 `allFrames: true`
   - 对返回结果做聚合与选优，而不是只取第一帧

4. **BOSS 选择器回退策略（内建）**
   - 用户配置优先 + BOSS 内建 fallback（如 `li.card-item` / `.name`）
   - 缓解历史配置或不稳定选择器导致的读取失败

5. **状态可观测化**
   - 运行状态与候选人结果中文标签化
   - 页面概览与执行记录分区展示

---

## 4. 当前能力矩阵（功能进度）

### 4.1 已完成（可用）
- [x] Sidepanel 入口与基础交互
- [x] 当前站点检测（自动触发 + 状态灯）
- [x] 页面候选人读取（支持 iframe）
- [x] 刷新页面数据（手动触发）
- [x] 页面候选人数据表渲染（`pageCandidates`）
- [x] 执行流程（候选人处理 + 结果记录）
- [x] 诊断弹窗（frame 命中、数量、可读性）
- [x] 设置保存与选择器自动标准化

### 4.2 部分完成（需增强）
- [~] 候选人“完整列表”读取
  - 当前可稳定读取页面中已命中的列表项
  - 若目标页面使用虚拟列表/懒渲染，仍可能只拿到可视区部分

- [~] 简历读取稳定性
  - 结构化 DOM 可读时表现稳定
   - Canvas-only 页面已支持截图提取并进入多模态评估链路（若模型/接口支持）
   - Canvas 若被跨域污染（tainted）仍可能无法导出，需要诊断/降级策略

### 4.3 待办（下一阶段）
- [ ] 虚拟列表全量采集（滚动加载 + 去重合并）
- [ ] 详情/简历读取重试与等待策略（ready-state 检测）
- [ ] 选择器配置可视化验证（输入值 vs 实际生效值）
- [ ] 执行策略可配置（节流、重试、失败跳过策略）
- [ ] 流程审计日志（便于回放与问题定位）

---

## 5. 关键数据模型（现状）

- `OperationState`: `idle | running | succeeded | failed`
- `CandidateSummary`: 候选人列表浅信息（`id/index/name/previewText`）
- `PageCandidateOverview`: 页面级概览（总数、变化状态、预览、时间）
- `WorkflowProgress`: 执行进度（总量、已处理、成功/失败、当前处理、记录）

建议后续补充：
- `PageSnapshotMeta`（frame 来源、采集轮次、采样窗口）
- `AcquisitionMode`（visible-only / full-scroll）

---

## 6. 关键流程（时序说明）

### 6.1 页面刷新流程（当前）
1. UI 触发 `refreshCandidateOverview`
2. 控制器检查站点匹配
3. 调用 `readCandidateList`
4. Service 在 allFrames 下执行，按选优策略聚合
5. 更新：`pageCandidates` + `candidateOverview`
6. UI 重绘候选人数据表与概览

### 6.2 自动处理流程（当前）
1. 校验站点与必要配置
2. 读取候选人列表（同上）
3. 逐个：打开详情 -> 读取简历 -> LLM 判定 -> 收藏点击
4. 写入 `progress.records`
5. 完成后刷新页面概览

---

## 7. 可扩展性设计要点（后续必须遵守）

1. **UI 不直接访问 `chrome.*`**
   - 所有页面能力必须经 `chromeMcpService`

2. **新能力通过 Service 扩展，不在 App.vue 写脚本注入**
   - 保持可测试性与可替换性

3. **跨 frame 读取统一走“聚合选优”策略**
   - 禁止回退成“只取第一帧”

4. **用户配置优先 + 站点内建回退并存**
   - 避免“配置稍偏即全失效”

5. **状态分层**
   - 页面数据状态（overview/pageCandidates）
   - 执行过程状态（progress/runState）
   - 诊断状态（diagnostic）
   - 三者不可混淆

6. **可观测性优先**
   - 失败要有可读原因（错误码 + message + details）

---

## 8. 已知风险与技术债

1. **虚拟列表风险**
   - 页面 DOM 仅渲染可视区，可能造成“读取不全”

2. **站点结构变更风险**
   - class/hash 属性变化频繁，选择器需要容错与版本化

3. **Canvas 文本不可直接 DOM 提取**
   - 简历为 canvas 时已落地“像素截图 + 多模态识别”兜底
   - 仍需继续增强 OCR/视觉兼容与失败降级策略

4. **本地配置历史污染**
   - 老用户本地保存可能与新默认值冲突

---

## 9. 下一会话建议起手任务（推荐顺序）

1. **实现全量采集模式（最高优先级）**
   - 增加滚动容器探测
   - 循环滚动 + 稳定停顿
   - `CandidateSummary` 去重合并（优先 `data-geekid`）

2. **为读取链路增加调试追踪开关**
   - 记录命中的 frame URL、命中 selector、命中数量

2.1 **Canvas 识别链路增强（新增）**
   - 记录 canvas 是否“可读取”（toDataURL 是否成功）
   - 接口不支持图片输入时自动回退文本模式

3. **设置面板增加“生效选择器预览”**
   - 展示输入值与标准化后值

4. **定义稳定主键策略**
   - 优先读取 `data-geekid` 作为候选人唯一键

---

## 10. 续接提示（给新对话）

在新会话中可直接引用以下信息：

- 当前项目已实现 sidepanel + iframe 读取 + 多 frame 聚合
- 已将列表项粒度切换为 `li.card-item / .card-item`
- 当前瓶颈从“能否读取”转为“能否全量读取（虚拟列表）”
- 下一阶段重点：滚动全量采集 + 去重合并 + 详情读取稳态化

---

## 11. 快速验收清单（现阶段）

- [ ] 打开 BOSS 推荐 iframe 页面
- [ ] sidepanel 点击“刷新页面数据”
- [ ] `页面候选人数` > 1（至少可视区数量）
- [ ] “当前页面候选人数据”表展示多行
- [ ] 诊断输出中 frame 命中与数量一致

---

（完）
