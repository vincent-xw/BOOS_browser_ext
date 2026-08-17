import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  outDir: 'output',
  webExt: {
    disabled: true,
  },
  manifest: {
    name: 'BOOS Browser AI Assistant',
    description: 'BFF 驱动浏览器 AI 助手：侧边栏嵌入 BFF Web UI，后台通过 WS 执行页面操作。',
    permissions: ['activeTab', 'scripting', 'tabs', 'sidePanel', 'webNavigation', 'debugger', 'storage', 'downloads'],
    host_permissions: ['http://localhost/*'],
    optional_host_permissions: ['*://*/*'],
    action: {
      default_title: 'BOOS Browser AI Assistant',
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; frame-src http://localhost:8787 http://127.0.0.1:8787",
    },
  },
});
