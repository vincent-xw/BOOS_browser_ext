# Migrate UI to BFF + Iframe — Tasks

> 分支：agent-kit `feat/browser-bff-ws-executor` 与 BOOS `feat/iframe-bff-ui`。先做 agent-kit BFF 侧（向后兼容），再做 BOOS 插件侧。最终双仓本地联调。

## 1. agent-kit：BFF 前端工程（Vue 工程 + 复用原组件）

- [x] 1.1 在 `examples/browser-extension-bff/web/` 建 Vue 3 + Vite + Element Plus 工程（package.json、vite.config.outDir=dist-web、tsconfig、index.html、main.ts 全局注册图标）
- [x] 1.2 从 BOOS main 恢复并导入调试好的 `FreeFormPanel.vue` 模板/样式，拆分组件（FreeFormPanel / TurnItem / PlanCard / SkillPanel / FileManager / ToolsHelp），观感与交互不变
- [x] 1.3 实现 BFF 数据层 composable `useConversation`：turns/currentSteps/session/skill/file 状态 + 评估→计划→确认→执行 + SSE 订阅
- [x] 1.4 实现 `api.ts` 客户端：runAgent(POST /run)、loadMessages/loadSessions/deleteSession、skills CRUD、files list/upload/download/delete、getToken/sessionId 持久化
- [x] 1.5 实现 SSE 连接（tool_start/tool_end/step/done/executor_status），Markdown 渲染（marked+dompurify）、步骤摘要、诊断日志/消息复制
- [x] 1.6 BFF 静态托管 `dist-web/`：serve index.html + assets/*，正确 content-type；侧栏 iframe 用 `?token=` 注入鉴权
- [x] 1.7 `vite build` 产出经 `node --check`/构建验证通过，`vue-tsc` 通过

## 2. agent-kit：BFF 数据/接口补齐

- [x] 2.1 文件存储服务 `file-storage.ts`：文本/二进制/截图写磁盘目录 + `.meta.json`，提供 list/read/save/delete/download
- [x] 2.2 技能存储 `skill-store.ts`（SQLite）与会话 Meta `session-store.ts`（标题/自动命名/列表/删除）
- [x] 2.3 REST 接口：`GET/POST/DELETE /api/skills`、`GET/DELETE /api/sessions`、`GET/DELETE /api/files`、`GET /api/files/:id/download`、`POST /api/files/upload`
- [x] 2.4 文件工具 `browser_save_file/read_file/write_file` 改为 `execution:'server'` 在 server.ts 动态注册（写磁盘），截图由插件回 dataUrl → BFF 存盘回传 fileId
- [x] 2.5 覆盖 `/v1/agent/sessions/:id/run`：BFF 侧驱动工具循环（pending→WS 执行→resume→final），SSE 推 tool_start/tool_end/step/done
- [x] 2.6 `GET /api/sessions/:id/messages` 返回历史；注入 fileList 到 run 的 context
- [x] 2.7 更新 server.test.ts：文件工具数量/remote 断言、free-form prompt 含全工具名、全部编译 + 测试通过，flutter-dev-bff 零回归

## 3. BOOS 插件侧：侧栏 iframe + WS 执行器

- [x] 3.1 `App.vue` 简化为 iframe（src=`${BFF_BASE}/?token=…`）+ 齿轮设置 BFF 地址/token；`main.ts` 移除 element-plus
- [x] 3.2 manifest 加 CSP `frame-src http://localhost:8787`，更新插件描述；清理 element-plus/@element-plus-icons-vue/marked/dompurify 依赖（xlsx 若 toolExecutor 仍用则保留）
- [x] 3.3 background 接入 `wsExecutorClient`：connect、指数退避重连、register 上报 tabUrl/tabTitle、收发 tool_call/tool_result
- [x] 3.4 插件 `toolExecutor` 截图改为返回 dataUrl 给 BFF（不再存 IndexedDB）；文件工具不再由插件执行
- [x] 3.5 删除旧聊天组件、composables、chrome.storage/IndexedDB 存储、freeFormSessionStore/skillStore 等前端专用文件
- [x] 3.6 类型检查 + 现有测试通过 + 扩展构建通过

## 4. 双仓联调验证（OpenSpec 能力场景）

- [x] 4.1 启动 BFF，加载扩展侧栏，验证 bff-ui：评估→计划→确认→执行全流程 + SSE 实时步骤
- [x] 4.2 验证 browser-executor-ws：插件 background 收到 tool_call 执行 CDP 并回传；BFF 显示在线/离线
- [x] 4.3 验证会话切换/新建/删除、技能保存/加载/删除、文件上传/下载/勾选注入
- [x] 4.4 验证消息复制与错误诊断日志复制；截图生成与预览
- [x] 4.5 走查 extension-foundation / chrome-mcp-page-io 修改需求的场景全部可用