import { runAgent } from '../agent/agentClient';
import type { BffConfig } from '../agent/agentClient';
import type { CandidateSummary } from '../types/page-io';
import type { AppSettings } from '../types/settings';

/**
 * 候选人评估。
 *
 * 扩展不再直连模型：Endpoint、模型名与 API Key 全部由 BFF 持有。
 * 评估 prompt 与输出协议也在 BFF 侧注册（见 agent-kit 的 browser-tools.ts），
 * 因此这里不再需要手写 JSON 解析与容错 —— 协议校验在 BFF 完成。
 */

export interface LlmBatchAssessmentItem {
  index: number;
  shouldFavorite: boolean;
  reason: string;
}

export interface LlmBatchAssessmentResult {
  decisions: LlmBatchAssessmentItem[];
  rawText: string;
}

/** 从设置构造 BFF 连接配置。 */
export function toBffConfig(settings: AppSettings): BffConfig {
  return {
    baseUrl: settings.advanced.bffBaseUrl,
    apiToken: settings.advanced.bffApiToken,
    requestTimeoutMs: settings.advanced.bffRequestTimeoutMs,
  };
}

function ensureBffConfig(settings: AppSettings): { ok: true } | { ok: false; message: string } {
  if (!settings.advanced.bffBaseUrl) return { ok: false, message: '未配置 BFF 地址，请在高级设置中填写。' };
  if (!settings.advanced.bffApiToken) return { ok: false, message: '未配置 BFF 接入 token，请在高级设置中填写。' };
  return { ok: true };
}

/**
 * 把模型输出规整为决策列表。
 *
 * BFF 已按输出协议校验过结构，这里只做「补齐缺失候选人」这一件事：
 * 模型漏判某个候选人时要有明确的兜底，而不是让该候选人从结果里消失。
 */
function normalizeDecisions(output: unknown, candidates: CandidateSummary[]): LlmBatchAssessmentResult {
  const rawText = typeof output === 'string' ? output : JSON.stringify(output);
  const parsed = (typeof output === 'string' ? safeParse(output) : output) as
    | { decisions?: Array<{ index?: unknown; shouldFavorite?: unknown; reason?: unknown }> }
    | null;

  const byIndex = new Map<number, LlmBatchAssessmentItem>();
  for (const item of parsed?.decisions ?? []) {
    const index = typeof item.index === 'number' ? item.index : Number(item.index);
    if (!Number.isFinite(index)) continue;
    byIndex.set(index, {
      index,
      shouldFavorite: item.shouldFavorite === true,
      reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : '模型未给出理由。',
    });
  }

  return {
    decisions: candidates.map(
      (candidate) =>
        byIndex.get(candidate.index) ?? {
          index: candidate.index,
          shouldFavorite: false,
          reason: '模型未返回该候选人的判断。',
        },
    ),
    rawText,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const llmService = {
  async assessCandidateList(
    settings: AppSettings,
    userPrompt: string,
    candidates: CandidateSummary[],
  ): Promise<LlmBatchAssessmentResult> {
    const configState = ensureBffConfig(settings);
    if (!configState.ok) throw new Error(configState.message);

    if (!candidates.length) return { decisions: [], rawText: '' };

    const sessionId = `assess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await runAgent(toBffConfig(settings), sessionId, userPrompt, {
      task: 'candidate-assessment',
      candidates: candidates.map((candidate) => ({
        index: candidate.index,
        name: candidate.name,
        previewText: candidate.previewText,
      })),
    });

    // 评估任务不应触发工具调用；若模型意外要求工具，视为配置或 prompt 问题。
    if (result.type !== 'final') {
      throw new Error(`候选人评估收到了意外的工具调用请求（${result.calls.map((call) => call.toolName).join('、')}），请检查 BFF 侧 prompt 配置。`);
    }

    return normalizeDecisions(result.output, candidates);
  },
};

export type { CandidateSummary };
