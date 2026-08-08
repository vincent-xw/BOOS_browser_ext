<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Delete, Check, Edit } from '@element-plus/icons-vue';
import { useSkillController } from '../composables/useSkillController';
import type { Skill } from '../services/skillStore';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'apply', skill: Skill): void;
}>();

const { skills, refresh, rename, remove } = useSkillController();

/** 正在编辑名称的技能 id。 */
const editingId = ref<string | null>(null);
const editingName = ref('');

onMounted(() => {
  void refresh();
});

function startEdit(skill: Skill) {
  editingId.value = skill.id;
  editingName.value = skill.name;
}

function confirmEdit() {
  if (editingId.value) {
    void rename(editingId.value, editingName.value);
  }
  editingId.value = null;
}

function handleApply(skill: Skill) {
  emit('apply', skill);
  emit('update:modelValue', false);
}
</script>

<template>
  <el-drawer
    :model-value="props.modelValue"
    title="技能管理"
    size="80%"
    @update:model-value="emit('update:modelValue', $event)"
    @open="refresh"
  >
    <el-space v-if="skills.length" direction="vertical" fill :size="12" style="width: 100%">
      <el-card v-for="skill in skills" :key="skill.id" shadow="never">
        <div class="skill-card">
          <div class="skill-header">
            <template v-if="editingId === skill.id">
              <el-input v-model="editingName" size="small" style="flex: 1" @keydown.enter="confirmEdit" />
              <el-button :icon="Check" size="small" type="primary" plain @click="confirmEdit" />
            </template>
            <template v-else>
              <el-text tag="b" class="skill-name">{{ skill.name }}</el-text>
              <el-button :icon="Edit" link size="small" @click="startEdit(skill)" />
            </template>
          </div>
          <el-text size="small" type="info" class="skill-instruction">{{ skill.firstInstruction }}</el-text>
          <el-text v-if="skill.finalReplySummary" size="small" type="info" class="skill-reply">
            {{ skill.finalReplySummary.slice(0, 100) }}{{ skill.finalReplySummary.length > 100 ? '…' : '' }}
          </el-text>
          <div class="skill-actions">
            <el-button type="primary" size="small" plain @click="handleApply(skill)">应用</el-button>
            <el-button :icon="Delete" type="danger" size="small" link @click="remove(skill.id)">删除</el-button>
          </div>
        </div>
      </el-card>
    </el-space>

    <el-empty v-else description="尚未保存任何技能。在对话中点击「保存为技能」即可收藏好用的指令。" />
  </el-drawer>
</template>

<style scoped>
.skill-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-instruction {
  display: block;
  padding: 4px 8px;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
  font-size: 12px;
}

.skill-reply {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.skill-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
</style>
