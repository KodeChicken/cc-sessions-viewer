<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    maxHeight?: number
    enabled?: boolean
  }>(),
  { maxHeight: 320, enabled: true },
)
</script>

<template>
  <slot v-if="!enabled" />
  <div v-else class="collapsible-box" :style="{ maxHeight: props.maxHeight + 'px' }">
    <div
      class="collapsible-inner"
    >
      <slot />
    </div>
  </div>
</template>
