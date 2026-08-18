# Migrate UI to BFF + Iframe

## Why

浏览器插件的聊天 UI 目前跑在插件进程内（Vue 3 + Element Plus），通信依赖**接口轮询**：插件 `runAgentSession` 循环 `POST /run` → 拿到 `pending_tool_calls` → 插件逐个执行 CDP → `POST /tool-results` 回填 → 再调 `/run` 直到 `final`。每轮一次 HTTP 往返，模型思考过程中 UI 处于黑盒等待，体验差。

目标是把聊天 UI 和上下文管理迁到 BFF，利用 BFF 已有的 **SSE 事件流**实时显示模型的思考与工具执行进度，前端页面通过 iframe 嵌回浏览器插件。插件只保留浏览器页面 DOM 获取与 CDP 操作执行。

## What Changes

- **BREAKING · 前端位置移动**：聊天 UI 从插件进程迁到 BFF 下的正式 Vue 3 + Vite 项目，构建产物由 BFF 静态托管，插件侧栏改为 iframe 嵌入。
- **BREAKING · 通信模式**：发送消息改为 `POST /run`（BFF 侧驱动工具循环），不再插件轮询回填；模型思考与工具进度通过 SSE `/api/events` 实时推送给前端。
- **通信模式**：页面工具执行通过 WebSocket `/api/executor` 下发到插件 background，插件执行 CDP/DOM 操作并回传结果。
- **BREAKING · 数据存储**：原 chrome.storage / IndexedDB 的会话、技能、文件、截图迁到 BFF（SQLite 存结构化数据 + 磁盘目录存二进制文件），BFF 提供文件上传/下载接口。
- **移除**：审批门（写操作审批）与 URL 白名单（域名授权），插件只按 BFF 下发的工具名执行。
- **保留**：插件侧 toolExecutor、CDP 会话、DOM 定位器、frame 聚合、content script（页面操作执行层）。

## Capabilities

### New Capabilities
- `bff-ui`: BFF 承载的 Vue 3 + Element Plus 聊天页面，含模型思考/工具进度的 SSE 实时展示、会话/技能/文件管理，通过 iframe 嵌入浏览器插件。
- `browser-executor-ws`: 插件 background 的 WebSocket 执行器，接收 BFF 下发的 tool_call，执行页面 DOM/CDP 操作并回传结果。

### Modified Capabilities
- `extension-foundation`: UI 壳层的渲染位置从插件进程改为 BFF + iframe 嵌入；通信从接口轮询改为 POST /run + SSE 推送。Vue 3 + Element Plus 技术栈不变。
- `chrome-mcp-page-io`: 页面读写执行层保留在插件侧，但调用入口从插件 UI 直接调用改为经由 WS executor 由 BFF 触发。

## Impact

- **仓库**：agent-kit（BFF 侧 `examples/browser-extension-bff`）与 BOOS_browser_ext（插件侧）都需要改动，分属两个 Feature 分支。
- **BFF**：新增前端工程（Vue+Vite）、静态托管与文件/技能/会话接口、SSE run 路由；`browser-tools.ts` 文件工具改为 server 端。
- **插件**：侧栏改为 iframe；background 新增 wsExecutorClient 作为执行器；删除旧聊天组件、composables、chrome.storage/IndexedDB 存储；清理 element-plus/marked/dompurify/xlsx 等前端依赖。
- **依赖**：BFF 新增 vue/element-plus/marked/dompurify/vite 构建链；插件大幅削减前端依赖。