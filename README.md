# BOOS Browser Extension

基于 `WXT + Vue 3 + Element Plus` 的 Chrome 扩展，用于在 BOSS 直聘候选人列表页面执行“读取简历 → LLM 判断 → 自动收藏”的半自动流程。

## 当前能力

- 目标站点检测：检测当前标签页域名是否匹配（默认 `www.zhipin.com`）
- 设置中心：
	- 基础设置（域名、候选人列表/简历/收藏按钮选择器）
	- 高级设置（LLM API Endpoint、API Key、模型、超时）
	- 全部持久化到 `localStorage`
- 主界面重构：右上角设置入口 + Prompt 输入 + 流程执行按钮
- 自动化编排：候选人列表读取、详情打开、简历抓取、收藏点击
- LLM 决策：将 `Prompt + 候选人摘要 + 简历文本` 发送到模型并解析收藏决策
- 反检测节流：每位候选人处理后随机等待 1-5 秒
- 失败可观测：站点不匹配、读取失败、LLM 失败等均有可读反馈

## 开发命令（pnpm）

- `pnpm install`：安装依赖
- `pnpm run dev`：启动 WXT 开发模式
- `pnpm run build`：构建 Chrome Manifest V3 产物
- `pnpm run typecheck`：执行 TypeScript 类型检查
- `pnpm run zip`：打包扩展产物

> 本项目约定使用 `pnpm`，不要使用 npm/yarn。

## 配置说明

在 popup 右上角点击“设置”可配置：

### 基础设置

- `targetDomain`：允许执行自动化流程的域名
- `candidateListItemSelector`：候选人列表项选择器
- `candidateNameSelector`：候选人姓名选择器
- `resumeContainerSelector`：在线简历容器选择器
- `favoriteButtonSelector`：收藏按钮选择器

### 高级设置

- `llmApiEndpoint`：大模型接口地址（建议兼容 Chat Completions）
- `llmApiKey`：调用密钥（保存在 `localStorage`）
- `llmModel`：模型名
- `llmRequestTimeoutMs`：模型请求超时
- `perCandidateTimeoutMs`：单候选人处理超时

## 验证记录

- `pnpm run typecheck` ✅
- `pnpm run build` ✅

## 说明与后续

- 当前默认选择器是通用兜底值，建议在真实 BOSS 页面根据 DOM 微调。
- API Key 当前存储在 `localStorage`，请在可信环境使用；后续可迁移到更安全的存储方案。