<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { settingsService } from '../../src/services/settingsService';

const settings = ref(settingsService.load().normalized);
const showSettings = ref(false);
const bffUrl = ref('http://localhost:8787');
const bffToken = ref('');

function loadBffConfig() {
  const saved = settingsService.load();
  settings.value = saved.normalized;
  bffUrl.value = settings.value.advanced.bffBaseUrl || 'http://localhost:8787';
  bffToken.value = settings.value.advanced.bffApiToken || '';
}

const iframeSrc = computed(() => {
  const url = bffUrl.value.replace(/\/+$/, '');
  return `${url}/?token=${encodeURIComponent(bffToken.value)}`;
});

function saveBffConfig() {
  settingsService.save({
    ...settings.value,
    advanced: {
      ...settings.value.advanced,
      bffBaseUrl: bffUrl.value,
      bffApiToken: bffToken.value,
    },
  });
  showSettings.value = false;
  // 更新 iframe（通过改变 iframeSrc 触发）
  loadBffConfig();
}

onMounted(loadBffConfig);
</script>

<template>
  <div class="iframe-container">
    <iframe :src="iframeSrc" frameborder="0" />
    <button class="settings-btn" @click="showSettings = true" title="BFF 设置">⚙</button>

    <div v-if="showSettings" class="overlay" @click.self="showSettings = false">
      <div class="overlay-content">
        <h3>BFF 设置</h3>
        <label>
          BFF 地址
          <input v-model="bffUrl" placeholder="http://localhost:8787" />
        </label>
        <label>
          BFF Token
          <input v-model="bffToken" type="password" placeholder="dev-token" />
        </label>
        <button @click="saveBffConfig">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.iframe-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  position: relative;
}
iframe {
  flex: 1;
  width: 100%;
  border: none;
}
.settings-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 10;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid #aaa;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
  opacity: 0.7;
  line-height: 28px;
  text-align: center;
}
.settings-btn:hover { opacity: 1; }
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.overlay-content {
  background: #fff;
  padding: 20px;
  border-radius: 8px;
  min-width: 260px;
  max-width: 90%;
}
.overlay-content h3 {
  margin: 0 0 12px;
  font-size: 15px;
}
.overlay-content label {
  display: block;
  margin: 12px 0;
  font-size: 13px;
}
.overlay-content input {
  width: 100%;
  padding: 6px 8px;
  margin-top: 4px;
  box-sizing: border-box;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
}
.overlay-content button {
  margin-top: 12px;
  background: #4f8cff;
  color: #fff;
  border: none;
  padding: 8px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
</style>