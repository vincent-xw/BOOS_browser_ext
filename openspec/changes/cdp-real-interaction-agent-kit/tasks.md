## 1. agent-kit：工具调用链路补齐（跨仓库，先行）

在 `/Users/xuewen/ai-lab/project/agent-kit` 仓库内完成。每项均需补单测，收尾跑 `pnpm typecheck && pnpm test`。

- [x] 1.1 新增 `packages/core/src/json-schema.ts`：zod → JSON Schema 转换，支持对象、字符串、数值、布尔、枚举、数组、可选字段与嵌套对象；不支持的结构抛带稳定错误码的异常并指明工具名与字段名
- [x] 1.2 在 `packages/core/src/errors.ts` 的 `AgentKitErrorCode` 中新增所需错误码（Schema 转换失败、工具执行超时、工具结果无法关联调用）
- [x] 1.3 为 `json-schema.ts` 写单测：覆盖嵌套对象、可选字段的 `required` 正确性、枚举、数组、以及不支持结构抛错
- [x] 1.4 修 `packages/core/src/llm-client.ts:86-89`：请求体注入 `tools` 字段，内容由工具注册表经 1.1 转换得出；注册表为空时省略该字段
- [x] 1.5 修 `packages/core/src/llm-client.ts:33-38`：`role: 'tool'` 消息携带 `tool_call_id`；无法关联到已发起调用的工具结果直接拒绝并返回稳定错误码
- [x] 1.6 扩展 `packages/core/src/contracts.ts:15` 的 `SessionMessage` 支持 `assistant` 角色（含其发起的 tool calls），并在 harness 中持久化每轮 assistant 输出
- [x] 1.7 修 `packages/core/src/llm-client.ts:51-64`：解析并返回本轮全部 tool calls，不再只取第一个
- [x] 1.8 修 `packages/core/src/harness.ts`：支持一轮内多个待执行工具调用，全部结果回填后才进入下一轮；其中部分失败时把失败与成功结果一并回传模型，不中断整轮
- [x] 1.9 给 `ToolDefinition.execute` 增加 `AbortSignal` 参数与超时上限配置；超时以稳定错误码结束该次调用，harness 循环继续
- [x] 1.10 把 `harness.ts:38` 的进程内 `pendingCalls` Map 抽成可插拔存储接口，保留内存实现为默认；验证进程重启后凭 `callId` 回填仍可关联
- [x] 1.11 把 `context-manager.ts` 接进 harness 的消息构造流程（当前完全未被调用）；保持 `slice(-maxMessages)` 策略不变，不升级为真摘要
- [x] 1.12 让 `prompt-registry.ts:11` 的 `RegisteredPrompt.protocol` 在构造请求时被实际读取应用；若判定本次不接入则从公开接口移除该字段
- [x] 1.13 补 harness 集成测试：用真实（非伪造）的 `LlmClient` 请求体断言 `tools` 已发送、`tool_call_id` 已回传、assistant 轮次已入库
- [x] 1.14 解除 `packages/core`、`packages/bff-hono`、`packages/adapter-sqlite` 的 `"private": true`，补齐发布所需元数据（files、repository、license）；不执行 publish
- [x] 1.15 更新 agent-kit 的 README 与 `docs/integrations/browser-extension-bff.md`，反映 tools 注入与新增的超时/存储接口

## 2. BFF 服务落地

- [x] 2.1 基于 `@agent-kit/bff-hono` + `@agent-kit/adapter-sqlite` 搭起 BFF 入口，注入 harness 与 `authenticate` 实现
- [x] 2.2 BFF 侧持有 Ark（OpenAI Chat 兼容）配置：baseUrl、模型名、API Key，全部从环境变量读取
- [x] 2.3 实现启动时校验：缺 `AGENT_KIT_MASTER_KEY` 或 `BFF_API_TOKEN` 时拒绝启动并输出明确的缺失配置提示
- [x] 2.4 校验持久化存储中的模型密钥为 AES-256-GCM 密文，且主密钥未被写入存储
- [x] 2.5 实现接入鉴权：凭据缺失或不匹配返回 401 `UNAUTHORIZED`，且不发起任何模型调用
- [x] 2.6 验证会话按已认证主体隔离：相同 sessionId 在不同主体间历史互不可见；跨主体回填 `callId` 被拒
- [x] 2.7 收敛错误响应为 `{ code, requestId, message }` 三项；审查日志确认不含密钥、Prompt 正文、模型原文与业务上下文
- [x] 2.8 把候选人评估 prompt（原 `src/services/llmService.ts` 的 `buildBatchPrompt`）迁到 BFF 侧注册，评分口径保持不变
- [x] 2.9 在 BFF 侧注册全部远端工具定义（`execution: 'remote'`）：`browser.read_page`、`browser.locate_element`、`browser.click`、`browser.input_text`、`browser.press_key`、`browser.scroll`、`browser.verify`、`browser.screenshot`
- [x] 2.10 用 curl 端到端验证 run 与 tool-results 两个接口（此阶段扩展尚未接入）
- [x] 2.11 编写 BFF 启动文档：环境变量清单 + 单条启动命令，确保按文档可直接跑起来

