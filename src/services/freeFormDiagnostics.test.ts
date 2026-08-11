import { describe, expect, it } from 'vitest';

import { formatFreeFormDiagnostic } from './freeFormDiagnostics';

describe('formatFreeFormDiagnostic', () => {
  const base = {
    sessionId: 'ff-3c9a1f',
    timestamp: '2026-08-10T14:22:31.104Z',
    extensionVersion: '0.1.0',
    url: 'https://www.zhipin.com/web/chat/index',
    error: { code: 'BFF_TOOL_OUTPUT_INVALID', message: '工具输出不符合约定结构' },
    steps: [],
  };

  it('包含会话、版本与页面等定位信息', () => {
    const text = formatFreeFormDiagnostic(base);
    expect(text).toContain('会话：ff-3c9a1f');
    expect(text).toContain('扩展版本：0.1.0');
    expect(text).toContain('页面：https://www.zhipin.com/web/chat/index');
    expect(text).toContain('=== 日志结束 ===');
  });

  it('有 requestId 才输出该行', () => {
    expect(formatFreeFormDiagnostic(base)).not.toContain('requestId');
    const withId = formatFreeFormDiagnostic({ ...base, error: { ...base.error, requestId: 'req_01JQ8F' } });
    expect(withId).toContain('requestId: req_01JQ8F');
  });

  it('完整输出工具入参与出参，不截断', () => {
    const longText = '我对这个岗位很感兴趣'.repeat(40);
    const text = formatFreeFormDiagnostic({
      ...base,
      steps: [{ step: 3, toolName: 'browser_input_text', input: { ref: 42, text: longText }, output: { ok: true }, allowed: true }],
    });
    expect(text).toContain('[3] browser_input_text');
    // 完整保留是这个功能的前提：截断了就失去排查价值。
    expect(text).toContain(longText);
  });

  it('标出被拒的步骤', () => {
    const text = formatFreeFormDiagnostic({
      ...base,
      steps: [{ step: 4, toolName: 'browser_click', input: {}, output: { ok: false, code: 'USER_DENIED' }, allowed: false, denied: true }],
    });
    expect(text).toContain('allowed=false  denied=true');
  });

  it('无步骤时说明失败发生在第一步之前', () => {
    expect(formatFreeFormDiagnostic(base)).toContain('无已执行步骤');
  });

  it('入参存在循环引用时不让整份日志生成失败', () => {
    const circular: Record<string, unknown> = { ref: 1 };
    circular.self = circular;
    const text = formatFreeFormDiagnostic({
      ...base,
      steps: [{ step: 1, toolName: 'browser_click', input: circular, output: { ok: true }, allowed: true }],
    });
    expect(text).toContain('无法序列化');
    expect(text).toContain('=== 日志结束 ===');
  });
});
