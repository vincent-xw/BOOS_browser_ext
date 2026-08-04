## Context

现有实现把「读」和「写」都压在 `src/services/chromeMcpService.ts`（1797 行）一个文件里，全部通过 `chrome.scripting.executeScript` 按需注入完成。项目**没有** `content_scripts` 声明，也没有 `debugger` 权限。写操作是合成事件：

- `:846-866` 手工拼 `pointerdown → mousedown → mouseup → click` 的 `MouseEvent` 序列，注入到 `world: 'MAIN'`，再兜一次 `target.click()` + `target.focus?.()`，最后固定 `setTimeout(1400)`。
- `:257-280` 直接 `activeElement.value = text` / `textContent = text`，再补发 `Event('input')` 与 `Event('change')`。
- `:785-873` 为了知道点击有没有生效，在页面上下文里 monkey-patch `window.fetch` 与 `XMLHttpRequest.prototype.open/send`，`finally` 里恢复。
- `:875-891` 用 `textContent` / `className` 前后 diff 加中文正则（`/已收藏|取消收藏|.../`）猜测结果。

这些合成事件 `isTrusted === false`，拿不到 user activation，也不走真实焦点与输入法路径。副作用是当前工作流已经退化：`usePageIoController.ts:376-522` 的主循环**不再调用** `openCandidateDetail` / `clickFavoriteButton`，只靠列表预览文本让模型判断——因为点开详情、点收藏这条链路不可靠。

AI 侧是 `llmService.ts` 一次性的批量评估：`requestWithTimeout` 打 Ark 的 OpenAI 兼容端点，`buildBatchPrompt` 是唯一的 prompt 模板，无工具、无多轮、无会话。Ark API Key 明文存 `localStorage`（`settingsService.ts:192`）。

消息层几乎不存在：整个项目只有一个消息类型 `BOOS_GET_LAST_GEEK_LIST_URL`（`chromeMcpService.ts:435` → `background.ts:71-89`）。sidepanel 直接调 service，因为它本身就在扩展上下文里有 `chrome.*`。

同级 `agent-kit` 是未发布的 workspace-local monorepo（约 710 行源码）。`@agent-kit/core` 无 Node 依赖、只依赖 zod，语法上可在 MV3 Service Worker 运行；但它的工具调用链路**实际不可达**——`llm-client.ts:86-89` 的请求体只有 `{ model, messages }`，从不发送 `tools`，模型永远不知道有哪些工具可调。它的 `docs/integrations/browser-extension-bff.md` 恰好是按本项目名写的，明确要求扩展做 Tool Host、不持有密钥。

## Goals / Non-Goals

**Goals:**

- 所有页面写操作走 `chrome.debugger` + CDP `Input` 域，产出 `isTrusted === true` 的真实事件。
- 读/定位/验证留在 DOM 侧（content script），写留在 Service Worker 侧（CDP）。职责单向、不交叉。
- 用「单步执行 + 逐步验证」的闭环替换掉「固定延时 + 事后猜测」。
- agent 能力通过 agent-kit 接入，扩展作为 Tool Host，密钥移到 BFF。
- 在 agent-kit 仓库内把工具调用链路补成真正可用的（不是在本项目里 vendor 一份分叉）。
- 打通一条端到端 POC：定位「打招呼」→ CDP 点击 → 验证弹窗与请求 → 点击输入框 → `Input.insertText` 中文 → 点发送/Enter → 验证消息发出。

**Non-Goals:**

- 不做流式输出。agent-kit 完全没有 SSE，本次不补——任务是分步动作驱动，不需要 token 级 UI。
- 不做 Anthropic provider。已定沿用 Ark（OpenAI Chat 兼容），复用现有 key（只是搬到 BFF）。
- 不改候选人评估的业务判定逻辑（`buildBatchPrompt` 的评分口径保持不变），只改它的调用路径。
- 不做 Cloudflare Worker 部署形态。`adapter-cloudflare` 在本次不参与。
- 不发布 npm。本次只做到「可发布」；实际 `pnpm publish` 由用户手动执行。
- 不做多标签页并发自动化。同一时刻单标签页单会话。

## Decisions

### D1：`chrome.debugger` 而不是 `chrome.scripting` 做写操作

**选择**：Service Worker 持有 `chrome.debugger` 会话，写操作全部经 CDP `Input` 域。

