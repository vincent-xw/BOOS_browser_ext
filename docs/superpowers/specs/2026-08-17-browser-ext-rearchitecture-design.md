---
title: "浏览器插件架构重构：BFF Web UI + WebSocket 执行器"
status: draft
created: 2026-08-17
---

## 1. 动机

当前浏览器插件（BOOS_browser_ext）的聊天上下文管理体验差，与 Flutter BFF 对比后发现核心差距：

- **缺乏实时反馈**：Flutter BFF 有 SSE 事件流推送工具执行进度，浏览器插件只能等几十秒看到整段回复
- **上下文窗口不可控**：插件侧不知道 BFF 服务端历史何时截断，长会话体验差
- **UI 与业务逻辑耦合**：聊天 UI、会话管理、工具执行全部在插件 sidepanel 里，Vue + Element Plus 依赖沉重

解决方案：把聊天 UI 和上下文管理挪到 BFF，插件只做浏览器页面 DOM 获取和 Action 派发。

## 2. 架构概览

三条通道、各司其职：

```
┌─────────────────────────────────────────────────────┐
│  Sidepanel (扩展 iframe)                             │
│  ┌───────────────────────────────────────────────┐  │
│  │ <iframe src="http://localhost:8787">          │  │
│  │   BFF Web UI（聊天、历史、进度、设置）          │  │
│  └───────────────────────────────────────────────┘  │
│  同源 HTTP + SSE（不经插件转发）                      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  BFF (localhost:8787)                                │
│  ├─ Web UI 服务（GET / → index.html）               │
│  ├─ HTTP API（POST /v1/agent/sessions/:id/run）    │
│  ├─ SSE 事件流（GET /api/events）                   │
│  ├─ 消息历史（GET /api/sessions/:id/messages）      │
│  ├─ AgentHarness + ContextManager (滑动窗口裁剪)    │
│  ├─ SQLite 持久化（adapter-sqlite）                 │
│  └─ WebSocket 执行器（/api/executor）               │
│      持有 LLM Key                                   │
└──────────────────────┬──────────────────────────────┘
                       │ WebSocket：ToolCall → result
                       │
┌──────────────────────▼──────────────────────────────┐
│  Background Service Worker (扩展)                     │
│  ├─ wsExecutorClient（WS 连接/重连/callId 关联）     │
│  ├─ toolExecutor（白名单，无审批）                    │
│  ├─ cdpSessionManager（CDP 调试会话）                │
│  ├─ cdpActionService（CDP action 派发）              │
│  └─ Content Script 通信（domLocator/refIndex）        │
└─────────────────────────────────────────────────────┘
```

## 3. 通道职责

### 通道 1：UI ↔ BFF（HTTP + SSE，同源）

| 方向 | 方式 | 用途 |
|------|------|------|
| UI → BFF | POST /v1/agent/sessions/:id/run | 发送消息（stepMode=true） |
| UI → BFF | POST /continue | 推进 step（agent 回复后） |
| UI → BFF | GET /api/sessions/:id/messages | 恢复历史 |
| BFF → UI | SSE /api/events | 推送工具进度、step 完成、错误 |

事件契约：

```
event: tool_start    data: { callId, name, input, sessionId, ts }
event: tool_end      data: { callId, name, ok, outputPreview, durationMs, ts }
event: step          data: { index, total, sessionId }
event: done          data: { sessionId, finishReason }
event: error         data: { code, message, sessionId }
event: executor_status  data: { online, client, tab }
```

### 通道 2：插件 Background ↔ BFF（WebSocket，工具执行专用）

- BFF 新增 `GET /api/executor`（WS upgrade），Bearer token 鉴权
- Background 主动连接，发 `register` 声明能力
- 模型决定调 remote 工具时，BFF 通过 WS 推完整 ToolCall（callId, name, input）
- 插件执行后回 `{callId, output}` 或 `{callId, error}`
- BFF 用 correlationId 匹配 Promise，对 harness 透明

### 通道 3：插件内部（保持现状）

- Background ↔ Content Script：`chrome.runtime.sendMessage`
- Content Script 只读 DOM，写操作经 CDP
- `domLocator`、`refIndex`、`frameAggregator` 完全不动

## 4. agent-kit 改动

### 4.1 core 包

新增 `RemoteToolExecutor` 接口：

```ts
interface RemoteToolExecutor {
  executeTool(call: {
    callId: string
    name: string
    input: unknown
    sessionId: string
    signal?: AbortSignal
  }): Promise<unknown>
}
```

`AgentHarness` 行为变更：remote 工具优先走 executor（如果注入），无 executor 则回退现有 pending/resume 路径。

