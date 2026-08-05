export interface BasicSettings {
  targetDomain: string;
  candidateListItemSelector: string;
  candidateNameSelector: string;
  candidateOpenMode: 'click';
  resumeContainerSelector: string;
  favoriteButtonSelector: string;
}

export type ExportMode = 'processed' | 'all';

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
  perCandidateTimeoutMs: number;
  batchSize: number;
  exportMode: ExportMode;
}

export interface AppSettings {
  basic: BasicSettings;
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

export const DEFAULT_SETTINGS: AppSettings = {
  basic: {
    targetDomain: 'www.zhipin.com',
    candidateListItemSelector: 'li.card-item, .card-item, .job-card-wrapper, .candidate-item, .geek-item',
    candidateNameSelector: '.name, .geek-name, .candidate-name',
    candidateOpenMode: 'click',
    resumeContainerSelector:
      '.resume-item, .resume-detail-wrap, .geek-resume-container, .resume-box',
    favoriteButtonSelector:
      'button[ka=like], .btn-like, .btn-collect, .collect-btn, [data-action=favorite]',
  },
  advanced: {
    bffBaseUrl: 'http://localhost:8787',
    bffApiToken: '',
    bffRequestTimeoutMs: 60000,
    perCandidateTimeoutMs: 45000,
    batchSize: 10,
    exportMode: 'processed' as ExportMode,
  },
};
