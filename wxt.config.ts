import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // 默认产物目录是 .output，隐藏目录在 Finder 里默认看不见、不便于手动加载扩展。
  outDir: 'output',
  webExt: {
    // 仅启动开发监听，不自动拉起新的浏览器窗口。
    // 这样可以在你当前已打开的 Chrome 窗口中手动加载开发版扩展。
    disabled: true,
  },
  manifest: {
    name: 'BOOS Browser AI Extension',
    description: '基于 Vue 3 与 Element Plus 的浏览器 AI 助手：用自然语言指令驱动网页操作。',
    // debugger：页面写操作全部经 chrome.debugger + CDP 下发真实事件。
    // DOM 合成事件的 isTrusted 为 false，拿不到真实焦点与 user activation。
    // webNavigation：枚举 frame 以做跨 frame 聚合定位，不退化为只读主 frame。
    permissions: ['activeTab', 'scripting', 'tabs', 'sidePanel', 'webNavigation', 'debugger', 'storage', 'downloads'],
    // BFF 运行在 localhost，需要访问权限；其他站点由用户在设置里显式添加（见下方 optional_host_permissions）。
    host_permissions: ['http://localhost/*'],
    /**
     * 调试期可操作任意页面，但域名要由用户在设置里显式添加 ——
     * 声明为 optional 而非直接要 <all_urls>，安装时不会索取「读取所有网站数据」。
     * content script 通过 chrome.scripting.registerContentScripts 动态注册。
     */
    optional_host_permissions: ['*://*/*'],
    action: {
      default_title: 'BOOS Browser AI Extension',
    },
  },
});
