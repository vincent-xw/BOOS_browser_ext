import type {
  CandidateProfile,
  CandidateSummary,
  LlmAssessmentInput,
  LlmAssessmentResult,
} from '../types/page-io';
import type { AppSettings } from '../types/settings';

function buildPrompt(input: LlmAssessmentInput): string {
  return [
    '你是招聘助手，请基于给定招聘策略判断候选人是否值得收藏。',
    '输出必须为 JSON，字段：shouldFavorite(boolean), reason(string)。',
    '',
    `用户策略Prompt：\n${input.userPrompt}`,
    '',
    `候选人姓名：${input.candidate.name || '未知'}`,
    `候选人摘要：${input.candidate.previewText || '无'}`,
    '',
    `在线简历：\n${input.profile.resumeText || '无可读取内容'}`,
  ].join('\n');
}

function normalizeDecisionText(text: string): LlmAssessmentResult {
  const trimmed = text.trim();

  try {
    const json = JSON.parse(trimmed) as {
      shouldFavorite?: unknown;
      reason?: unknown;
      decision?: unknown;
      favorite?: unknown;
    };

    const decisionRaw =
      typeof json.shouldFavorite === 'boolean'
        ? json.shouldFavorite
        : typeof json.favorite === 'boolean'
          ? json.favorite
          : typeof json.decision === 'string'
            ? ['favorite', 'collect', 'yes', 'true', '收藏'].includes(
                json.decision.toLowerCase(),
              )
            : false;

    return {
      shouldFavorite: Boolean(decisionRaw),
      reason:
        typeof json.reason === 'string' && json.reason.trim()
          ? json.reason.trim()
          : '模型未提供明确理由。',
      rawText: trimmed,
    };
  } catch {
    const positiveHints = ['值得收藏', '建议收藏', 'shouldfavorite:true', '"shouldFavorite":true'];
    const shouldFavorite = positiveHints.some((hint) => trimmed.includes(hint));

    return {
      shouldFavorite,
      reason: shouldFavorite
        ? '模型文本中包含正向收藏信号。'
        : '模型文本未解析为结构化 JSON，按不收藏处理。',
      rawText: trimmed,
    };
  }
}

async function requestWithTimeout(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(endpoint, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function extractContentFromPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const root = payload as Record<string, unknown>;
  if (typeof root.output === 'string') {
    return root.output;
  }

  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === 'string') {
      return message.content;
    }

    if (typeof first.text === 'string') {
      return first.text;
    }
  }

  if (typeof root.content === 'string') {
    return root.content;
  }

  return '';
}

function ensureLlmConfig(settings: AppSettings): { ok: true } | { ok: false; message: string } {
  if (!settings.advanced.llmApiEndpoint) {
    return { ok: false, message: '未配置大模型 API Endpoint。' };
  }

  if (!settings.advanced.llmApiKey) {
    return { ok: false, message: '未配置大模型 API Key。' };
  }

  return { ok: true };
}

export const llmService = {
  async assessCandidate(
    settings: AppSettings,
    userPrompt: string,
    candidate: CandidateSummary,
    profile: CandidateProfile,
  ): Promise<LlmAssessmentResult> {
    const configState = ensureLlmConfig(settings);
    if (!configState.ok) {
      throw new Error(configState.message);
    }

    const body = {
      model: settings.advanced.llmModel,
      messages: [
        {
          role: 'user',
          content: buildPrompt({ userPrompt, candidate, profile }),
        },
      ],
      temperature: 0.2,
      response_format: {
        type: 'json_object',
      },
    };

    const response = await requestWithTimeout(
      settings.advanced.llmApiEndpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.advanced.llmApiKey}`,
        },
        body: JSON.stringify(body),
      },
      settings.advanced.llmRequestTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(`LLM 请求失败（HTTP ${response.status}）。`);
    }

    const payload = (await response.json()) as unknown;
    const content = extractContentFromPayload(payload);

    if (!content.trim()) {
      throw new Error('LLM 返回内容为空，无法做收藏决策。');
    }

    return normalizeDecisionText(content);
  },
};

export type { CandidateSummary, CandidateProfile };
