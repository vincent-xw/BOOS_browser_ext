import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsValidationResult,
} from '../types/settings';

const SETTINGS_STORAGE_KEY = 'boos-extension:settings';

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function validateSettings(raw: unknown): SettingsValidationResult {
  const issues: string[] = [];
  const normalized = cloneDefaults();

  const root = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const basic =
    typeof root.basic === 'object' && root.basic !== null
      ? (root.basic as Record<string, unknown>)
      : {};
  const advanced =
    typeof root.advanced === 'object' && root.advanced !== null
      ? (root.advanced as Record<string, unknown>)
      : {};

  if (typeof basic.targetDomain === 'string' && basic.targetDomain.trim()) {
    normalized.basic.targetDomain = basic.targetDomain.trim();
  } else {
    issues.push('基础设置目标域名缺失，已回退默认值。');
  }

  if (
    typeof basic.candidateListItemSelector === 'string' &&
    basic.candidateListItemSelector.trim()
  ) {
    normalized.basic.candidateListItemSelector = basic.candidateListItemSelector.trim();
  } else {
    issues.push('候选人列表选择器缺失，已回退默认值。');
  }

  if (typeof basic.candidateNameSelector === 'string' && basic.candidateNameSelector.trim()) {
    normalized.basic.candidateNameSelector = basic.candidateNameSelector.trim();
  } else {
    issues.push('候选人姓名选择器缺失，已回退默认值。');
  }

  if (
    typeof basic.resumeContainerSelector === 'string' &&
    basic.resumeContainerSelector.trim()
  ) {
    normalized.basic.resumeContainerSelector = basic.resumeContainerSelector.trim();
  } else {
    issues.push('简历容器选择器缺失，已回退默认值。');
  }

  if (
    typeof basic.favoriteButtonSelector === 'string' &&
    basic.favoriteButtonSelector.trim()
  ) {
    normalized.basic.favoriteButtonSelector = basic.favoriteButtonSelector.trim();
  } else {
    issues.push('收藏按钮选择器缺失，已回退默认值。');
  }

  if (basic.candidateOpenMode === 'click') {
    normalized.basic.candidateOpenMode = 'click';
  } else if (basic.candidateOpenMode !== undefined) {
    issues.push('候选人打开模式非法，已回退 click。');
  }

  if (typeof advanced.llmApiEndpoint === 'string') {
    normalized.advanced.llmApiEndpoint = advanced.llmApiEndpoint.trim();
  }

  if (typeof advanced.llmApiKey === 'string') {
    normalized.advanced.llmApiKey = advanced.llmApiKey.trim();
  }

  if (typeof advanced.llmModel === 'string' && advanced.llmModel.trim()) {
    normalized.advanced.llmModel = advanced.llmModel.trim();
  } else {
    issues.push('模型名称缺失，已回退默认值。');
  }

  if (typeof advanced.llmRequestTimeoutMs === 'number' && Number.isFinite(advanced.llmRequestTimeoutMs)) {
    normalized.advanced.llmRequestTimeoutMs = clamp(Math.floor(advanced.llmRequestTimeoutMs), 5000, 120000);
  } else if (advanced.llmRequestTimeoutMs !== undefined) {
    issues.push('LLM 请求超时配置非法，已回退默认值。');
  }

  if (
    typeof advanced.perCandidateTimeoutMs === 'number' &&
    Number.isFinite(advanced.perCandidateTimeoutMs)
  ) {
    normalized.advanced.perCandidateTimeoutMs = clamp(
      Math.floor(advanced.perCandidateTimeoutMs),
      10000,
      180000,
    );
  } else if (advanced.perCandidateTimeoutMs !== undefined) {
    issues.push('单候选人超时配置非法，已回退默认值。');
  }

  return {
    valid: issues.length === 0,
    issues,
    normalized,
  };
}

export function parseStoredSettings(raw: string | null): SettingsValidationResult {
  if (!raw) {
    return {
      valid: true,
      issues: [],
      normalized: cloneDefaults(),
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateSettings(parsed);
  } catch {
    return {
      valid: false,
      issues: ['设置数据解析失败，已回退默认值。'],
      normalized: cloneDefaults(),
    };
  }
}

export const settingsService = {
  storageKey: SETTINGS_STORAGE_KEY,

  load(): SettingsValidationResult {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      return parseStoredSettings(raw);
    } catch {
      return {
        valid: false,
        issues: ['读取 localStorage 失败，已使用默认配置。'],
        normalized: cloneDefaults(),
      };
    }
  },

  save(settings: AppSettings): SettingsValidationResult {
    const validation = validateSettings(settings);

    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validation.normalized));
      return validation;
    } catch {
      return {
        valid: false,
        issues: [...validation.issues, '写入 localStorage 失败，请检查浏览器存储权限。'],
        normalized: validation.normalized,
      };
    }
  },
};