## 3. 依赖接线

- [x] 3.1 本项目以 pnpm workspace 或 `file:../agent-kit/packages/core` 方式依赖 `@agent-kit/core`，确认类型与运行时入口均可解析
- [x] 3.2 跑 `pnpm run typecheck` 确认 agent-kit 的 `module: NodeNext` 与 WXT/Vite 解析无冲突
- [x] 3.3 在文档中记录生产期切换为 npm 版本号依赖的步骤，确认切换后无需改动任何 import 语句

## 4. 清单与权限

- [x] 4.1 `wxt.config.ts:14-16` permissions 新增 `debugger`
- [x] 4.2 host_permissions 移除 `ark.cn-beijing.volces.com`，新增 BFF 地址
- [x] 4.3 新增 `content_scripts` 声明，匹配目标站点 host 规则
- [ ] 4.4 验证扩展重载后 attach 成功、content script 自动注入、BFF 请求未被拦截

## 5. 消息路由层

- [x] 5.1 在 `entrypoints/background.ts` 建立集中消息路由，消息类型有显式类型定义（当前仅有 `BOOS_GET_LAST_GEEK_LIST_URL` 一种）
- [x] 5.2 未知消息类型返回结构化失败结果，指明该类型不受支持，不静默忽略
- [x] 5.3 保留 `ServiceResult<T>` 信封（`src/types/page-io.ts:167`），给 `ProviderKind`（`page-io.ts:3`）新增 CDP 通道类型
- [x] 5.4 迁移现有 `BOOS_GET_LAST_GEEK_LIST_URL` 到新路由，确认原功能未回归

## 6. CDP 会话管理

- [x] 6.1 新增 Service Worker 侧会话管理器：任务开始 `chrome.debugger.attach({ tabId }, '1.3')`，任务期间复用单一会话，不在每个操作前后重复 attach/detach
- [x] 6.2 实现四种 detach 触发路径：任务正常完成、任务异常终止、目标标签页关闭、用户主动停止
- [x] 6.3 监听 `chrome.debugger.onDetach`，分别处理用户关闭调试横幅、用户打开 DevTools 抢占、标签页被关闭三类断连，各给可读提示并将任务置失败
- [x] 6.4 实现单标签页单会话约束：已有活动会话时拒绝新任务并提示已有任务运行中
- [x] 6.5 `attach` 因已有其他调试客户端而失败时，返回可读原因并明确提示先关闭 DevTools
- [x] 6.6 把会话标识、待执行工具调用与调试会话状态持久化到 `chrome.storage.session`
- [x] 6.7 实现 SW 唤醒恢复：能恢复则继续任务；发现原调试会话已断开则清理状态并安全终止，不向失效会话下发命令

## 7. CDP 输入原语

- [x] 7.1 实现真实点击：`Input.dispatchMouseEvent` 的 `mouseMoved` → `mousePressed` → `mouseReleased` 三段序列，按下与释放携带 `button: 'left'`、`clickCount: 1`
- [x] 7.2 三段序列中任一命令失败时中止点击，返回含失败阶段与错误原因的结构化结果
- [x] 7.3 实现文本输入：先经 CDP 点击目标输入框建立真实焦点，再调用 `Input.insertText` 写入（含中文）
- [x] 7.4 点击输入框后验证焦点确实落在该元素上；未落上则返回失败，不继续写入
- [x] 7.5 实现按键：`Input.dispatchKeyEvent` 下发 Enter、Tab、Escape、退格与组合快捷键的 `keyDown` / `keyUp`
- [x] 7.6 实现滚动与截图原语
- [x] 7.7 加坐标契约单测：断言下发坐标与 `getBoundingClientRect()` 的 CSS 像素一致，且在 `devicePixelRatio > 1` 时未做任何 DPR 缩放
- [ ] 7.8 在高 DPI 屏上人工验证一次点击落点正确

## 8. content script：定位与验证

