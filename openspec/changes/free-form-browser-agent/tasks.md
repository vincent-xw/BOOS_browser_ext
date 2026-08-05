## 1. agent-kit：提示词选择、裁剪配对与摘要注入

已完成，提交 `b06c448`。

- [x] 1.1 `harness.run()` 增加可选 `promptName`；`resolvePrompt` 按名取，未指定时回退默认
- [x] 1.2 `PromptRegistry` 新增 `getByName`；`AgentKitErrorCode` 新增 `PROMPT_NOT_FOUND`
- [x] 1.3 `PendingCall` 增加 `promptName`，`resume()` 沿用发起调用时的提示词
- [x] 1.4 `adapter-sqlite` 挂起调用表新增 `prompt_name` 列，含既有库文件的 ALTER 兼容
- [x] 1.5 `bff-hono` 的 run 路由接受并透传 `promptName`，非字符串时返回 `REQUEST_INVALID`
- [x] 1.6 `context-manager` 裁剪改为配对感知：以 assistant + 其全部 tool 结果为不可分割单元
- [x] 1.7 单个单元超过窗口时保持配对完整并接受超限
- [x] 1.8 裁剪摘要作为 system 消息前置；`SessionMessage` 新增 `system` 角色
- [x] 1.9 `llm-client` 处理 `system` 角色消息
- [x] 1.10 回归测试：孤立 tool 消息、无结果调用、并行调用同去同留、按名选提示词、
        非默认提示词的协议生效、resume 沿用提示词、摘要注入与不注入

## 2. 快照工具与 ref 引用

已完成，提交 `cbc916b`（BFF 侧）与 `a5bf9a2`（扩展侧）。

- [x] 2.1 `types/cdp.ts` 新增 `SnapshotEntry`、`PageSnapshotResult`、`RefResolution`；
        `ElementLocator` 增加 `ref`，`role` 改为可选
- [x] 2.2 `domLocator.snapshotInteractive()`：采集视口内可交互元素，WeakRef 注册表登记 ref
- [x] 2.3 `domLocator.resolveRef()`：按 ref 取当前坐标，含 stale 判定与遮挡检测
- [x] 2.4 视口外元素先滚入再重算坐标
- [x] 2.5 快照上限 150 条，超出时返回 `truncated` 数量
- [x] 2.6 `popstate` / `pagehide` 时清空 ref 注册表
- [x] 2.7 `locateElement` 支持 ref 路径与纯 selector 路径；三者全缺时返回失败
- [x] 2.8 新增 `ContentSnapshot`、`ContentResolveRef` 两个消息类型与 content script 处理器
- [x] 2.9 background 路由：快照合并所有 frame，ref 解析取单一命中
- [x] 2.10 BFF 侧新增 `browser.snapshot` 工具定义；`locate_element` 的 role 改可选
- [x] 2.11 `browser.click` / `browser.input_text` 接受 `ref`，坐标改为可选
- [x] 2.12 `input_text` 增加 `clearFirst`
- [x] 2.13 `toolExecutor.resolveTargetPoint()`：传 ref 时下发前重解析坐标；
        stale 或被遮挡时不下发动作
- [x] 2.14 白名单增至 9 个工具；新增 `isReadOnlyTool` 划分只读与写
- [x] 2.15 新增自由指令提示词 `free-form` 并注册为默认；交代先快照后动作、每步验证
- [x] 2.16 测试：ref 优先于坐标、解析先于点击、stale 不下发、遮挡不下发、clearFirst 顺序、
        role 可选、快照工具派发

## 3. 域名权限、URL 白名单与逐步审批

已完成，提交 `11e4afc`。

- [x] 3.1 新增 `services/urlAllowlist.ts`：域名（含 `*.` 通配）与路径前缀/正则匹配
- [x] 3.2 默认从严：空白名单拒绝一切、裸域名不覆盖子域、非 http(s) 拒绝、
        非法正则视为不匹配
- [x] 3.3 background 新增 `requireWritable`：写动作下发前校验当前 tab URL
- [x] 3.4 四个写动作（click / input_text / press_key / scroll）改走 `requireWritable`；
        读动作保持只校验会话
- [x] 3.5 `MessageErrorCode` 新增 `URL_NOT_ALLOWED`
- [x] 3.6 新增 `agent/approvalGate.ts`：只读自动放行，写需批准，三档授权
- [x] 3.7 域名级授权持久化到 `chrome.storage.local`；会话级授权存内存
- [x] 3.8 无审批界面时拒绝写操作（安全默认）
- [x] 3.9 `summarizeAction`：把动作转为人话描述，长文本截断
- [x] 3.10 `runAgentSession` 接入审批门；被拒动作以 `USER_DENIED` 回填并标记 `denied`
- [x] 3.11 `runAgent` 透传 `promptName`
- [x] 3.12 manifest 改用 `optional_host_permissions: ['*://*/*']`
- [x] 3.13 新增 `services/permissionService.ts`：运行时申请 host 权限、
        `registerContentScripts` 动态注册、规则增删与注册范围同步
- [x] 3.14 测试：白名单 31 项、审批门 19 项、审批集成 7 项

## 4. 自由指令 UI 与多轮会话

- [x] 4.1 新增 `composables/useFreeFormController.ts`：多轮会话状态、审批 Promise 桥接、
        调试会话生命周期
- [x] 4.2 审批实现为「把请求交给 UI、await 对话框 resolve」——
        agent 循环就在 sidepanel，无需跨上下文暂停机制
- [x] 4.3 停止时若正等待审批，按拒绝处理，避免 Promise 永久挂起
- [x] 4.4 新增 `components/FreeFormPanel.vue`：指令输入、对话记录、实时步骤、审批对话框
- [x] 4.5 审批对话框展示动作描述、工具名与目标页面，提供三档授权与拒绝
- [x] 4.6 步骤摘要区分成功、失败与被拒绝
- [x] 4.7 展示当前页面是否在白名单内
- [x] 4.8 `App.vue` 用 tab 区分自由指令与 BOSS 预设流程，默认停在自由指令
- [x] 4.9 设置面板新增白名单管理：查看、添加（含「用当前站点」）、移除
- [x] 4.10 设置面板新增免审批授权的查看与撤销
- [x] 4.11 更新 `AGENTS.md`（两条执行路径、ref 与坐标分工、写操作双闸门）与 `README.md`
- [x] 4.12 `pnpm run typecheck`、`pnpm test`（189 项）、`pnpm run build` 全绿

## 5. 待真机验证

以下需要真实 BFF（含真实 `LLM_API_KEY`）与人工操作，无法在开发环境完成。

- [ ] 5.1 用真实 `LLM_API_KEY` 启动 BFF，确认 `free-form` 提示词生效
- [ ] 5.2 设置中添加低风控域名（例如 example.com），确认权限申请弹窗与 content script 生效
- [ ] 5.3 下指令「在搜索框输入 Vue3 并搜索」，确认模型先快照、按 ref 操作、逐步请求审批
- [ ] 5.4 续下「点第三条结果」，确认多轮上下文使指代成立
- [ ] 5.5 在未加入白名单的域名下指令，确认写操作被拒且提示可读
- [ ] 5.6 验证三档授权各自的作用范围（本次 / 本会话 / 该域名永久）
- [ ] 5.7 实测快照 150 条上限是否够用；复杂页面是否需要配合滚动分批快照
- [ ] 5.8 回归：BOSS 预设流程仍可用（关闭「执行真实收藏动作」以只读验证）
