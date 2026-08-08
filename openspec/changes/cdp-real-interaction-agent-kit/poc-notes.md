# POC 基准与决策记录

本文件记录 `cdp-real-interaction-agent-kit` 变更中 POC 阶段的选型，以及需要真机实测才能定稿的项。

## 基准页面与元素（任务 11.1）

「打招呼」按钮在三处出现，DOM 结构不同：推荐列表卡片内、搜索结果卡片内、在线简历弹窗内。

**选定基准：推荐列表卡片内的打招呼按钮。** 理由：

- 它是主工作流的入口，用户实际使用频率最高。
- 卡片是列表项，天然带 `index`，可用于验证「同一角色多个元素」的定位分支。
- 不依赖先打开详情弹窗，链路最短，POC 失败时排查面最小。

对应的角色与兜底选择器见 [domLocator.ts](../../../src/services/domLocator.ts) 的 `ROLE_FALLBACK_SELECTORS`：

| 角色 | 用途 |
|---|---|
| `greetButton` | 打招呼按钮 |
| `dialog` | 打招呼弹窗 |
| `messageInput` | 消息输入框 |
| `sendButton` | 发送按钮 |

这些兜底值来自通用推断，**真实 DOM 上很可能需要调整**。用户配置的选择器优先级高于兜底，因此无需改代码即可修正。

## agent 决策粒度（任务 11.7）

划分原则：**机械动作序列走固定规则，判定与异常处置进 agent。**

固定规则（[stepLoop.ts](../../../src/agent/stepLoop.ts)）承担：
- 打招呼链路的动作顺序（点按钮 → 输入 → 发送）
- 每步之前的重新定位与坐标重算
- 每步之后的验证维度组合

理由：这段序列是确定的，交给模型只会更慢、更贵、更不稳，且每轮 LLM 往返都是一次失败机会。

agent（[agentClient.ts](../../../src/agent/agentClient.ts) + BFF 侧 prompt）承担：
- 候选人是否值得跟进的判定
- 打招呼文案的生成
- 定位失败、被遮挡、验证不通过时的处置决策（换选择器？滚动？放弃该候选人？）

> 该划分是依据设计推导得出的初始方案。真机 POC 后若发现固定规则覆盖不足（例如站点在不同状态下动作顺序不同），应把顺序决策也上移给 agent。

## 待真机实测定稿

以下两项需要登录的真实账号，无法在开发环境完成。

### 任务 11.5：全链路真机验证

在 zhipin.com 推荐列表页依次确认：

1. 定位打招呼按钮 → CDP 点击
2. 验证弹窗出现、验证打招呼请求发出
3. 定位输入框 → CDP 点击 → `Input.insertText` 写入中文
4. 验证输入框内容、验证发送按钮变为可用
5. CDP 点击发送（或 Enter）
6. 验证消息发送请求成功返回

同时确认 `event.isTrusted` 为 `true`：在 DevTools Console 里对目标按钮
`addEventListener('click', e => console.log(e.isTrusted))`，再触发一次 CDP 点击。
这是整个方案成立与否的直接判据 —— 若为 `false` 则 CDP 通路没有真正生效。

### 任务 11.6：超时上限实测

当前各验证维度统一用 [cdp.ts](../../../src/types/cdp.ts) 的 `DEFAULT_VERIFY_TIMEOUT_MS = 5000`，
轮询间隔 `VERIFY_POLL_INTERVAL_MS = 120`。这个 5000 是保守估计，**不是实测值**
（它替代的是原实现里同样拍定的 `setTimeout(1400)`）。

需采集的分布：

| 观测项 | 用途 |
|---|---|
| 点击打招呼按钮 → 弹窗可见 | `expectDialog` 超时上限 |
| `insertText` → 输入框值更新 | `expectInputValue` 超时上限 |
| 输入完成 → 发送按钮变可用 | `expectButtonEnabled` 超时上限 |
| 点击发送 → 请求发出 | `expectNetwork` 超时上限 |
| 请求发出 → 响应返回 | `expectNetwork` 成功判定窗口 |

建议各跑 10 次取 P95，再留一倍余量。若某维度 P95 明显超过其他维度，应给它单独的上限而不是统一值。
