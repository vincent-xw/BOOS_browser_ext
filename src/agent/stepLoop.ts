import type { CdpActionResult, CdpInputResult, ElementRole, LocateResult, VerifyRequest, VerifyResult } from '../types/cdp';
import { MessageType } from '../types/messages';
import type { ExtensionRequest } from '../types/messages';
import type { MessageSender } from './toolExecutor';

/**
 * 单步执行闭环。
 *
 * 闭环形状固定：读取 DOM → 定位 → 重算坐标 → 一个 CDP 动作 → 等待更新 → 验证 → 决定下一步。
 *
 * 两条不可放松的约束：
 * 1. 每轮只执行一个写动作。
 * 2. 每个写动作前都重新定位。弹窗会让底层元素位移、虚拟列表滚动会整片换 DOM 节点、
 *    框架重渲染会换掉节点引用 —— 缓存坐标连续点击，第二次之后基本都点在错误位置上，
 *    而且同样是「不报错但点错」。
 *
 * 机械动作序列走这里的固定规则，不进 agent 决策：更快也更稳。
 * agent 负责的是判定与异常处置（见 agentClient）。
 */

/** 一步的执行记录。失败时这是定位问题的唯一依据。 */
export interface StepRecord {
  name: string;
  action: 'locate' | 'click' | 'input' | 'key' | 'verify';
  ok: boolean;
  detail: string;
  /** 该步实际使用的坐标，便于比对是否点在了预期位置。 */
  coordinates?: { x: number; y: number };
  verification?: VerifyResult;
}

export interface StepLoopResult {
  ok: boolean;
  steps: StepRecord[];
  /** 失败发生在哪一步。成功时为 undefined。 */
  failedStep?: string;
  message: string;
}

export interface StepLoopContext {
  tabId: number;
  send: MessageSender;
  onStep?: (record: StepRecord) => void;
}

/** 定位一个角色的元素，并对不可点击的情况给出明确原因。 */
export async function locateForAction(
  role: ElementRole,
  context: StepLoopContext,
  options: { index?: number; selector?: string } = {},
): Promise<{ ok: true; x: number; y: number; result: LocateResult } | { ok: false; detail: string; result?: LocateResult }> {
  const result = await context.send<LocateResult>({
    type: MessageType.ContentLocate,
    tabId: context.tabId,
    locator: { role, ...(options.selector ? { selector: options.selector } : {}), ...(options.index === undefined ? {} : { index: options.index }) },
  });

  if (!result.found || typeof result.x !== 'number' || typeof result.y !== 'number') {
    return { ok: false, detail: result.message ?? `未定位到 ${role}`, result };
  }
  // 被遮挡时不点击：中心点命中的不是目标元素，点下去会作用在遮挡物上。
  if (result.occluded) {
    return { ok: false, detail: `${role} 被 ${result.occludedBy ?? '其他元素'} 遮挡，已中止点击。`, result };
  }
  return { ok: true, x: result.x, y: result.y, result };
}

