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
  },
};
