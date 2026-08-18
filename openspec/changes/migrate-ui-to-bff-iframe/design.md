# Migrate UI to BFF + Iframe — Design

## Context

现状：BOOS 浏览器插件在进程内跑一套 Vue 3 + Element Plus 聊天 UI，通信基于**接口轮询**——插件 `runAgentSession` 循环 `POST /run` → `pending_tool_calls` → 执行 CDP → `POST /tool-results` → 直到 `final`。模型思考期间 UI 黑盒。agent-kit 的 `examples/browser-extension-bff` 已具备 BFF 侧工具循环、SSE `/api/events`、WS `/api/executor`、ContextManager、SQLite 持久化等基础设施，但尚无托管前端工程。

约束（来自历史讨论）：
- 复用已在 main 调试好的 Vue 组件（FreeFormPanel 等），UI 风格与交互保持一致，不做视觉重设计。
- 审批门、URL 白名单已明确移除，不恢复。
- 改动分属两个 Feature 分支，agent-kit 与 BOOS 各自建分支，不轻合 main。
- 改动目标仓库：agent-kit（BFF 侧）与 BOOS_browser_ext（插件侧）。

## Goals / Non-Goals

**Goals:**
- 把聊天 UI 与上下文管理整体迁到 BFF，插件侧栏 iframe 嵌入。
- 用 SSE 实时显示模型思考与工具执行进度，替代轮询黑盒。
- 会话、技能、文件、截图持久化迁到 BFF（SQLite + 磁盘）。
- 复用原 Vue 组件，保持 Vue 3 + Element Plus 观感与"评估→计划→确认→执行"交互。
- 插件侧只做页面 DOM 获取 + CDP 操作执行。

**Non-Goals:**
- 不做视觉重设计，不改交互范式（保留原评估/计划流程）。
- 不实现审批门 / URL 白名单。
- 不做多客户端并发（一个 BFF 一个插件执行器）。
- 不做流式文本逐 token 渲染（SSE 只推工具事件，assistant 最终文本在 done 时整段到达）。
- 不迁移插件侧的文件拖拽上传之外的复杂文件能力。

## Decisions

### D1 — 前端采用正式 Vue 3 + Vite 工程，复用原组件
在 BFF 下建 `web/` 工程（Vue3 + Element Plus + marked + dompurify），把 `main` 里已调好的 `FreeFormPanel.vue` 的模板/样式拷入并拆分为组件，数据层换成 BFF 版 composable。`vite build` 产物输出到 `dist-web/`，由 BFF 静态托管。依赖本地打包，**不使用 CDN**（避免运行时依赖外网）。

- **备选**：继续 CDN 单文件内联脚本。否决原因：依赖外网、难测试、难维护，用户明确否决。
- **备选**：从零重写组件。否决原因：浪费既有打磨成果，用户要求复用。

### D2 — 通信模型：POST /run（BFF 侧驱动工具循环）+ SSE /api/events + WS /api/executor
- 前端发消息 → `POST /v1/agent/sessions/:id/run`，BFF 侧 `harness.run→pending_tool_calls→(WS 执行)→resume→…直到 final`，一次性返回 final 结果。
- 思考/进度 → 前端订阅 SSE `/api/events`，收到 `tool_start/tool_end/step/done` 实时更新 UI。
- 页面工具 → BFF 通过 WS 把 `tool_call` 发给插件 background 的 `wsExecutorClient`，插件执行 CDP/DOM 并回传 `tool_result`。

- **备选**：SSE 也承载消息发送（全双工）。否决：改动 BFF 核心路由、风险大，且 harness 是 HTTP run 模型。

### D3 — 数据存储：SQLite（结构化）+ 磁盘目录（二进制）
- 会话消息（已有 `agent_sessions`）、会话 Meta、技能 → BFF 的 SQLite。
- 文件 / 截图（base64/二进制）→ BFF `data/files` 磁盘目录，带 `.meta.json` 元数据。
- BFF 提供文件上传/下载/删除与技能/会话 CRUD 接口。

- **备选**：文件二进制也存 SQLite BLOB。否决：SQLite 文件膨胀、读写慢，不利大截图。

### D4 — 插件降级为"ifarme 容器 + WS 执行器"
- 侧栏 `App.vue` 简化为 iframe 嵌入 `${BFF_BASE}/?token=…`，保留齿轮设置 BFF 地址/token。
- background 保留 `toolExecutor`、CDP 会话、DOM 定位、frame 聚合、content script；新增 `wsExecutorClient` 负责 register 与收发 tool_call/result。
- 删除旧聊天组件、composables、chrome.storage/IndexedDB 存储、element-plus/marked/dompurify/xlsx 前端依赖。
- manifest 配置 CSP `frame-src http://localhost:8787`。

### D5 — 文件工具改为 BFF server 端执行
`browser_save_file/read_file/write_file` 从 `execution:'remote'` 改为 BFF server 工具，直接写/读 `data/files`，不再依赖插件 IndexedDB。截图由插件返回 dataUrl，BFF 存盘并回传 fileId。

## Risks / Trade-offs

- [BFF 未运行时 iframe 白屏] → 侧栏容器检测加载失败并显示"BFF 不可达"提示；配置入口仍可用。
- [SSE 与 HTTP run 并发连接多] → 单一用户场景，SSE 只在会话页打开时建立；断线自动重连。
- [WS executor 在 MV3 Service Worker 休眠时断连] → 指数退避重连 + 心跳；BFF 侧记录 executor_status 供 UI 指示。
- [两个仓库同时改，协同接口漂移] → 先锁接口契约（SSE 事件名、WS 消息、REST 路径），两个分支按契约各自实现，关键接口以 agent-kit 为准。
- [数据迁移：旧 IndexedDB/chrome.storage 数据无法自动搬到 BFF] → 旧 uid 会话/文件在迁移窗口内不可直接恢复，用户视为历史数据；不实现自动迁移（量小、频低）。

## Migration Plan

分两条 Feature 分支，互不阻赛本地联调：

1. **agent-kit `feat/browser-bff-ws-executor`**：
   - 建 `web/` Vue 工程并复用原组件，`vite build` 到 `dist-web/`。
   - BFF 静态托管 `dist-web/`（含 content-type、SPA fallback）。
   - 补齐文件/技能/会话接口、SSE run 路由、文件工具 server 化。
   - 全部编译 + 测试通过，flutter-dev-bff 零回归。

2. **BOOS `feat/iframe-bff-ui`**：
   - 侧栏改 iframe；background 接 WS executor；删除旧 UI/存储/依赖；manifest CSP。
   - 类型检查 + 现有测试通过。

联调：`pnpm install && pnpm build` 双仓本地 link，启动 BFF，加载扩展，走通"评估→计划→确认→执行→文件下载→切会话→加载技能"整条路径。

合入顺序：先合 agent-kit（向后兼容），再合插件。不 force push。

## Open Questions

已确认（用户拍板）：
- 不保留页面上下文顶栏展示。BFF UI 不展示当前页面标题/URL 提示区块。
- 不迁移旧会话历史。迁移前存在插件 chrome.storage 的会话作为历史数据留存，不导入 BFF。