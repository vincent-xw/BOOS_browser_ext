# BOOS Browser Extension

基于 `WXT + Vue 3 + Element Plus` 的浏览器插件基础架构，用于验证通过 Chrome MCP 集成层执行页面读取与页面写入操作。

## 当前能力

- 提供一个可运行的 `popup` UI 入口
- 使用 Vue 3 与 Element Plus 构建基础壳层界面
- 提供统一的页面读写服务抽象层 `chromeMcpService`
- 优先接入 `window.chromeMcp` 桥接能力
- 当真实 MCP 桥不可用时，自动回退到 `chrome.tabs + chrome.scripting` 页面读写实现
- 在完全无扩展运行时能力的预览环境中，能够清晰展示不可用错误状态

## 开发命令

- `npm install`：安装依赖
- `npm run dev`：启动 WXT 开发模式
- `npm run build`：构建 Chrome Manifest V3 产物
- `npm run typecheck`：执行 TypeScript 类型检查
- `npm run zip`：打包扩展产物

## 项目结构

- `entrypoints/popup/`：popup 入口与页面样式
- `src/components/`：共享 UI 壳层组件
- `src/composables/`：页面读写状态控制逻辑
- `src/services/`：Chrome MCP 集成与页面 I/O 抽象层
- `src/types/`：共享类型定义
- `openspec/changes/bootstrap-browser-extension-mcp-foundation/`：本次变更的设计、规格与任务

## 验证结果

本次实现已完成以下验证：

- `npm run build` ✅
- `npm run typecheck` ✅
- popup 构建产物可正常渲染 ✅
- 页面读取/写入成功态（通过注入 mock `chromeMcp` 桥）✅
- 页面读取失败态（无可用运行时时的错误反馈）✅

## 后续扩展建议

- 增加 `background`、`sidepanel` 或 `options` 等入口
- 将真实 Chrome MCP 协议适配实现替换或补充到 `chromeMcpService`
- 按需引入状态管理、测试与发布流水线