- [x] 8.1 新增 `entrypoints/content.ts`，职责限定为 DOM 读取、元素定位、坐标计算、结果验证；不含任何写操作代码路径
- [x] 8.2 实现 content script 未就绪时的按需注入重试一次，仍失败返回结构化失败结果
- [x] 8.3 移植定位策略：用户配置选择器优先、`BOSS_FALLBACK_SELECTORS`（`chromeMcpService.ts:22-25`）兜底，结果标记命中来源
- [x] 8.4 全部选择器均未命中时，失败结果中列出已尝试的选择器清单
- [x] 8.5 定位结果返回元素中心坐标、元素矩形、是否在视口内、是否可见、是否被遮挡
- [x] 8.6 元素不在视口内时先滚入视口再重算坐标后返回
- [x] 8.7 实现遮挡判定：中心点命中测试返回的不是目标元素或其子元素时，返回遮挡标记与遮挡元素信息
- [x] 8.8 子 frame 内元素的坐标逐层叠加 frame 偏移，换算为相对主页面 viewport 的坐标
- [x] 8.9 保住跨 frame 读取的「聚合取最优」：沿用 `pickBestInjectionResult`（`chromeMcpService.ts:114`）的打分聚合，记录被选中的 frame 标识，不退化为只读主 frame

## 9. 结果验证器

- [x] 9.1 实现轮询等待：条件提前满足立即返回，达超时上限则返回含中间状态的超时失败；不使用固定 `setTimeout` 作为唯一等待手段
- [x] 9.2 实现验证维度：目标弹窗是否出现
- [x] 9.3 实现验证维度：相关 DOM 状态或文案是否变化
- [x] 9.4 实现验证维度：输入框当前值与期望文本是否一致
- [x] 9.5 实现验证维度：目标提交按钮是否变为可用（检测 disabled 属性与禁用类名）
- [x] 9.6 实现验证维度：基于 CDP `Network` 域事件观测相关请求是否发出、URL/方法/响应状态码
- [x] 9.7 预期请求在等待窗口内未发出时判定验证失败并返回该原因
- [x] 9.8 命令成功但所有维度均未观测到预期变化时判定为失败，返回各维度实际观测值
- [x] 9.9 在 CDP `Network` 观测上重建等价诊断能力，替代 `startFavoriteNetworkRecording` / `stopFavoriteNetworkRecording` / `replayFavoriteNetworkRequests`（`chromeMcpService.ts:914/1231/1369`）
- [x] 9.10 更新 `src/services/diagnosticService.ts` 探针，覆盖 attach 状态与 CDP 可用性

## 10. Tool Host 协议

- [x] 10.1 实现 `POST /v1/agent/sessions/:sessionId/run` 调用，携带 `Authorization: Bearer` 接入 token
- [x] 10.2 处理 `final` 类型响应，将结果呈现给用户
- [x] 10.3 处理 `pending_tool_call`：解析工具名与 `callId`，执行工具，经 `POST /v1/agent/sessions/:sessionId/tool-results/:callId` 回填
- [x] 10.4 实现多轮循环：回填后对新的 `pending_tool_call` 重复执行，直到收到 `final`
- [x] 10.5 BFF 返回 401 `UNAUTHORIZED` 时中止任务并提示检查 BFF 地址与接入 token
- [x] 10.6 实现远端工具白名单校验：白名单外的工具名拒绝执行任何页面动作，并回填「工具未授权」失败结果
- [x] 10.7 实现工具输入结构校验：输入不满足定义时拒绝执行并回填输入不合法的失败结果
- [x] 10.8 把 CDP 原语与定位/验证能力接成 8 个远端工具的扩展侧实现

## 11. POC 端到端闭环

- [x] 11.1 确定 POC 基准页面与「打招呼」按钮（推荐列表 / 搜索结果 / 在线简历弹窗三处 DOM 结构不同，需选定一处作为验收目标）
- [x] 11.2 实现单步闭环编排：读取 DOM → 定位 → 重算坐标 → 一个 CDP 动作 → 等待更新 → 验证 → 决定下一步；每轮只执行一个写动作
- [x] 11.3 每步动作前重新定位并重算坐标；重新定位失败即中止该步，不使用旧坐标
- [x] 11.4 任一步验证未通过时中止后续步骤，报告失败步骤与观测值
- [ ] 11.5 在 zhipin.com 真实页面跑通完整链路：定位打招呼按钮 → CDP 点击 → 验证弹窗出现 → 验证请求发出 → 定位输入框 → CDP 点击 → `Input.insertText` 写入中文 → 验证输入框内容 → 验证发送按钮变可用 → CDP 点击发送或 Enter → 验证消息发送请求成功返回
- [ ] 11.6 实测弹窗出现与请求返回的耗时分布，据此确定各验证维度的默认超时上限与可配置范围（替代现有拍定的 1400ms）
- [x] 11.7 依据 POC 实际效果确认 agent 决策粒度边界：定位与判定进 agent，机械动作序列走固定规则