**理由**：`isTrusted` 无法伪造。BOSS 直聘前端依赖真实焦点流转与 user activation（弹窗、发送按钮的启用态都和这些相关），合成事件在这些点上不可靠——现有代码不得不加 `target.click()` 兜底、加 1400ms 固定等待、加请求 monkey-patch 猜结果，这三个补丁本身就是症状。

**代价（明确接受）**：标签页顶部会常驻「XX 正在调试此浏览器」横幅，用户点关闭就断连。这个 UX 成本不可消除，只能在 UI 上提前说明。

**否决的替代方案**：
- 继续合成事件 + 加更多兜底 → 已经在做，不可靠，是本次改造的动因。
- `chrome.debugger` 只做点击、输入继续用 `value` 赋值 → 输入框的 value 赋值同样绕过输入法与框架的受控组件更新路径，中文场景尤其容易只改了 DOM 没改框架 state。不留半套。
- Puppeteer / Playwright → 不是浏览器扩展形态，用户装不了。

### D2：坐标契约 —— CSS 像素，相对主页面 viewport，不乘 DPR

**选择**：定位方返回 `getBoundingClientRect()` 的 CSS 像素中心点；子 frame 内的元素由 content script 逐层加上 frame 自身的偏移，换算到主页面坐标系后再交给 CDP。

**理由**：CDP `Input.dispatchMouseEvent` 的 `x`/`y` 定义就是主页面 viewport 的 CSS 像素。乘 `devicePixelRatio` 是这里最常见的错误，在 Retina 上会点到大约两倍偏移的位置——而且因为常常还是点在页面内某个元素上，症状表现为「点了但点错了」，比直接报错更难查。这条契约写进 spec 并加单测。

**遗留问题**：现有读取是 `allFrames: true` + `pickBestInjectionResult` 打分聚合（`chromeMcpService.ts:114`），AGENTS.md 明确禁止退化成只读主 frame。CDP 是单 target 模型。解法是保留 all-frames 读取用于定位，但把定位结果的坐标统一换算到主页面坐标系，CDP 只在主 target 上下发。

### D3：content script 只读，Service Worker 只写

**选择**：新增 `entrypoints/content.ts`，职责严格限定为 DOM 读取、元素定位、坐标计算、结果验证。写操作一律不在 content script 里发生。

**理由**：这是能让「不许用合成事件」这条规则**可被审查**的唯一办法。如果 content script 既能读又能写，那么某次调试时随手加一句 `el.click()` 兜底就会重新滑回去——现有代码就是这么长出来的。把写能力从 content script 的可达范围里物理移除，规则就变成结构性的而非纪律性的。

**代价**：多一跳消息往返（SW → content 定位 → SW 执行 CDP → SW → content 验证）。因为每步都要重新定位，这个往返本来就避不开。

### D4：每步重新定位，禁止坐标批量缓存

**选择**：`读取 DOM → 定位 → 重算坐标 → 一个 CDP 动作 → 等待 → 验证 → 下一步`，每轮只做一个写动作。

**理由**：弹窗出现会让底层元素位移，虚拟列表滚动会整片换 DOM 节点，框架重渲染会换掉节点引用。缓存一批坐标连续点，第二次之后基本都是点在错误位置上——而且同样是「不报错但点错」。

**实现约束**：这条会直接改写 `usePageIoController.ts:376-522` 的线性循环结构。批量遍历候选人的外层循环保留，但每个候选人内部的动作序列改成闭环。

### D5：验证用轮询 + 多维度，不用固定延时

**选择**：验证器接受一组期望条件（弹窗出现 / DOM 文案变化 / 输入框值匹配 / 提交按钮变可用 / 网络请求发出并成功），轮询直到满足或超时。

**理由**：现有 `setTimeout(1400)`（`:865`）在快的时候白等、慢的时候不够——两头都错。而且「命令没报错」不等于「页面动了」，这是当前最大的可靠性缺口：现有代码正是因为无法判断成功，才不得不去 patch `window.fetch`。

**网络观测改用 CDP `Network` 域**：替换 `:785-873` 的页面全局改写。理由不只是优雅——monkey-patch 一旦 `finally` 没跑到（比如页面中途导航），就会把站点的 `fetch` 永久留在被改写状态。CDP 观测在页面外部，没有这个失败模式。`background.ts:50-160` 现有的 `webRequest` 监听可以保留做 URL 缓存，但动作级验证走 CDP。

### D6：BFF 模式 —— 扩展降级为 Tool Host

