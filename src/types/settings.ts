/**
 * 高级设置。
 *
 * 这里**不包含** LLM Endpoint、模型名与 API Key —— 模型凭据只存在于 BFF 进程环境。
 * bffApiToken 是访问 BFF 的接入凭证，不是 LLM API Key。
 */
export interface AdvancedSettings {
  bffBaseUrl: string;
  bffApiToken: string;
  bffRequestTimeoutMs: number;
  /** 任务执行最大步数，防止模型无限循环。默认 50。 */
  maxSteps: number;
  /** LLM 请求最大重试次数（0-5），默认 3。只重试网络错误与 5xx/429。 */
  llmMaxRetries: number;
  /** 是否启用审批。关闭后所有写操作自动放行，不再弹出审批对话框。 */
  approvalEnabled: boolean;
}

export interface AppSettings {
  advanced: AdvancedSettings;
}

export interface SettingsValidationResult {
  valid: boolean;
  issues: string[];
  normalized: AppSettings;
  /** 从旧版本配置中清除的已废弃字段。存在值即说明发生过迁移。 */
  migratedAwayFields?: string[];
}

/** 已废弃的模型配置字段。读取旧配置时必须清除，尤其是 API Key。 */
export const DEPRECATED_ADVANCED_FIELDS = ['llmApiEndpoint', 'llmApiKey', 'llmModel', 'llmRequestTimeoutMs'] as const;

/**
 * 已废弃的 BOSS 预设流程配置。
 * 动作序列现在由 agent 自行规划，不再需要写死的选择器与批量参数。
 */
export const DEPRECATED_BOSS_FIELDS = [
  'perCandidateTimeoutMs',
  'batchSize',
  'exportMode',
] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  advanced: {
    bffBaseUrl: 'http://localhost:8787',
    bffApiToken: '',
    bffRequestTimeoutMs: 60000,
    maxSteps: 50,
    llmMaxRetries: 3,
    approvalEnabled: true,
  },
};
