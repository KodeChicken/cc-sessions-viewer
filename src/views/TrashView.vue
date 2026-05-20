<script setup lang="ts">
import type { TrashItem } from '../types'
import { formatSize, formatTime, shortName } from '../format'
import { t } from '../i18n'
import { IconTrashOpen } from '../components/icons'

defineProps<{
  trash: TrashItem[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'clear'): void
  (e: 'restore', item: TrashItem): void
  (e: 'permanent-delete', item: TrashItem): void
}>()
</script>

<template>
  <div class="list-head list-head-row">
    <div class="grow">
      <h2>{{ t('trash.title') }}</h2>
      <div class="path">{{ t('trash.subtitle') }}</div>
    </div>
    <button class="btn danger" :disabled="!trash.length" @click="emit('clear')">
      {{ t('trash.clearAll') }}
    </button>
  </div>
  <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
  <div v-else-if="!trash.length" class="empty">
    <div class="big"><IconTrashOpen /></div>
    <div>{{ t('trash.empty') }}</div>
  </div>
  <div v-else class="scroll-area">
    <div
      v-for="item in trash"
      :key="item.trashFile"
      class="session-card"
      style="cursor: default"
    >
      <div class="session-main">
        <div class="session-title">
          <span class="agent-badge" :class="item.agent">{{
            item.agent === 'codex' ? 'Codex' : 'Claude'
          }}</span>
          {{ item.title }}
        </div>
        <div class="session-meta">
          <span>{{ shortName(item.projectLabel) || '—' }}</span>
          <span>{{ formatSize(item.size) }}</span>
          <span>{{
            t('trash.deletedAt', { time: formatTime(item.deletedAt) })
          }}</span>
        </div>
      </div>
      <div class="session-actions" style="opacity: 1">
        <button class="btn" @click="emit('restore', item)">
          {{ t('trash.restore') }}
        </button>
        <button class="btn danger" @click="emit('permanent-delete', item)">
          {{ t('trash.permDelete') }}
        </button>
      </div>
    </div>
  </div>
</template>