`ContextManager` 暴露默认配置（maxHistoryPairs、摘要阈值），供 sqlite adapter 可选注入。

### 4.2 adapter-sqlite 包

`createSqliteAgentRuntime` 新增可选参数：
- `contextManager?: ContextManager` — 不传行为不变
- `remoteExecutor?: RemoteToolExecutor` — 不传行为不变

### 4.3 bff-hono 包

`createAgentBff` 新增可选字段：
- `websocket?: { authenticate: ... }` — 传了就在 `/api/executor` 开 WS，不传则不开（flutter-bff 零影响）
- `eventBus?: EventBus` — 传了就挂 SSE 和消息历史路由，不传不挂

工具执行事件通过 harness 可选 hook 注入（`runtime.hooks.onToolStart/onToolEnd`）。

## 5. 浏览器插件改动

### 5.1 Sidepanel

- `App.vue` 简化为全屏 `<iframe :src="bffUrl">`
- 删除：`FreeFormPanel.vue`、`SkillPanel.vue`、`useFreeFormController.ts`、`useSkillController.ts`、`useFileAttachments.ts`、`freeFormSessionStore.ts`
- 消息相关类型定义从 `messages.ts` 中移除
- 依赖删除：`element-plus`、`element-plus/icons-vue`、`marked`、`dompurify`、`xlsx`（设置功能移入 BFF Web UI，插件侧不再保留设置面板）
- `manifest.json` 中 sidepanel 页加 `content_security_policy.frame-src http://localhost:8787`

### 5.2 Background

- 新增 `src/agent/wsExecutorClient.ts`：WS 连接管理、重连（指数退避 1s→2s→4s→上限15s）、callId 关联、超时（默认 60s）
- 删除 `agentClient.ts` 中的 run/tool-results 轮询循环
- 删除 `approvalGate.ts`
- 删除 `urlAllowlist.ts`、`requireAllowedUrl()`、`requireWritable()` 中的 URL 校验
- 保留 `toolExecutor.ts` 工具名白名单（仅过滤不认识的工具名，不再做 URL 审批）
- 保留 CDP 会话管理、DOM 定位器、frame 聚合、ref 索引

### 5.3 Content Script

完全不动。

## 6. 错误处理

| 场景 | 处理 |
|------|------|
| WS 断线 | 指数退避重连，chrome.alarms 20s 心跳防 MV3 休眠 |
| 工具超时 | BFF 侧 60s 超时，返回 `{ok:false, error:'EXECUTOR_TIMEOUT'}` 喂回模型 |
| BFF 重启 | UI 发消息失败，显示重连；SQLite 持久化，历史不丢 |
| 插件中途 reload | 断 WS，BFF 侧 Promise 超时，`sanitizeIncompleteRounds` 裁掉悬空消息 |
| 多个 executor 同时连 | 新连接踢掉旧连接，广播 `executor_status: {online: false}` |
| BFF 崩溃中途 | 重启后 harnees 裁掉悬空 assistant 轮次，用户重发消息即可 |

## 7. BFF Web UI 设计

单文件 `public/index.html`（纯 HTML+CSS+JS，无构建），适配 320-600px 窄屏：

- 消息列表：用户气泡 + assistant markdown 渲染 + 工具调用折叠卡片（名称、入参、耗时、成功/失败、输出预览）
- 工具卡片：长内容截断 + 可展开查看完整输出
- 输入框 + 发送 + 停止按钮
- 顶部栏：会话 ID、新建会话、模型状态指示灯（WS 执行器在线/离线）、设置入口
- 设置：BFF token（可由 iframe URL query 注入）
- Prompt 选择器（free-form / planning / browser-automation / candidate-assessment）

流式 assistant 文本：MVP 不做（完整文本在 step 或 done 事件时一次性到达）。

## 8. 范围外（YAGNI，明确不做）

- 流式 assistant 文本回复
- 细粒度审批 / 域名白名单
- 远程部署 BFF（仅 localhost）
- 多 executor 并发（一个 BFF 一个 executor）
- 移动端 / Firefox 适配
- 设置界面（BFF token 通过 iframe query 注入，插件只需配置 BFF 地址）

## 9. 分支与发布策略

| 仓库 | 分支名 | 基分支 |
|------|--------|--------|
| agent-kit | `feat/browser-bff-ws-executor` | main |
| BOOS_browser_ext | `feat/iframe-bff-ui` | main |

合入顺序：先合 agent-kit（向后兼容），再合插件。不允许 force push。合并后通过 release notes 说明架构变更、用户需升级 BFF 版本。