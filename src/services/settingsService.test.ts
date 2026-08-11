import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseStoredSettings, validateSettings } from './settingsService';
import { DEFAULT_SETTINGS } from '../types/settings';

/** 旧版本配置：含已废弃的模型字段、BOSS 选择器与批量参数。 */
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
    bffBaseUrl: 'http://localhost:8787',
    bffApiToken: 'token-1',
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
    // 这是迁移最核心的保证：密钥不得以任何形式留在扩展存储里。
    const result = validateSettings(legacyStored);
    expect(JSON.stringify(result.normalized)).not.toContain('sk-LEAKED-SECRET-VALUE');
    expect(JSON.stringify(result.normalized)).not.toContain('ark.cn-beijing.volces.com');
  });

  it('报告迁移掉的模型字段', () => {
    const result = validateSettings(legacyStored);
    expect(result.migratedAwayFields).toContain('llmApiKey');
    expect(result.migratedAwayFields).toContain('llmApiEndpoint');
  });

  it('给出可读的迁移提示', () => {
    const result = validateSettings(legacyStored);
    expect(result.issues.some((issue) => issue.includes('BFF'))).toBe(true);
  });

  it('保留仍然有效的 BFF 配置', () => {
    const result = validateSettings(legacyStored);
    expect(result.normalized.advanced.bffBaseUrl).toBe('http://localhost:8787');
    expect(result.normalized.advanced.bffApiToken).toBe('token-1');
  });
});

describe('BOSS 预设流程配置迁移', () => {
  it('清除 basic 分区（选择器配置）', () => {
    // 动作序列现由 agent 规划，不再需要写死的角色选择器。
    const result = validateSettings(legacyStored);
    expect((result.normalized as unknown as Record<string, unknown>).basic).toBeUndefined();
  });

  it('清除批量处理与导出配置', () => {
    const result = validateSettings(legacyStored);
    const advanced = result.normalized.advanced as unknown as Record<string, unknown>;
    expect(advanced.perCandidateTimeoutMs).toBeUndefined();
    expect(advanced.batchSize).toBeUndefined();
    expect(advanced.exportMode).toBeUndefined();
  });

  it('序列化后不含 BOSS 选择器', () => {
    const result = validateSettings(legacyStored);
    const serialized = JSON.stringify(result.normalized);
    expect(serialized).not.toContain('zhipin.com');
    expect(serialized).not.toContain('my-like');
  });

  it('报告迁移掉的 BOSS 字段', () => {
    const result = validateSettings(legacyStored);
    expect(result.migratedAwayFields).toContain('basic');
    expect(result.migratedAwayFields).toContain('batchSize');
  });

  it('提示说明页面操作已改为自由指令', () => {
    const result = validateSettings(legacyStored);
    expect(result.issues.some((issue) => issue.includes('自由指令'))).toBe(true);
  });

  it('无废弃字段时不报告迁移', () => {
    const result = validateSettings({ advanced: { ...DEFAULT_SETTINGS.advanced, bffApiToken: 'token-1' } });
    expect(result.migratedAwayFields).toBeUndefined();
  });
});

describe('BFF 配置校验', () => {
  it('保留 BFF 地址并去掉末尾斜杠', () => {
    const result = validateSettings({ advanced: { ...DEFAULT_SETTINGS.advanced, bffBaseUrl: 'http://localhost:9000///' } });
    expect(result.normalized.advanced.bffBaseUrl).toBe('http://localhost:9000');
  });

  it('保留接入 token', () => {
    const result = validateSettings({ advanced: { ...DEFAULT_SETTINGS.advanced, bffApiToken: '  token-1  ' } });
    expect(result.normalized.advanced.bffApiToken).toBe('token-1');
  });

  it('超时越界时收敛到范围内', () => {
    const tooSmall = validateSettings({ advanced: { ...DEFAULT_SETTINGS.advanced, bffRequestTimeoutMs: 100 } });
    expect(tooSmall.normalized.advanced.bffRequestTimeoutMs).toBe(5000);
    const tooLarge = validateSettings({ advanced: { ...DEFAULT_SETTINGS.advanced, bffRequestTimeoutMs: 9_999_999 } });
    expect(tooLarge.normalized.advanced.bffRequestTimeoutMs).toBe(300000);
  });

  it('默认配置含 BFF 与步数配置', () => {
    expect(Object.keys(DEFAULT_SETTINGS.advanced).sort()).toEqual(['approvalEnabled', 'bffApiToken', 'bffBaseUrl', 'bffRequestTimeoutMs', 'llmMaxRetries', 'maxSteps']);
  });

  it('默认最大步数为 50', () => {
    expect(DEFAULT_SETTINGS.advanced.maxSteps).toBe(50);
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
    const clean = { advanced: { ...DEFAULT_SETTINGS.advanced, bffApiToken: 't' } };
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
