# BOOS Browser Extension — Agent Instructions

浏览器插件项目，基于 WXT + Vue 3 + Element Plus，用于通过 Chrome MCP 集成层执行页面读写操作。

## 包管理器

**必须使用 pnpm**，不要使用 npm 或 yarn。

```bash
pnpm install          # 安装依赖
pnpm run dev          # 启动开发模式（WXT）
pnpm run build        # 构建 Chrome MV3 产物 → .output/chrome-mv3/
pnpm run typecheck    # TypeScript 类型检查（vue-tsc）
pnpm run zip          # 打包扩展产物
```

> 首次安装后如果遇到 `rolldown` 原生 binding 缺失错误，运行 `pnpm approve-builds` 批准所有条目。

## 项目结构

```
entrypoints/popup/        # Popup 入口（当前唯一 UI 入口）
src/
  components/             # 共享 UI 组件（ExtensionAppShell.vue 为壳层）
  composables/            # 状态控制逻辑（usePageIoController.ts）
  services/               # Chrome MCP 集成（chromeMcpService.ts）
  types/                  # 共享 TS 类型（page-io.ts）
  env.d.ts                # 全局类型声明（chrome、CSS 模块）
wxt.config.ts             # WXT 构建与 Manifest 配置
openspec/changes/         # OpenSpec 变更文档（设计、规格、任务）
```

## 关键约定

- **UI 技术栈**：Vue 3 组合式 API + Element Plus，所有界面元素统一使用这两个库。
- **页面 I/O**：组件和 composable **不得**直接调用 `chrome.*` 或 `window.chromeMcp`，必须通过 `chromeMcpService`。
- **MCP 桥接**：优先使用 `window.chromeMcp`；不可用时自动回退到 `chrome.tabs + chrome.scripting`。
- **操作状态**：所有页面读写操作必须暴露 `idle | running | succeeded | failed` 四态。
- **新增 UI 入口**：在 `entrypoints/<name>/` 下添加，共享模块从 `src/` 导入，无需修改现有入口。

## 构建注意事项

- 目标平台：Chrome Manifest V3（`wxt.config.ts` 中配置）。
- pnpm 需配合 `.npmrc` 中的 `node-linker=hoisted`，确保 `rolldown` 原生 binding 可被找到。
- 类型声明来自 `src/env.d.ts`（chrome 全局类型 + CSS/SCSS 模块声明）。

## 规格文档

本项目采用 OpenSpec 管理变更流程，规格文档位于：

- [设计文档](openspec/changes/bootstrap-browser-extension-mcp-foundation/design.md)
- [extension-foundation spec](openspec/changes/bootstrap-browser-extension-mcp-foundation/specs/extension-foundation/spec.md)
- [chrome-mcp-page-io spec](openspec/changes/bootstrap-browser-extension-mcp-foundation/specs/chrome-mcp-page-io/spec.md)
