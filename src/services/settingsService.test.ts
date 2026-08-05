import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseStoredSettings, validateSettings } from './settingsService';
import { DEFAULT_SETTINGS } from '../types/settings';

/** 旧版本配置：含已废弃的模型字段与仍有效的业务字段。 */
const legacyStored = {
  basic: {
    targetDomain: 'www.zhipin.com',
    candidateListItemSelector: '.my-card',
    candidateNameSelector: '.my-name',
    candidateOpenMode: 'click',
    resumeContainerSelector: '#my-resume',
    favoriteButtonSelector: '.my-like',
  },
  advanced: {
    llmApiEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/responses',
    llmApiKey: 'sk-LEAKED-SECRET-VALUE',
    llmModel: 'doubao-pro-32k',
    llmRequestTimeoutMs: 30000,
    perCandidateTimeoutMs: 45000,
    batchSize: 10,
    exportMode: 'processed',
  },
};

describe('废弃模型配置迁移', () => {
  it('清除 API Key、Endpoint 与模型名', () => {
    const result = validateSettings(legacyStored);
    const advanced = result.normalized.advanced as unknown as Record<string, unknown>;
    expect(advanced.llmApiKey).toBeUndefined();
    expect(advanced.llmApiEndpoint).toBeUndefined();
    expect(advanced.llmModel).toBeUndefined();
    expect(advanced.llmRequestTimeoutMs).toBeUndefined();
  });

  it('序列化后不含任何密钥痕迹', () => {
    // 这是本次迁移最核心的保证：密钥不得以任何形式留在扩展存储里。
    const result = validateSettings(legacyStored);
    expect(JSON.stringify(result.normalized)).not.toContain('sk-LEAKED-SECRET-VALUE');
    expect(JSON.stringify(result.normalized)).not.toContain('ark.cn-beijing.volces.com');
  });

  it('报告迁移掉的字段', () => {
    const result = validateSettings(legacyStored);
    expect(result.migratedAwayFields).toEqual(['llmApiEndpoint', 'llmApiKey', 'llmModel', 'llmRequestTimeoutMs']);
  });

  it('给出可读的迁移提示', () => {
    const result = validateSettings(legacyStored);
    expect(result.issues.some((issue) => issue.includes('BFF'))).toBe(true);
  });

  it('保留仍然有效的业务字段', () => {
    const result = validateSettings(legacyStored);
    expect(result.normalized.basic.candidateListItemSelector).toBe('.my-card');
    expect(result.normalized.basic.resumeContainerSelector).toBe('#my-resume');
    expect(result.normalized.advanced.perCandidateTimeoutMs).toBe(45000);
    expect(result.normalized.advanced.batchSize).toBe(10);
  });

  it('无废弃字段时不报告迁移', () => {
    const result = validateSettings({
      basic: DEFAULT_SETTINGS.basic,
      advanced: { ...DEFAULT_SETTINGS.advanced, bffApiToken: 'token-1' },
    });
    expect(result.migratedAwayFields).toBeUndefined();
  });
});

describe('BFF 配置校验', () => {
  it('保留 BFF 地址并去掉末尾斜杠', () => {
    const result = validateSettings({
      basic: DEFAULT_SETTINGS.basic,
      advanced: { ...DEFAULT_SETTINGS.advanced, bffBaseUrl: 'http://localhost:9000///' },
    });
    expect(result.normalized.advanced.bffBaseUrl).toBe('http://localhost:9000');
  });

  it('保留接入 token', () => {
    const result = validateSettings({
      basic: DEFAULT_SETTINGS.basic,
      advanced: { ...DEFAULT_SETTINGS.advanced, bffApiToken: '  token-1  ' },
    });
    expect(result.normalized.advanced.bffApiToken).toBe('token-1');
  });

  it('超时越界时收敛到范围内', () => {
    const tooSmall = validateSettings({
      basic: DEFAULT_SETTINGS.basic,
      advanced: { ...DEFAULT_SETTINGS.advanced, bffRequestTimeoutMs: 100 },
    });
    expect(tooSmall.normalized.advanced.bffRequestTimeoutMs).toBe(5000);
    const tooLarge = validateSettings({
      basic: DEFAULT_SETTINGS.basic,
      advanced: { ...DEFAULT_SETTINGS.advanced, bffRequestTimeoutMs: 9_999_999 },
    });
    expect(tooLarge.normalized.advanced.bffRequestTimeoutMs).toBe(300000);
  });

  it('默认配置不含任何模型字段', () => {
    const keys = Object.keys(DEFAULT_SETTINGS.advanced);
    expect(keys).not.toContain('llmApiKey');
    expect(keys).not.toContain('llmApiEndpoint');
    expect(keys).not.toContain('llmModel');
  });

  it('默认接入 token 为空，强制用户显式配置', () => {
    expect(DEFAULT_SETTINGS.advanced.bffApiToken).toBe('');
  });
});

describe('parseStoredSettings', () => {
  it('空存储返回默认配置', () => {
    expect(parseStoredSettings(null).normalized).toEqual(DEFAULT_SETTINGS);
  });

  it('损坏的 JSON 回退默认配置', () => {
    const result = parseStoredSettings('{not json');
    expect(result.valid).toBe(false);
    expect(result.normalized).toEqual(DEFAULT_SETTINGS);
  });

  it('旧配置字符串同样被迁移', () => {
    const result = parseStoredSettings(JSON.stringify(legacyStored));
    expect(result.migratedAwayFields).toContain('llmApiKey');
    expect(JSON.stringify(result.normalized)).not.toContain('sk-LEAKED-SECRET-VALUE');
  });
});

describe('settingsService.load 写回', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('发生迁移时把清理后的配置写回存储', async () => {
    // 只在内存里剔除字段是不够的——旧 API Key 会一直留在 localStorage。
    const store = new Map<string, string>([['boos-extension:settings', JSON.stringify(legacyStored)]]);
    const setItem = vi.fn((key: string, value: string) => void store.set(key, value));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem,
      removeItem: (key: string) => void store.delete(key),
    });
    const { settingsService } = await import('./settingsService');
    settingsService.load();
    expect(setItem).toHaveBeenCalledOnce();
    expect(store.get('boos-extension:settings')).not.toContain('sk-LEAKED-SECRET-VALUE');
  });

  it('无需迁移时不写回', async () => {
    const clean = { basic: DEFAULT_SETTINGS.basic, advanced: { ...DEFAULT_SETTINGS.advanced, bffApiToken: 't' } };
    const store = new Map<string, string>([['boos-extension:settings', JSON.stringify(clean)]]);
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem,
      removeItem: () => undefined,
    });
    const { settingsService } = await import('./settingsService');
    settingsService.load();
    expect(setItem).not.toHaveBeenCalled();
  });
});
