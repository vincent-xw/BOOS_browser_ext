## Why

当前插件仅具备基础页面读写能力，不支持针对 BOSS 直聘候选人列表的自动化筛选与收藏流程，也缺少可配置的站点与大模型参数管理入口。随着用户准备进入真实业务场景，需要将“页面读取 → 候选人评估 → 自动收藏”的闭环能力落地，以减少重复人工操作并提升筛选效率。

## What Changes

- 新增站点检测能力：支持检测当前标签页域名是否匹配用户配置的目标站点（默认 `www.zhipin.com`）。
- 新增设置中心：提供“基础设置（如目标域名）”与“高级设置（大模型 API Key 与相关配置）”两类配置项，并统一存储在 `localStorage`。
- 调整主界面：在右上角增加设置入口；移除现有非预期内容，改为提示词输入区作为主交互入口。
- 新增自动化处理流程：通过 Chrome DevTools MCP（优先）/现有 MCP 集成层读取牛人列表、逐项打开在线简历、结合用户输入 prompt 调用大模型 API 进行收藏判断，并在判定为值得收藏时触发页面收藏操作。
- 新增反检测节流策略：每次候选人处理完成后随机等待 1-5 秒，再继续下一位候选人。
- 明确流程边界：本期假定用户已在 BOSS 直聘候选列表并已配置筛选条件，不覆盖筛选条件构建逻辑。

## Capabilities

### New Capabilities
- `boss-zhipin-ai-favorite-workflow`: 定义从候选人列表读取、简历抓取、LLM 判断到自动收藏与随机间隔执行的端到端业务流程。
- `extension-settings-management`: 定义插件内基础/高级设置模型、设置 UI 结构、设置入口与 `localStorage` 持久化行为。

### Modified Capabilities
- `extension-foundation`: 主界面信息架构从展示型内容调整为“prompt 输入 + 设置入口 + 状态反馈”的任务驱动布局。
- `chrome-mcp-page-io`: 从通用单次读写扩展为支持多步骤页面交互编排（列表读取、详情读取、收藏点击）及可观测流程状态。

## Impact

- 受影响代码：`entrypoints/popup/*`、`src/components/*`、`src/composables/usePageIoController.ts`、`src/services/chromeMcpService.ts`、`src/types/page-io.ts`。
- 新增模块：设置存储/读取服务、候选人自动处理编排逻辑、大模型 API 调用适配层。
- 依赖与系统：继续使用 Vue 3 + Element Plus + Chrome 扩展 API；需要外部大模型 API 可用与有效 API Key。
- 行为影响：自动化点击与页面读取将增加页面交互频率，需要随机等待机制降低机器人检测风险。
