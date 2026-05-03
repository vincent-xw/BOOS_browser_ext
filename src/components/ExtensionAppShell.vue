<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description: string;
    providerLabel: string;
    modeLabel: string;
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
            <div class="extension-shell__tags">
              <el-tag type="primary" effect="light">{{ providerLabel }}</el-tag>
              <el-tag type="success" effect="plain">{{ modeLabel }}</el-tag>
            </div>
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
  padding: 18px;
}

.extension-shell__card {
  border: none;
  border-radius: 18px;
}

.extension-shell__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.extension-shell__eyebrow {
  margin-bottom: 6px;
  color: #409eff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  color: #111827;
  font-size: 22px;
  line-height: 1.2;
}

p {
  margin: 8px 0 0;
  max-width: 280px;
  color: #6b7280;
  font-size: 13px;
  line-height: 1.6;
}

.extension-shell__tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.extension-shell__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.extension-shell__alert {
  margin-bottom: 16px;
}
</style>
