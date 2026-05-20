<script setup lang="ts">
import { t } from '../i18n'

defineProps<{
  show: boolean
  title: string
  message: string
  okText: string
  danger: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="overlay overlay-confirm" @click.self="emit('cancel')">
      <div class="modal">
        <h3>{{ title }}</h3>
        <p>{{ message }}</p>
        <div class="modal-actions">
          <button class="btn" @click="emit('cancel')">
            {{ t('common.cancel') }}
          </button>
          <button
            class="btn"
            :class="danger ? 'danger' : 'primary'"
            @click="emit('confirm')"
          >
            {{ okText }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
