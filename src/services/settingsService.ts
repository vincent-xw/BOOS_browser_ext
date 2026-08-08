import {
  DEFAULT_SETTINGS,
  DEPRECATED_ADVANCED_FIELDS,
  DEPRECATED_BOSS_FIELDS,
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
  const advanced =
    typeof root.advanced === 'object' && root.advanced !== null
      ? (root.advanced as Record<string, unknown>)
      : {};

  // 迁移：清除已废弃的模型配置字段。API Key 绝不能留在浏览器存储里。
  const migratedAwayFields: string[] = [];
  for (const field of DEPRECATED_ADVANCED_FIELDS) {
    if (advanced[field] !== undefined) migratedAwayFields.push(field);
  }
  if (migratedAwayFields.length > 0) {
    issues.push(
      `已移除废弃的模型配置项（${migratedAwayFields.join('、')}）。模型凭据现由 BFF 持有，请在设置中配置 BFF 地址与接入 token。`,
    );
  }

  // 迁移：清除 BOSS 预设流程的配置。动作序列现由 agent 规划，不再需要写死的选择器与批量参数。
  const migratedBossFields: string[] = [];
  if (root.basic !== undefined) migratedBossFields.push('basic');
  for (const field of DEPRECATED_BOSS_FIELDS) {
    if (advanced[field] !== undefined) migratedBossFields.push(field);
  }
  if (migratedBossFields.length > 0) {
    issues.push(`已移除 BOSS 预设流程的配置项（${migratedBossFields.join('、')}）。页面操作现由自由指令驱动。`);
    migratedAwayFields.push(...migratedBossFields);
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

  if (typeof advanced.maxSteps === 'number' && Number.isFinite(advanced.maxSteps)) {
    normalized.advanced.maxSteps = clamp(Math.floor(advanced.maxSteps), 5, 200);
  } else if (advanced.maxSteps !== undefined) {
    issues.push('最大步数配置非法，已回退默认值。');
  }

  if (typeof advanced.llmMaxRetries === 'number' && Number.isFinite(advanced.llmMaxRetries)) {
    normalized.advanced.llmMaxRetries = clamp(Math.floor(advanced.llmMaxRetries), 0, 5);
  } else if (advanced.llmMaxRetries !== undefined) {
    issues.push('LLM 重试次数配置非法，已回退默认值。');
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
