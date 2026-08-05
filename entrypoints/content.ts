import { defineContentScript } from 'wxt/utils/define-content-script';

import { MessageType } from '../src/types/messages';
import type { ExtensionRequest, MessageResponse } from '../src/types/messages';
import { captureBaseline, locateElement, readPageSnapshot, verify } from '../src/services/domLocator';

/**
 * content script：只读。
 *
 * 职责限定为 DOM 读取、元素定位、坐标计算、结果验证。
 * 这里不存在任何页面写操作 —— 所有点击/输入/按键都经 Service Worker 的 CDP 通道下发，
 * 因为 DOM 合成事件的 isTrusted 为 false，拿不到真实焦点与 user activation。
 */
export default defineContentScript({
  matches: ['https://*.zhipin.com/*'],
  allFrames: true,
  main() {
    // 变更前基线由 locate/verify 之间共享：domChanged 维度需要「之前是什么」才能判定变化。
    let baseline: Record<string, string> = {};

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
          respond({ ok: true, data: readPageSnapshot(message.includeCandidateList ?? false) });
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

        default:
          return false;
      }
    });
  },
});
