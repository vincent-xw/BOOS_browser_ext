import type { StepEvent } from '../agent/agentClient';

/**
 * 自由指令失败时的诊断日志。
 *
 * 多步执行中途失败时，UI 只显示一行报错，用户没法把上下文完整交给大模型排查。
 * 这里把「截至失败点的每一步 + 错误 + 环境」拼成纯文本，一键复制即可粘贴。
 *
 * 有意**不截断、不脱敏**：日志的用途就是交给大模型定位问题，省略掉的往往正是关键。
 * 代价是可能包含简历/沟通原文，所以复制时必须向用户提示。
 */

/** 诊断日志的输入。纯数据，不碰 DOM 与 chrome API，便于单测。 */
export interface FreeFormDiagnosticInput {
  /** 失败所在会话 id，用于和 BFF 侧 SQLite 记录对应。 */
  sessionId: string;
  /** 出错轮次的时间戳。 */
  timestamp: string;
  extensionVersion: string;
  /** 出错时的页面地址，可能取不到。 */
  url?: string;
  error: {
    code: string;
    message: string;
    /** BFF 侧日志的关联键，只有 BffError 才有。 */
    requestId?: string;
  };
  steps: readonly StepEvent[];
  /** 环境探针文本，直接取 formatDiagnosticResult() 的结果。 */
  environment?: string;
}

/** JSON 化一个工具入参/出参。完整保留，仅在无法序列化时降级。 */
function stringifyPayload(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    // undefined 与函数会被 JSON.stringify 吃成 undefined，此时给个可读占位。
    return text === undefined ? String(value) : text;
  } catch {
    // 循环引用等情况下别让整份日志生成失败。
    return `(无法序列化：${String(value)})`;
  }
}

/** 缩进多行文本，让步骤的入参出参在日志里有层次。 */
function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/** 一步的状态标记。被拒和失败要能一眼看出来。 */
function describeStepFlags(step: StepEvent): string {
  const flags = [`allowed=${step.allowed}`];
  if (step.denied) flags.push('denied=true');
  return flags.join('  ');
}

/** 把失败上下文格式化为可直接粘贴给大模型的纯文本。 */
export function formatFreeFormDiagnostic(input: FreeFormDiagnosticInput): string {
  const lines: string[] = [];

  lines.push('=== 自由指令诊断日志 ===');
  lines.push(`时间：${input.timestamp}`);
  lines.push(`扩展版本：${input.extensionVersion}`);
  lines.push(`会话：${input.sessionId}`);
  if (input.url) lines.push(`页面：${input.url}`);

  lines.push('');
  lines.push('--- 错误 ---');
  lines.push(`code: ${input.error.code}`);
  if (input.error.requestId) lines.push(`requestId: ${input.error.requestId}`);
  lines.push(`message: ${input.error.message}`);

  if (input.environment) {
    lines.push('');
    lines.push('--- 环境 ---');
    lines.push(input.environment);
  }

  lines.push('');
  lines.push(`--- 步骤（${input.steps.length}）---`);
  if (input.steps.length === 0) {
    lines.push('(无已执行步骤，失败发生在第一步之前)');
  }
  for (const step of input.steps) {
    lines.push(`[${step.step}] ${step.toolName}  ${describeStepFlags(step)}`);
    lines.push('  input:');
    lines.push(indent(stringifyPayload(step.input)));
    lines.push('  output:');
    lines.push(indent(stringifyPayload(step.output)));
  }

  lines.push('=== 日志结束 ===');

  return lines.join('\n');
}