## 12. 切换旧路径并删除合成事件

POC（第 11 组）通过后才可执行本组。本组之后回滚需 revert 提交。

- [x] 12.1 `clickFavoriteButton`（`chromeMcpService.ts:846-866`）改走 CDP，删除 `pointerdown/mousedown/mouseup/click` 合成序列、`target.click()` 兜底与固定 `setTimeout(1400)`
- [x] 12.2 `openCandidateDetail`（`chromeMcpService.ts:597-598`）改走 CDP，删除 `target.click()`
- [x] 12.3 `writeWithTabsScripting`（`chromeMcpService.ts:257-280`）改走 CDP，删除 `activeElement.value = text`、`textContent = text` 与补发的 `Event('input')` / `Event('change')`
- [x] 12.4 删除 `chromeMcpService.ts:785-873` 的 `window.fetch` 与 `XMLHttpRequest.prototype` monkey-patch 及其 `finally` 恢复逻辑
- [x] 12.5 删除 `chromeMcpService.ts:875-891` 基于 `textContent` / `className` diff 与中文正则的结果猜测逻辑
- [x] 12.6 全仓库检索确认不存在 `element.click()`、`dispatchEvent(new MouseEvent`、`.value =`、`.textContent =` 形式的页面写路径
- [x] 12.7 写操作在目标标签页无可用调试会话时返回失败，提示需先启动任务建立调试连接
- [x] 12.8 写操作结果封装中标明使用的是 CDP 通道

## 13. 工作流编排改造

- [x] 13.1 把 `usePageIoController.ts:376-522` 的线性循环改为 agent 驱动：保留候选人批量遍历外层循环，每个候选人内部改为单步闭环
- [x] 13.2 恢复被停用的详情读取与收藏动作链路（当前主循环已退化为只读列表预览文本）
- [x] 13.3 删除 `src/services/llmService.ts` 的 Ark 直连（`:281-294` 请求构造、`:169-177` `requestWithTimeout`），改为调用 BFF
- [x] 13.4 暴露任务四态（空闲 / 执行中 / 成功 / 失败）与当前步骤、已完成步骤数
- [x] 13.5 失败结果包含错误码、可读消息与失败步骤细节；界面不展示原始堆栈
- [x] 13.6 多步骤流程结束返回含成功数、失败数与失败原因摘要的汇总终态

## 14. 设置迁移

- [x] 14.1 从 `src/types/settings.ts` 与设置界面移除 LLM Endpoint、模型名称、API Key 三项
- [x] 14.2 高级设置新增 BFF 地址与接入 token 两项
- [x] 14.3 实现旧配置迁移：读取时删除已废弃的 Endpoint / 模型 / API Key 字段并写回清理后的配置，保留目标域名与选择器等仍有效字段
- [x] 14.4 验证 `localStorage`（`settingsService.ts:192`）中不再存在 API Key
- [x] 14.5 实现 BFF 连通性检查，失败时区分「地址不可达」与「凭据无效」
- [x] 14.6 保留保存成功 / 失败反馈；非法数据时保持原有有效配置

## 15. UI 与文档

- [x] 15.1 在首次启动需要调试会话的任务时说明标签页将出现调试提示条，以及关闭它会中止任务
- [x] 15.2 调试会话断开时展示可读原因与重试引导
- [x] 15.3 界面展示多步骤任务的当前步骤名称与已完成步骤数，失败时指明失败步骤及其观测结果
- [x] 15.4 更新 `AGENTS.md`：修正 `entrypoints/popup/` 为 `entrypoints/sidepanel/`（现有描述已过期），补充 CDP 通道与 content script 只读的架构约定
- [x] 15.5 更新 `README.md`：BFF 启动步骤、`debugger` 权限说明、Ark key 需重新配置到 BFF 环境变量的升级提示
- [x] 15.6 记录 BFF 会话保留策略（SQLite 会话历史保留时长与是否需要清理任务）

## 16. 收尾验证

- [x] 16.1 `pnpm run typecheck` 通过
- [x] 16.2 agent-kit 侧 `pnpm typecheck && pnpm test` 通过
- [ ] 16.3 全量回归：候选人列表读取、详情读取、收藏、打招呼、消息发送、结果导出
- [ ] 16.4 断连场景人工验证：手动关闭调试横幅、任务中打开 DevTools、任务中关闭标签页，三者均给出可读提示且任务正确置失败
- [x] 16.5 审查扩展全部配置与存储，确认不存在 LLM Endpoint、模型名称或 API Key
- [x] 16.6 确认扩展运行期发出的网络请求仅含 BFF 地址与目标站点地址，无任何模型推理接口
