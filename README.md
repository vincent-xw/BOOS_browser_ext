# BOOS Browser Extension

基于 `WXT + Vue 3 + Element Plus` 的 Chrome 扩展，用于在 BOSS 直聘候选人列表页面执行“读取简历 → LLM 判断 → 自动收藏”的半自动流程。

## 当前能力

**自由指令（调试期主用）**

- 在允许的任意页面上，用一句自然语言下指令，agent 自己规划并执行
- 页面元素发现：`browser.snapshot` 列出可交互元素与 `ref` 编号，模型按 ref 指定目标而不猜选择器
- 多轮对话：同一会话内保持上下文，可以说「点第三条结果」「回到上一页」
- 逐步审批：读操作自动放行，写操作弹确认，可选「本次 / 本会话 / 该域名永久」三档授权
- 写操作双闸门：URL 白名单 + 逐步审批，两者默认都偏严

**BOSS 预设流程（保留）**

- 候选人列表读取、LLM 判定、真实收藏动作
- 等自由指令调到可用后再删

**公共基础**

- 页面交互：经 `chrome.debugger` + CDP 下发真实点击、中文输入与按键
- 结果验证：弹窗出现、DOM 变化、输入框内容、按钮可用性、网络请求是否成功返回
- 不持有模型凭据：Endpoint、模型名与 API Key 全部由 BFF 持有
- 失败可观测：定位失败、验证不通过、白名单拒绝、调试连接断开等均有可读反馈

## 开发命令（pnpm）

- `pnpm install`：安装依赖
- `pnpm run dev`：启动 WXT 开发模式
- `pnpm run build`：构建 Chrome Manifest V3 产物
- `pnpm run typecheck`：执行 TypeScript 类型检查
- `pnpm run zip`：打包扩展产物

> 本项目约定使用 `pnpm`，不要使用 npm/yarn。

## agent-kit 依赖

agent 能力来自同级仓库 `agent-kit`。开发期通过本地路径依赖，便于两侧改动即时联调：

```json
"@agent-kit/core": "file:../agent-kit/packages/core"
```

生产期改为 npm 版本号依赖。切换步骤：

1. 在 `agent-kit` 仓库执行 `pnpm build`，确认 `packages/*/dist` 产物齐全。
2. 在各包目录执行 `pnpm publish`（包已解除 `private`，并带 `publishConfig.access: public`）。
3. 本项目把 `file:../agent-kit/packages/core` 换成对应版本号，例如 `"@agent-kit/core": "^0.1.0"`。
4. `pnpm install && pnpm run typecheck`。

切换前后 **无需改动任何 `import` 语句** —— 两种方式解析到的都是 `@agent-kit/core` 这个包名。

## 配置说明

在侧边栏右上角点击“设置”可配置：

### 基础设置

- `targetDomain`：允许执行自动化流程的域名
- `candidateListItemSelector`：候选人列表项选择器
- `candidateNameSelector`：候选人姓名选择器
- `resumeContainerSelector`：在线简历容器选择器
- `favoriteButtonSelector`：收藏按钮选择器

### 高级设置

- `bffBaseUrl`：BFF 服务地址（默认 `http://localhost:8787`）
- `bffApiToken`：BFF 接入 token，**不是** LLM API Key
- `bffRequestTimeoutMs`：BFF 请求超时
- `perCandidateTimeoutMs`：单候选人处理超时

设置面板提供「检查 BFF 连通性」按钮，失败时会区分「地址不可达」与「凭据无效」。

> 模型 Endpoint、模型名与 API Key **不在扩展中配置** —— 它们只存在于 BFF 进程环境。
> 从旧版本升级时，扩展会自动清除 `localStorage` 里遗留的 API Key，需要把该 Key
> 重新配置到 BFF 的 `LLM_API_KEY` 环境变量。

## BFF 服务

agent 能力需要一个本地 BFF 进程。它持有模型配置并注册远端工具，扩展只作为 Tool Host。

首次准备：

```bash
cd ../agent-kit && pnpm install && cp examples/browser-extension-bff/.env.example examples/browser-extension-bff/.env
```

填好 `.env`（需要 `AGENT_KIT_MASTER_KEY`、`BFF_API_TOKEN`、`LLM_API_KEY`、`LLM_MODEL`）后启动：

```bash
cd ../agent-kit && pnpm dev:bff
```

`.env` 由 Node 原生 `--env-file` 加载，无需手动 source。`dev:bff` 带热重载（改 prompt 或
工具定义后自动重编重启），`start:bff` 是一次性启动。两者都会自动先编译依赖的 workspace 包。
默认监听 `http://localhost:8787`。

完整的环境变量清单与协议说明见 [agent-kit 的 BFF README](../agent-kit/examples/browser-extension-bff/README.md)。

## 权限说明

- `debugger`：页面写操作经 `chrome.debugger` + CDP 下发真实输入事件。
  DOM 合成事件的 `isTrusted` 为 `false`，无法触发目标站点依赖的真实焦点与 user activation。
  **代价**：任务运行时标签页顶部会出现「正在被调试」提示条。手动关闭它、或为该标签页
  打开开发者工具，都会中止当前任务 —— 这是浏览器的固有行为，无法消除。
- `webNavigation`：枚举 frame 以做跨 frame 聚合定位，避免退化为只读主 frame。

## 验证记录

- `pnpm run typecheck` ✅
- `pnpm test` ✅
- `pnpm run build` ✅

## 说明与后续

- 当前默认选择器是通用兜底值，建议在真实 BOSS 页面根据 DOM 微调。用户配置的选择器
  优先级高于内置兜底，无需改代码即可修正。
- 各验证维度的超时上限当前是保守估计值，需在真实页面实测后收敛
  （见 `openspec/changes/cdp-real-interaction-agent-kit/poc-notes.md`）。