import { defineContentScript } from 'wxt/utils/define-content-script';

import { MessageType } from '../src/types/messages';
import type { ExtensionRequest, MessageResponse } from '../src/types/messages';
import { captureBaseline, clearRefRegistry, locateElement, readPageSnapshot, resolveRef, snapshotInteractive, verify, waitFor } from '../src/services/domLocator';

/**
 * content script：只读。
 *
 * 职责限定为 DOM 读取、元素定位、坐标计算、结果验证。
 * 这里不存在任何页面写操作 —— 所有点击/输入/按键都经 Service Worker 的 CDP 通道下发，
 * 因为 DOM 合成事件的 isTrusted 为 false，拿不到真实焦点与 user activation。
 */
export default defineContentScript({
  // 静态声明留空：实际注册范围由 permissionService 按白名单动态注册。
  // 这里保留一个不会自动匹配的占位，避免安装时索取任何站点权限。
  matches: ['https://www.zhipin.com/*'],
  allFrames: true,
  main() {
    // 变更前基线由 locate/verify 之间共享：domChanged 维度需要「之前是什么」才能判定变化。
    let baseline: Record<string, string> = {};

    // SPA 导航后清空 ref 注册表：旧 ref 不该命中新页面的元素。
    // popstate 覆盖前进/后退，pushState 由 SPA 路由触发。
    window.addEventListener('popstate', clearRefRegistry);
    window.addEventListener('pagehide', clearRefRegistry);

    chrome.runtime.onMessage.addListener((message: ExtensionRequest, _sender, sendResponse) => {
      const respond = (response: MessageResponse) => sendResponse(response);

      switch (message?.type) {
        case MessageType.ContentPing:
          respond({ ok: true, data: { ready: true, frame: window === window.top ? 'main' : window.location.href } });
          return false;

        case MessageType.ContentLocate: {
          const result = locateElement(message.locator);
          // 定位命中时顺带记录基线，供后续 verify 的 domChanged 维度使用。
          if (result.found && result.matchedSelector) {
            baseline = { ...baseline, ...captureBaseline([result.matchedSelector]) };
          }
          respond({ ok: true, data: result });
          return false;
        }

        case MessageType.ContentReadPage:
          respond({ ok: true, data: readPageSnapshot() });
          return false;

        case MessageType.ContentSnapshot:
          respond({ ok: true, data: snapshotInteractive() });
          return false;

        case MessageType.ContentResolveRef:
          respond({ ok: true, data: resolveRef(message.ref) });
          return false;

        case MessageType.ContentVerify:
          // 异步分支：verify 内部轮询，必须 return true 保持 sendResponse 通道打开。
          verify(message.request, baseline)
            .then((result) => respond({ ok: true, data: result }))
            .catch((error: unknown) => {
              respond({
                ok: false,
                code: 'INVALID_INPUT',
                message: '验证执行失败',
                details: error instanceof Error ? error.message : String(error),
              });
            });
          return true;

        case MessageType.ContentWaitFor:
          // 异步分支：内部轮询/监听 mutation，必须 return true 保持 sendResponse 通道打开。
          waitFor(message.request)
            .then((result) => respond({ ok: true, data: result }))
            .catch((error: unknown) => {
              respond({
                ok: false,
                code: 'INVALID_INPUT',
                message: '等待执行失败',
                details: error instanceof Error ? error.message : String(error),
              });
            });
          return true;

        default:
          return false;
      }
    });
  },
});
