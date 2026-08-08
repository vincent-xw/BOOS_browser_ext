## Context

见 [proposal.md](proposal.md)。本文件只记录实现层面的决定与已知取舍。

代码已实现完毕（agent-kit 3 个提交、扩展侧 3 个提交），本文件同步记录当时的决策依据。

## Goals / Non-Goals

**Goals**
- 调试期能在低风控页面上用自然语言下指令，agent 自主规划动作。
- 用起 harness 与 context：多轮上下文、按名选提示词、裁剪不破坏配对。
- 未来重接 BOSS 时只写 prompt 不写代码。
- 自由度受两道闸门约束，且默认偏严。

**Non-Goals**
- 不做流式输出。分步动作驱动不需要 token 级 UI。
- 不删预设 BOSS 流程。按用户要求并存，等自由指令可用后再由 AI 删除。
- 不做真摘要。`context-manager` 的摘要仍只描述裁剪数量。
- 不做跨标签页并发。

## Decisions

### D1：快照 + ref，而不是让模型写选择器

**选择**：`browser.snapshot` 返回可交互元素索引表，模型按 `ref` 指定目标。

**理由**：`locate_element` 原本只接受 8 个写死的 BOSS 角色，`read_page` 只返回纯文本 ——
模型无从推断选择器，只能盲猜。快照 + 索引引用是 Playwright / browser-use 的做法，
对自由指令最可靠。

**关键设计**：**ref 稳定、坐标易失效**。content script 侧用 `WeakRef` 注册表持有元素，
`toolExecutor` 在下发动作**之前**按 ref 重新解析坐标。这样「每步重算坐标」由执行侧强制，
而不是写在 prompt 里指望模型自觉 —— 后者在实践中一定会漏。

**否决的替代方案**：
- 模型直接写 CSS 选择器 → 模型看不到 DOM，基本靠猜，失败率高。
- `read_page` 返回简化 DOM 文本 → 介于两者之间，token 消耗大且模型仍需自己推选择器。

### D2：审批发生在 sidepanel，不需要跨上下文暂停

**选择**：`await` 一个由对话框 resolve 的 Promise。

**理由**：agent 循环跑在 sidepanel（`createMessageSender` 用 `chrome.runtime.sendMessage`
从 UI 发起），不在 Service Worker 里。所以「暂停等用户决定」就是普通的 Promise 等待，
不需要新增消息类型或状态机。

**代价**：sidepanel 关闭会中断任务。这与调试场景相符 —— 用户本来就要盯着看。

### D3：白名单校验必须在 Service Worker

**选择**：`background.ts` 的 `requireWritable` 在每个写动作前校验当前 tab URL。

**理由**：放 UI 侧的话，任何能发 `chrome.runtime.sendMessage` 的代码都能绕过。
校验点必须在权限的实际执行位置。

**默认偏严的几处**：空白名单拒绝一切；裸域名不覆盖子域（加 `example.com` 不等于放开
`evil.example.com`）；非 http(s) 协议一律拒绝；路径正则写错视为不匹配而非放行。
最后一条尤其重要 —— 配置坏了应该更严格，不能更宽松。

### D4：被拒绝的动作要回填给模型

**选择**：回填 `{ ok: false, code: 'USER_DENIED', message }`，并在 prompt 里交代
「被拒绝时不要绕道重试」。

**理由**：如果只是跳过不回填，模型会以为动作成功了，继续基于错误前提往下走。
明确告知它「这一步没发生」，它才能正确地停下并说明原因。

### D5：快照跨 frame 合并，ref 解析取单一命中

**选择**：`ContentSnapshot` 合并所有 frame 的 entries；`ContentResolveRef` 取唯一命中的 frame。

**理由**：自由指令下目标可能在任意 frame（嵌入式搜索框很常见），所以快照要给模型看全页。
而 ref 只在登记它的那个 frame 里有效，解析时取命中的那一个。

**注意**：`chrome.tabs.sendMessage` 不带 `frameId` 时只返回第一个应答的 frame ——
那就是 AGENTS.md 禁止的「只读主 frame」退化。所以两者都走显式逐 frame 广播。

### D6：提示词按名选择

**选择**：`harness.run()` 增加 `promptName`，`PendingCall` 持久化它。

**理由**：`getDefault()` 返回首个注册项，所以第二个注册的提示词及其 `protocol` 永远不可达。
`resume()` 必须沿用发起调用时的提示词，否则一次工具循环的前后两半会用不同协议 ——
SQLite 的挂起调用表因此新增 `prompt_name` 列。

## Risks / Trade-offs

- **模型可能规划出预期外动作** → 双闸门 + 逐步审批；两者默认偏严。
- **`optional_host_permissions: ['*://*/*']`** 理论上允许授权任意站点 → 这是调试期自由度的
  必要代价，实际可达范围由白名单与审批限制。安装时不索取权限，只在用户添加域名时申请。
- **快照 150 条上限** → 超出时把 `truncated` 数量告知模型；静默截断会被读成「这就是整页」。
- **ref 在 SPA 导航后可能指向错元素** → `popstate` / `pagehide` 时清空注册表，
  且 `resolveRef` 额外校验 `isConnected`。
- **两条路径并存会分叉** → 用户明确要求先并存。好消息是
  `openCandidateDetail` / `greetCandidate` / `runGreetFlow` 原本就无生产调用方，成本很低。
- **sidepanel 关闭会中断任务** → 与调试场景相符，不额外处理。

## Migration Plan

已按此顺序落地，每步独立提交：

1. agent-kit 三个缺陷修复（`b06c448`）
2. BFF 快照工具与自由指令提示词（`cbc916b`）
3. 扩展侧快照与 ref 定位（`a5bf9a2`）
4. URL 白名单与审批门（`11e4afc`）
5. 自由指令 UI 与多轮会话（本次）

**回滚**：预设流程全程未动，回滚任一步都不影响它。

## Open Questions

- 快照 150 条上限是否够用？复杂页面（例如长列表）可能需要配合滚动分批快照，
  实际效果需真机验证。
- 审批粒度是否合适？「本会话内该类动作都允许」可能过宽 —— 同一会话内点击不同元素
  风险差异很大。若实测觉得粗，可细化为按元素而非按工具授权。
- `browser.snapshot` 的 label 推断顺序（aria-label > placeholder > title > alt > value >
  name > 文本）是否足够？某些站点可能需要额外启发式。
- BFF 的 Ark 密钥目前由 `seedSecret` 启动时写入 SQLite，此前只用 stub 端点验证过。
  真机验证需要先用真实 `LLM_API_KEY` 启动一次 BFF。
