import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => {
      console.warn('[BOOS] Failed to enable openPanelOnActionClick:', error);
    });
});
