import {
  DEFAULT_SETTINGS,
  DEPRECATED_ADVANCED_FIELDS,
  type AppSettings,
  type ExportMode,
  type SettingsValidationResult,
} from '../types/settings';

const SETTINGS_STORAGE_KEY = 'boos-extension:settings';

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSelectorToken(token: string, preferred: 'class' | 'id'): string {
  const value = token.trim();
  if (!value) {
    return value;
  }

  if (/^[.#\[]/.test(value)) {
    return value;
  }

  if (/[\s>+~:*]/.test(value)) {
    return value;
  }

  return preferred === 'id' ? `#${value}` : `.${value}`;
}

function normalizeSelectorList(value: string, preferred: 'class' | 'id'): string {
  return value
    .split(',')
    .map((item) => normalizeSelectorToken(item, preferred))
    .filter(Boolean)
    .join(', ');
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
    normalized.basic.candidateListItemSelector = normalizeSelectorList(
      basic.candidateListItemSelector.trim(),
      'class',
    );
  } else {
    issues.push('候选人列表选择器缺失，已回退默认值。');
  }

  if (typeof basic.candidateNameSelector === 'string' && basic.candidateNameSelector.trim()) {
    normalized.basic.candidateNameSelector = normalizeSelectorList(
      basic.candidateNameSelector.trim(),
      'class',
    );
  } else {
    issues.push('候选人姓名选择器缺失，已回退默认值。');
  }

  if (
    typeof basic.resumeContainerSelector === 'string' &&
    basic.resumeContainerSelector.trim()
  ) {
    normalized.basic.resumeContainerSelector = normalizeSelectorList(
      basic.resumeContainerSelector.trim(),
      'id',
    );
  } else {
    issues.push('简历容器选择器缺失，已回退默认值。');
  }

  if (
    typeof basic.favoriteButtonSelector === 'string' &&
    basic.favoriteButtonSelector.trim()
  ) {
    normalized.basic.favoriteButtonSelector = normalizeSelectorList(
      basic.favoriteButtonSelector.trim(),
      'class',
    );
  } else {
    issues.push('收藏按钮选择器缺失，已回退默认值。');
  }

  if (basic.candidateOpenMode === 'click') {
    normalized.basic.candidateOpenMode = 'click';
  } else if (basic.candidateOpenMode !== undefined) {
    issues.push('候选人打开模式非法，已回退 click。');
  }

  // 迁移：清除已废弃的模型配置字段。API Key 绝不能留在浏览器存储里。
  const migratedAwayFields: string[] = [];
  for (const field of DEPRECATED_ADVANCED_FIELDS) {
    if (advanced[field] !== undefined) migratedAwayFields.push(field);
  }
  if (migratedAwayFields.length > 0) {
    issues.push(
      `已移除废弃的模型配置项（${migratedAwayFields.join('、')}）。模型凭据现由 BFF 持有，请在高级设置中配置 BFF 地址与接入 token。`,
    );
  }

  if (typeof advanced.bffBaseUrl === 'string' && advanced.bffBaseUrl.trim()) {
    normalized.advanced.bffBaseUrl = advanced.bffBaseUrl.trim().replace(/\/+$/, '');
  } else if (advanced.bffBaseUrl !== undefined) {
    issues.push('BFF 地址非法，已回退默认值。');
  }

  if (typeof advanced.bffApiToken === 'string') {
    normalized.advanced.bffApiToken = advanced.bffApiToken.trim();
  }

  if (typeof advanced.bffRequestTimeoutMs === 'number' && Number.isFinite(advanced.bffRequestTimeoutMs)) {
    normalized.advanced.bffRequestTimeoutMs = clamp(Math.floor(advanced.bffRequestTimeoutMs), 5000, 300000);
  } else if (advanced.bffRequestTimeoutMs !== undefined) {
    issues.push('BFF 请求超时配置非法，已回退默认值。');
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

  if (typeof advanced.batchSize === 'number' && Number.isFinite(advanced.batchSize)) {
    normalized.advanced.batchSize = clamp(Math.floor(advanced.batchSize), 1, 100);
  } else if (advanced.batchSize !== undefined) {
    issues.push('批处理条数配置非法，已回退默认值。');
  }

  if (advanced.exportMode === 'processed' || advanced.exportMode === 'all') {
    normalized.advanced.exportMode = advanced.exportMode as ExportMode;
  } else if (advanced.exportMode !== undefined) {
    issues.push('导出模式配置非法，已回退默认值。');
  }

  return {
    valid: issues.length === 0,
    issues,
    normalized,
    ...(migratedAwayFields.length > 0 ? { migratedAwayFields } : {}),
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
      const result = parseStoredSettings(raw);
      // 发生迁移时立刻写回清理后的配置。只在内存里剔除字段是不够的——
      // 旧的 API Key 会一直留在 localStorage 里。
      if (result.migratedAwayFields?.length) {
        try {
          localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(result.normalized));
        } catch {
          // 写回失败不影响本次使用，下次加载会再试一次。
        }
      }
      return result;
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
