import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  webExt: {
    // 仅启动开发监听，不自动拉起新的浏览器窗口。
    // 这样可以在你当前已打开的 Chrome 窗口中手动加载开发版扩展。
    disabled: true,
  },
  manifest: {
    name: 'BOOS Browser AI Extension',
    description: '基于 Vue 3 与 Element Plus 的浏览器插件基础架构。',
    // debugger：页面写操作全部经 chrome.debugger + CDP 下发真实事件。
    // DOM 合成事件的 isTrusted 为 false，拿不到真实焦点与 user activation。
    // webNavigation：枚举 frame 以做跨 frame 聚合定位，不退化为只读主 frame。
    permissions: ['activeTab', 'scripting', 'tabs', 'sidePanel', 'webRequest', 'webNavigation', 'debugger', 'storage'],
    // Ark 端点已移除：模型凭据只由 BFF 持有，扩展不再直连模型接口。
    host_permissions: ['https://*.zhipin.com/*', 'http://localhost/*'],
    action: {
      default_title: 'BOOS Browser AI Extension',
    },
  },
});
