export interface BasicSettings {
  targetDomain: string;
  candidateListItemSelector: string;
  candidateNameSelector: string;
  candidateOpenMode: 'click';
  resumeContainerSelector: string;
  favoriteButtonSelector: string;
}

export type ExportMode = 'processed' | 'all';

export interface AdvancedSettings {
  llmApiEndpoint: string;
  llmApiKey: string;
  llmModel: string;
  llmRequestTimeoutMs: number;
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
}

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
    llmApiEndpoint: '',
    llmApiKey: '',
    llmModel: 'gpt-4o-mini',
    llmRequestTimeoutMs: 30000,
    perCandidateTimeoutMs: 45000,
    batchSize: 10,
    exportMode: 'processed' as ExportMode,
  },
};