**选择**：按 agent-kit 的 `docs/integrations/browser-extension-bff.md` 落地。扩展不持有 Endpoint / 模型名 / API Key，只有 BFF 地址 + 接入 token。BFF 基于 `@agent-kit/bff-hono` + `@agent-kit/adapter-sqlite`，持有 Ark 配置，环境变量 `AGENT_KIT_MASTER_KEY` + `BFF_API_TOKEN`。

**理由**：agent-kit 的核心设计不变量就是这条（README.md:14、design spec:10），而 `bff-hono` 与 `examples/browser-extension-bff` 已经现成。绕过它意味着 `adapter-sqlite` 和 `bff-hono` 两个包变成死代码，且本项目要自己长一套密钥管理。

**代价（明确接受）**：实验门槛变高——要多跑一个 Node 进程。缓解手段是提供单条命令的启动路径并写进文档，这一条列为验收项。

**否决的替代方案**：
- 维持扩展内直连 Ark → 定向违反 agent-kit 的设计不变量，且 key 留在 `localStorage`。
- 只把 key 挪到 `chrome.storage` → 换了个抽屉，仍在浏览器里，攻击面没变。

### D7：改 agent-kit 本体，而不是 vendor 一份

**选择**：在 `agent-kit` 仓库内修复缺陷。开发期本项目用 pnpm workspace / `file:` 依赖，生产期改为 npm 版本号依赖。

**理由**：需要改的是 agent-kit 对**所有**消费方都缺的东西（工具压根没发给模型），不是本项目的特殊适配。vendor 一份等于放弃上游、并且下次还要再修一遍。

**必须修的清单（按阻塞程度）**：

1. **`llm-client.ts:86-89` 请求体缺 `tools`** —— 这是致命的：模型从不知道有哪些工具，`harness.ts:61-74` 的整个工具分支实际不可达；`harness.test.ts` 只用伪造的 `LlmClient` 手工造 tool call 才让它看起来能跑。需要新增 zod → JSON Schema 转换模块并注入 `tools`。
2. **`llm-client.ts:33-38` 的 `role: 'tool'` 消息缺 `tool_call_id`** —— 真实 OpenAI 兼容端点直接 400。
3. **assistant 轮次从不入库** —— `contracts.ts:15` 的 `SessionMessage` 只有 `user`/`tool` 两种角色，模型看不到自己上一轮说了什么，多轮实际不成立。
4. **`llm-client.ts:51-64` 只取第一个 tool call** —— 需支持并行调用。
5. **工具执行无 timeout / AbortSignal** —— `execute(input)` 只收 input，卡住的工具会永久挂住 `harness.ts:37-98` 的循环。
6. **`harness.ts:38` 的 `pendingCalls` 是进程内 `Map`** —— 抽成可插拔存储接口。注意：在 BFF 模式下这个 Map 活在 Node 进程里，不再受 MV3 挂起影响，但进程重启同样会丢，仍需修。
7. **`RegisteredPrompt.protocol`（`prompt-registry.ts:11`）与 `ContextManager` 声明了但从未被读取** —— 接进 harness，否则应从公开接口移除。另注：`context-manager.ts:23-24` 的「摘要」是硬编码中文字符串 `已裁剪 N 条历史消息` + `slice(-maxMessages)`，不是真摘要；本次只做接线，不升级为真摘要。
8. **各包 `"private": true`** —— 发布前解除。

### D8：Service Worker 状态持久化

**选择**：agent 任务的会话标识、待执行工具调用、调试会话状态落 `chrome.storage.session`。

**理由**：MV3 Service Worker 约 30 秒空闲即挂起。任务在等待页面更新时正是空闲的——这是最容易被挂起的时刻。SW 唤醒后如果发现原调试会话已断，必须安全终止而不是继续下发命令。

### D9：新增集中消息路由层

**选择**：在 `background.ts` 建立带显式类型定义的消息路由，未知类型返回结构化失败。

**理由**：现在只有一个消息类型，加进 CDP 动作 + 定位 + 验证 + agent 工具后会有十几个。没有路由层就会变成一长串 `if (msg.type === ...)`。同时保留 `ServiceResult<T>` 信封（`page-io.ts:167`）并给 `ProviderKind`（`page-io.ts:3`）加 CDP 通道，这是 AGENTS.md 要求的服务边界。

## Risks / Trade-offs

