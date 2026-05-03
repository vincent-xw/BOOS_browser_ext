import type {
  CandidateSummary,
} from '../types/page-io';
import type { AppSettings } from '../types/settings';

function maskApiKey(key: string): string {
  if (!key) {
    return '';
  }

  if (key.length <= 10) {
    return `${key.slice(0, 2)}***${key.slice(-2)}`;
  }

  return `${key.slice(0, 6)}***${key.slice(-4)}`;
}

function shortenText(text: string, max = 800): string {
  if (!text) {
    return '';
  }

  return text.length > max ? `${text.slice(0, max)}... (len=${text.length})` : text;
}

function extractErrorMessage(payload: unknown, fallbackText: string): string {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const direct = obj.error;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }

    if (direct && typeof direct === 'object') {
      const nested = direct as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message.trim()) {
        return nested.message.trim();
      }
      if (typeof nested.code === 'string' && nested.code.trim()) {
        return `code=${nested.code}`;
      }
    }

    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message.trim();
    }
  }

  return shortenText(fallbackText, 280) || '无响应错误信息';
}

export interface LlmBatchAssessmentItem {
  index: number;
  shouldFavorite: boolean;
  reason: string;
}

export interface LlmBatchAssessmentResult {
  decisions: LlmBatchAssessmentItem[];
  rawText: string;
}

function buildBatchPrompt(userPrompt: string, candidates: CandidateSummary[]): string {
  const candidateLines = candidates.map((candidate) => ({
    index: candidate.index,
    name: candidate.name,
    previewText: candidate.previewText,
  }));

  return [
    '你是招聘助手。请根据用户策略，判断候选人列表中每个候选人是否“建议跟进”。',
    '必须返回严格 JSON（不要 markdown，不要代码块，不要解释文字）。',
    'JSON 格式必须为：{"decisions":[{"index":0,"shouldFavorite":true,"reason":"..."}]}',
    'index 必须对应输入中的候选人 index；每个候选人都必须有一条 decision。',
    'reason 请简洁，中文，不超过50字。',
    '',
    `用户策略Prompt：\n${userPrompt}`,
    '',
    `候选人列表(JSON)：\n${JSON.stringify(candidateLines, null, 2)}`,
  ].join('\n');
}

function normalizeBatchDecisionText(
  text: string,
  candidates: CandidateSummary[],
): LlmBatchAssessmentResult {
  const trimmed = text.trim();
  const candidateIndexes = new Set(candidates.map((candidate) => candidate.index));

  const toShouldFavorite = (value: unknown): boolean => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      return ['true', 'yes', '1', 'favorite', 'collect', 'follow', '建议', '推荐'].some((token) =>
        lower.includes(token),
      );
    }
    if (typeof value === 'number') {
      return value > 0;
    }
    return false;
  };

  try {
    const json = JSON.parse(trimmed) as {
      decisions?: Array<Record<string, unknown>>;
    };
    const decisionsRaw = Array.isArray(json.decisions) ? json.decisions : [];
    const normalized = decisionsRaw
      .map((item) => {
        const rawIndex = item.index ?? item.candidateIndex;
        const index = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
        if (!Number.isFinite(index) || !candidateIndexes.has(index)) {
          return null;
        }

        const shouldFavorite = toShouldFavorite(
          item.shouldFavorite ?? item.favorite ?? item.decision,
        );
        const reason =
          typeof item.reason === 'string' && item.reason.trim()
            ? item.reason.trim()
            : shouldFavorite
              ? '模型建议跟进。'
              : '模型建议暂不跟进。';

        return {
          index,
          shouldFavorite,
          reason,
        };
      })
      .filter((item): item is LlmBatchAssessmentItem => Boolean(item));

    const byIndex = new Map<number, LlmBatchAssessmentItem>();
    for (const decision of normalized) {
      byIndex.set(decision.index, decision);
    }

    const merged = candidates.map((candidate) => {
      return (
        byIndex.get(candidate.index) ?? {
          index: candidate.index,
          shouldFavorite: false,
          reason: '模型未返回该候选人的判断。',
        }
      );
    });

    return {
      decisions: merged,
      rawText: trimmed,
    };
  } catch {
    return {
      decisions: candidates.map((candidate) => ({
        index: candidate.index,
        shouldFavorite: false,
        reason: '模型输出未解析为有效 JSON。',
      })),
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
  if (typeof root.output_text === 'string') {
    return root.output_text;
  }

  const output = root.output;
  if (Array.isArray(output)) {
    const pieces: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const contentItem of content) {
        if (!contentItem || typeof contentItem !== 'object') {
          continue;
        }
        const text = (contentItem as Record<string, unknown>).text;
        if (typeof text === 'string' && text.trim()) {
          pieces.push(text);
        }
      }
    }

    if (pieces.length) {
      return pieces.join('\n');
    }
  }

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
  async assessCandidateList(
    settings: AppSettings,
    userPrompt: string,
    candidates: CandidateSummary[],
  ): Promise<LlmBatchAssessmentResult> {
    const configState = ensureLlmConfig(settings);
    if (!configState.ok) {
      throw new Error(configState.message);
    }

    if (!candidates.length) {
      return {
        decisions: [],
        rawText: '',
      };
    }

    const body = {
      model: settings.advanced.llmModel,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: buildBatchPrompt(userPrompt, candidates),
            },
          ],
        },
      ],
      temperature: 0.1,
    };

    const requestId = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    console.groupCollapsed(`[BOOS LLM][${requestId}] request`);
    console.log('endpoint', settings.advanced.llmApiEndpoint);
    console.log('model', settings.advanced.llmModel);
    console.log('candidateCount', candidates.length);
    console.log('timeoutMs', settings.advanced.llmRequestTimeoutMs);
    console.log('authorization', `Bearer ${maskApiKey(settings.advanced.llmApiKey)}`);
    console.log('bodyPreview', {
      model: body.model,
      inputCount: body.input.length,
      promptPreview: shortenText(body.input[0]?.content?.[0]?.text || '', 500),
    });
    console.groupEnd();

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

    const responseText = await response.text().catch(() => '');
    let payload: unknown = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }

    if (!response.ok) {
      const detail = extractErrorMessage(payload, responseText);
      console.groupCollapsed(`[BOOS LLM][${requestId}] response HTTP ${response.status}`);
      console.log('ok', response.ok);
      console.log('status', response.status);
      console.log('responsePreview', shortenText(responseText, 1200));
      console.groupEnd();
      throw new Error(`LLM 请求失败（HTTP ${response.status}）：${detail}`);
    }

    console.groupCollapsed(`[BOOS LLM][${requestId}] response HTTP ${response.status}`);
    console.log('ok', response.ok);
    console.log('status', response.status);
    console.log('responsePreview', shortenText(responseText, 1200));
    console.groupEnd();

    const content = extractContentFromPayload(payload);

    if (!content.trim()) {
      throw new Error('LLM 返回内容为空，无法进行候选人列表评估。');
    }

    return normalizeBatchDecisionText(content, candidates);
  },
};

export type { CandidateSummary };
