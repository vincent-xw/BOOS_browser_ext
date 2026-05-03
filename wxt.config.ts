import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'BOOS Browser Extension',
    description: '基于 Vue 3 与 Element Plus 的浏览器插件基础架构。',
    permissions: ['activeTab', 'scripting', 'tabs'],
    action: {
      default_title: 'BOOS Browser Extension',
    },
  },
});
