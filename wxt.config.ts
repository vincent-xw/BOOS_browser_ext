import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  outDir: 'output',
  webExt: {
    disabled: true,
  },
  manifest: {
    name: 'BOOS Browser AI Assistant',
    description: '浏览器 AI 助手：BFF 驱动，浏览器插件只做页面操作。',
    // debugger：页面写操作全部经 chrome.debugger + CDP 下发真实事件。
    // DOM 合成事件的 isTrusted 为 false，拿不到真实焦点与 user activation。
    // webNavigation：枚举 frame 以做跨 frame 聚合定位，不退化为只读主 frame。
    permissions: ['activeTab', 'scripting', 'tabs', 'sidePanel', 'webNavigation', 'debugger', 'storage', 'downloads'],
    host_permissions: ['http://localhost/*'],
    optional_host_permissions: ['*://*/*'],
    action: {
      default_title: 'BOOS Browser AI Assistant',
    },
    // sidepanel 嵌入 BFF Web UI 需要允许 frame-src
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; frame-src http://localhost:8787 http://127.0.0.1:8787",
    },
  },
});