- **调试横幅常驻，用户手动关闭即断连** → 不可消除。UI 提前说明；`onDetach` 里给可读原因与重试引导；任务状态明确置失败而不是静默卡住。
- **用户打开 DevTools 会抢占调试连接**（同一标签页只允许一个调试客户端） → `attach` 失败时返回可读原因，明确提示「先关闭 DevTools」；运行中被抢占则中止任务。
- **坐标乘了 DPR 会「点了但点错」，不报错** → 契约写进 spec，加针对 `devicePixelRatio > 1` 的单测；POC 阶段在高 DPI 屏上人工验一遍。
- **跨 frame 读取的「聚合取最优」与 CDP 单 target 模型冲突** → 定位保留 all-frames 聚合，坐标统一换算到主页面坐标系；AGENTS.md 明令禁止退化为只读主 frame，需在实现中显式保住。
- **改 agent-kit 是跨仓库改动，两边容易不同步** → 开发期用 workspace 依赖让改动即时可见；agent-kit 侧每项修复都要有单测；本项目 `pnpm run typecheck` 作为集成关卡。
- **BFF 让实验门槛变高** → 提供单条命令启动路径 + 环境变量清单，列为验收项；设置面板提供 BFF 连通性检查，区分「地址不可达」与「凭据无效」，避免用户在任务失败时无从下手。
- **删除 monkey-patch 会一并删掉现有的 `startFavoriteNetworkRecording` / `stopFavoriteNetworkRecording` / `replayFavoriteNetworkRequests` 三个诊断接口** → 在 CDP `Network` 观测上重建等价能力后再删，`diagnosticService.ts` 的探针需同步覆盖 attach 状态与 CDP 可用性。
- **agent 分步执行比原来的批量单次调用慢、且 token 消耗更高**（每步一次 LLM 往返） → 接受。本次目标是可靠性，不是吞吐。批量遍历候选人的外层循环保留，能明显靠规则判定的步骤不必进 agent 决策。
- **升级会清除用户已存的 Ark API Key** → 迁移逻辑显式删除该字段并写回；文档说明 key 需重新配置到 BFF 环境变量。

## Migration Plan

分阶段，每阶段可独立验证：

1. **agent-kit 修复**（跨仓库，先行）—— zod→JSON Schema、`tools` 注入、`tool_call_id`、assistant 持久化、并行调用、工具超时、可插拔 pending 存储、protocol/ContextManager 接线。每项配单测，`pnpm test` 通过。
2. **BFF 落地** —— 基于 `bff-hono` + `adapter-sqlite` 起服务，持有 Ark 配置，跑通 run / tool-results 两个接口。此阶段扩展还没接，用 curl 验证。
3. **CDP 基础设施** —— `debugger` 权限、会话管理器、`onDetach` 处理、消息路由层、content script 骨架。此阶段不删旧路径，新旧并存。
4. **POC 闭环** —— 打招呼全链路：定位 → CDP 点击 → 验证弹窗与请求 → 点输入框 → `insertText` 中文 → 发送 → 验证。这是整个方案的成立性判据。
5. **切换与删除** —— POC 通过后，`clickFavoriteButton` / `openCandidateDetail` / `writeWithTabsScripting` 改走 CDP；删除合成事件路径与 fetch/XHR monkey-patch。
6. **设置迁移** —— 移除 Endpoint / 模型 / API Key，新增 BFF 配置 + 连通性检查，清除旧 key。

**回滚**：第 5 步之前旧路径都还在，回滚即停用新通道。第 5 步之后回滚需 revert 提交——所以第 4 步的 POC 必须真在 zhipin.com 上验证过，不能只跑单测。

## Open Questions

- POC 用哪个具体页面与按钮做基准？「打招呼」在推荐列表、搜索结果、在线简历弹窗里的 DOM 结构可能不同，需要先确定一个作为验收目标。
- 每步验证的超时上限取多少？现有固定 1400ms 是拍的。需要在 POC 中实测弹窗出现与请求返回的实际分布，再定默认值与可配置范围。
- agent 决策的粒度边界在哪？哪些步骤该由模型决定、哪些该由固定规则驱动（纯规则更快更稳）。倾向于「定位与判定进 agent，机械动作序列走固定规则」，但需在 POC 后依据实际效果确认。
- BFF 的会话保留策略：SQLite 中的会话历史保留多久、是否需要清理任务。
- `context-manager.ts` 的裁剪策略当前是 `slice(-maxMessages)`，接线后是否够用；若不够是否本次就升级为真摘要（倾向不做，留待后续）。