/** 执行器：把一步的定位、动作与验证串起来，并统一记录。 */
export function createStepRunner(context: StepLoopContext) {
  const steps: StepRecord[] = [];

  function record(entry: StepRecord): StepRecord {
    steps.push(entry);
    context.onStep?.(entry);
    return entry;
  }

  /** 定位 + 点击 + 可选验证。每次调用都重新定位，不接受外部传入的坐标。 */
  async function clickStep(
    name: string,
    role: ElementRole,
    verification?: VerifyRequest,
    options: { index?: number; selector?: string } = {},
  ): Promise<boolean> {
    const located = await locateForAction(role, context, options);
    if (!located.ok) {
      record({ name: `${name}·定位`, action: 'locate', ok: false, detail: located.detail });
      return false;
    }
    record({
      name: `${name}·定位`,
      action: 'locate',
      ok: true,
      detail: `命中 ${located.result.matchedSelector ?? role}（来源：${located.result.selectorSource ?? '未知'}）`,
      coordinates: { x: located.x, y: located.y },
    });

    const action = await context.send<CdpActionResult>({
      type: MessageType.CdpClick,
      tabId: context.tabId,
      x: located.x,
      y: located.y,
      label: name,
    });
    record({ name, action: 'click', ok: action.ok, detail: action.message, coordinates: { x: located.x, y: located.y } });
    if (!action.ok) return false;

    return verification ? runVerify(`${name}·验证`, verification) : true;
  }

  /** 定位 + 输入 + 可选验证。 */
  async function inputStep(name: string, role: ElementRole, text: string, verification?: VerifyRequest): Promise<boolean> {
    const located = await locateForAction(role, context);
    if (!located.ok) {
      record({ name: `${name}·定位`, action: 'locate', ok: false, detail: located.detail });
      return false;
    }
    record({
      name: `${name}·定位`,
      action: 'locate',
      ok: true,
      detail: `命中 ${located.result.matchedSelector ?? role}`,
      coordinates: { x: located.x, y: located.y },
    });

    const action = await context.send<CdpInputResult>({
      type: MessageType.CdpInputText,
      tabId: context.tabId,
      x: located.x,
      y: located.y,
      text,
    });
    record({
      name,
      action: 'input',
      ok: action.ok,
      detail: action.ok ? `已写入 ${text.length} 字（回读：${action.actualValue?.slice(0, 40) ?? '未回读'}）` : action.message,
      coordinates: { x: located.x, y: located.y },
    });
    if (!action.ok) return false;

    return verification ? runVerify(`${name}·验证`, verification) : true;
  }

  async function keyStep(name: string, key: 'Enter' | 'Tab' | 'Escape', verification?: VerifyRequest): Promise<boolean> {
    const action = await context.send<CdpActionResult>({ type: MessageType.CdpPressKey, tabId: context.tabId, key });
    record({ name, action: 'key', ok: action.ok, detail: action.message });
    if (!action.ok) return false;
    return verification ? runVerify(`${name}·验证`, verification) : true;
  }

  /** 验证。任一维度未通过即返回 false，调用方据此中止后续步骤。 */
  async function runVerify(name: string, request: VerifyRequest): Promise<boolean> {
    const result = await context.send<VerifyResult>({ type: MessageType.ContentVerify, tabId: context.tabId, request });
    record({ name, action: 'verify', ok: result.passed, detail: result.message, verification: result });
    return result.passed;
  }

  function finish(ok: boolean): StepLoopResult {
    if (ok) return { ok: true, steps, message: `全部 ${steps.length} 步均已完成并通过验证。` };
    const failed = steps.find((step) => !step.ok);
    return {
      ok: false,
      steps,
      ...(failed ? { failedStep: failed.name } : {}),
      message: failed ? `失败发生在「${failed.name}」：${failed.detail}` : '任务失败。',
    };
  }

  return { clickStep, inputStep, keyStep, runVerify, finish, steps };
}

/** 打招呼流程的入参。 */
export interface GreetFlowOptions extends StepLoopContext {
  message: string;
  /** 发送方式。Enter 在多数聊天框可用，按钮更可靠 —— POC 阶段据实测选定。 */
  sendVia?: 'button' | 'enter';
  /** 打招呼请求的 URL 关键字，用于网络维度验证。 */
  greetUrlPattern?: string;
  sendUrlPattern?: string;
}

/**
 * 打招呼全链路。
 *
 * 定位打招呼按钮 → 点击 → 验证弹窗与请求 → 定位输入框 → 点击并写入中文
 * → 验证输入框内容与发送按钮可用 → 点发送/Enter → 验证消息发送请求成功返回。
 *
 * 每步都重新定位、每步都验证。任一步验证未通过立即中止 —— 继续下去只会在错误状态上叠加操作。
 */
export async function runGreetFlow(options: GreetFlowOptions): Promise<StepLoopResult> {
  const runner = createStepRunner(options);

  // 开启网络观测，供后续网络维度验证使用。失败不阻断：DOM 维度仍可用。
  await options.send<unknown>({ type: MessageType.CdpNetworkStart, tabId: options.tabId }).catch(() => undefined);

  const dialogSelector = '.dialog-wrap.active, .boss-dialog__wrapper, .greet-dialog';

  if (!(await runner.clickStep('点击打招呼按钮', 'greetButton', { expectDialog: dialogSelector }))) {
    return runner.finish(false);
  }

  if (
    !(await runner.inputStep('输入打招呼内容', 'messageInput', options.message, {
      expectInputValue: { selector: 'textarea.input-area, .chat-input textarea', text: options.message },
    }))
  ) {
    return runner.finish(false);
  }

  const sendVerification: VerifyRequest = {
    ...(options.sendUrlPattern ? { expectNetwork: { urlPattern: options.sendUrlPattern, expectSuccess: true } } : {}),
  };

  const sent =
    options.sendVia === 'enter'
      ? await runner.keyStep('按 Enter 发送', 'Enter', sendVerification)
      : await runner.clickStep('点击发送按钮', 'sendButton', sendVerification);

  return runner.finish(sent);
}

/** 供 UI 展示的进度摘要。 */
export function summarizeSteps(steps: readonly StepRecord[]): { total: number; completed: number; current?: string } {
  const completed = steps.filter((step) => step.ok).length;
  const failed = steps.find((step) => !step.ok);
  return {
    total: steps.length,
    completed,
    ...(failed ? { current: failed.name } : steps.length > 0 ? { current: steps[steps.length - 1]?.name } : {}),
  };
}

export type { ExtensionRequest };
