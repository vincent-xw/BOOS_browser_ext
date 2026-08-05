# BOOS Browser Extension — Agent Instructions

浏览器插件项目，基于 WXT + Vue 3 + Element Plus。页面读取走 DOM，页面写入走 `chrome.debugger` + CDP 真实事件。

## 包管理器

**必须使用 pnpm**，不要使用 npm 或 yarn。

```bash
pnpm install          # 安装依赖
pnpm run dev          # 启动开发模式（WXT）
pnpm run build        # 构建 Chrome MV3 产物 → output/chrome-mv3/
pnpm run typecheck    # TypeScript 类型检查（vue-tsc）
pnpm test             # 单元测试（vitest）
pnpm run zip          # 打包扩展产物
```

> 首次安装后如果遇到 `rolldown` 原生 binding 缺失错误，运行 `pnpm approve-builds` 批准所有条目。

## 项目结构

```
entrypoints/
  background.ts           # Service Worker：消息路由 + CDP 会话管理
  content.ts              # content script：只读（定位、坐标、验证）
  sidepanel/              # 侧边栏 UI 入口（当前唯一 UI 入口）
src/
  agent/                  # Tool Host：BFF 客户端、工具执行、单步闭环
  components/             # 共享 UI 组件（ExtensionAppShell.vue 为壳层）
  composables/            # 状态控制逻辑（usePageIoController.ts）
  services/               # 页面能力（chromeMcpService 读取、cdpSessionManager 写入、domLocator 定位）
  types/                  # 共享 TS 类型（page-io.ts、cdp.ts、messages.ts、settings.ts）
  env.d.ts                # 全局类型声明（chrome、CSS 模块）
wxt.config.ts             # WXT 构建与 Manifest 配置
openspec/changes/         # OpenSpec 变更文档（设计、规格、任务）
```

## 两条执行路径

**自由指令（调试期主用）**：用户下一句自然语言，agent 自己规划动作序列。
入口 `src/composables/useFreeFormController.ts` + `src/components/FreeFormPanel.vue`。
模型先调 `browser_snapshot` 看清页面，再用返回的 `ref` 指定目标——不写选择器。

**BOSS 预设流程（保留）**：`src/agent/stepLoop.ts` 与 `src/services/cdpActionService.ts`
里写死的动作序列。等自由指令调到可用后再删。

## 关键约定

- **UI 技术栈**：Vue 3 组合式 API + Element Plus，所有界面元素统一使用这两个库。
- **页面写操作只走 CDP**：所有点击、输入、按键 **必须** 经 Service Worker 的
  `chrome.debugger` + CDP `Input` 域下发。**禁止** 使用 `element.click()`、
  `element.dispatchEvent()`、`input.value = ...`、`element.textContent = ...` —— 这些是
  DOM 合成事件，`isTrusted` 为 `false`，触发不了真实焦点流转与 user activation。
- **content script 只读**：`entrypoints/content.ts` 只负责 DOM 读取、元素定位、坐标计算
  与结果验证，不得出现任何写操作代码路径。把写能力从这里物理移除，是让上一条约定
  可被审查而不只靠记性的唯一办法。
- **坐标契约**：相对主页面 viewport 的 CSS 像素，**不乘 `devicePixelRatio`**。
  乘错在 Retina 上会点到约两倍偏移处，而且通常仍落在某个元素上 —— 症状是「点了但点错」
  而非报错，人工极难发现。改动坐标相关代码务必跑 `src/services/coordinates.test.ts`。
- **ref 与坐标的分工**：`ref` 稳定、坐标易失效。动作工具接受 `ref` 时由
  `toolExecutor` 在下发前重新解析坐标，「每步重算坐标」由执行侧保证，而不是指望模型自觉。
  元素已卸载时返回 `stale`，模型应重新快照而不是重试同一个 ref。
- **验证不靠命令返回值**：动作后必须独立验证（弹窗/DOM/输入框/按钮可用/网络请求）。
  「命令没报错」不是成功判据。
- **跨 frame 聚合取最优**：读取与定位在所有 frame 执行后按评分取最优，**不得** 退化为
  只读主 frame。注意 `chrome.tabs.sendMessage` 不带 `frameId` 时只返回第一个应答的
  frame —— 那就是被禁止的退化行为。快照是**合并**所有 frame 而非取最优，因为模型需要看到整页。
- **写操作双闸门**：URL 白名单（`src/services/urlAllowlist.ts`）+ 逐步审批
  （`src/agent/approvalGate.ts`）。白名单校验 **必须** 在 Service Worker 侧
  （`background.ts` 的 `requireWritable`）—— 放 UI 侧的话绕过 UI 直接发消息就失效了。
  两者的默认都偏严：空白名单拒绝一切、无审批界面时拒绝写操作。
- **页面 I/O**：组件和 composable **不得** 直接调用 `chrome.*`，必须通过 `src/services/` 下的服务。
- **不持有模型凭据**：扩展 **不得** 保存 LLM Endpoint、模型名或 API Key，也不得直连模型接口。
  这些由 BFF 持有，扩展只作为 Tool Host 执行白名单内的远端工具。
- **操作状态**：所有页面读写操作必须暴露 `idle | running | succeeded | failed` 四态。
- **新增 UI 入口**：在 `entrypoints/<name>/` 下添加，共享模块从 `src/` 导入，无需修改现有入口。

## agent 能力

agent 运行时来自同级仓库 `agent-kit`（`@agent-kit/core`），开发期以 `file:` 路径依赖。
BFF 基于 `agent-kit/examples/browser-extension-bff`，持有模型配置并注册远端工具。
详见 [README](README.md#agent-kit-依赖) 与该 example 的 README。

## 构建注意事项

- 目标平台：Chrome Manifest V3（`wxt.config.ts` 中配置）。
- pnpm 需配合 `.npmrc` 中的 `node-linker=hoisted`，确保 `rolldown` 原生 binding 可被找到。
- 类型声明来自 `src/env.d.ts`（chrome 全局类型 + CSS/SCSS 模块声明）。
- 权限说明：`debugger` 用于真实输入事件，`webNavigation` 用于枚举 frame 做聚合定位。

## 规格文档

本项目采用 OpenSpec 管理变更流程。当前主规格位于 `openspec/specs/`，
在途变更位于 `openspec/changes/`。
