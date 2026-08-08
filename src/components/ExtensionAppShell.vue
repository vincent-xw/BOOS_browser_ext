<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description: string;
    statusMessage: string;
    statusType: 'success' | 'warning' | 'info' | 'error';
  }>(),
  {
    statusType: 'warning',
  },
);
</script>

<template>
  <div class="extension-shell">
    <el-card shadow="hover" class="extension-shell__card">
      <template #header>
        <div class="extension-shell__header">
          <div>
            <div class="extension-shell__eyebrow">BOOS Browser Extension</div>
            <h1>{{ title }}</h1>
            <p>{{ description }}</p>
          </div>
          <div class="extension-shell__meta">
            <slot name="header-actions" />
          </div>
        </div>
      </template>

      <el-alert
        :title="statusMessage"
        :type="statusType"
        :closable="false"
        show-icon
        class="extension-shell__alert"
      />

      <slot />
    </el-card>
  </div>
</template>

<style scoped>
.extension-shell {
  padding: 12px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.extension-shell__card {
  border: none;
  border-radius: 12px;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.extension-shell__card :deep(.el-card__body) {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.extension-shell__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.extension-shell__eyebrow {
  margin-bottom: 4px;
  color: #409eff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  color: #111827;
  font-size: 18px;
  line-height: 1.2;
}

p {
  margin: 4px 0 0;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.5;
}

.extension-shell__meta {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.extension-shell__alert {
  margin-bottom: 12px;
  flex-shrink: 0;
}
</style>
