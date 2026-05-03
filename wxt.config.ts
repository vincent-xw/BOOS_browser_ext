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
    permissions: ['activeTab', 'scripting', 'tabs'],
    action: {
      default_title: 'BOOS Browser AI Extension',
    },
  },
});
