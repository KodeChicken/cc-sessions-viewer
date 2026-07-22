<script setup lang="ts">
defineProps<{
  direction: 'asc' | 'desc' | null
}>()
</script>

<template>
  <svg
    class="creation-sort-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <g
      class="creation-sort-icon__arrow creation-sort-icon__arrow--down"
      :class="{ 'is-active': direction === 'desc' }"
    >
      <path d="m3 16 4 4 4-4" />
      <path d="M7 20V4" />
    </g>
    <g
      class="creation-sort-icon__arrow creation-sort-icon__arrow--up"
      :class="{ 'is-active': direction === 'asc' }"
    >
      <path d="m21 8-4-4-4 4" />
      <path d="M17 4v16" />
    </g>
  </svg>
</template>

<style scoped>
.creation-sort-icon {
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.creation-sort-icon__arrow {
  stroke: var(--text-mute);
  transition: stroke 0.12s ease;
}

.creation-sort-icon__arrow.is-active {
  stroke: var(--link);
}

@media (prefers-reduced-motion: reduce) {
  .creation-sort-icon__arrow {
    transition: none;
  }
}
</style>
