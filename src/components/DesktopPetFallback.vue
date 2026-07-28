<script setup lang="ts">
import codexMark from '../assets/codex.svg'
import type { PetAnimationState } from './PetAtlasPlayer.vue'

withDefaults(defineProps<{
  state?: PetAnimationState
  label?: string
  paused?: boolean
}>(), {
  state: 'idle',
  label: 'Codex pet',
  paused: false,
})
</script>

<template>
  <span
    class="desktop-pet-fallback"
    :class="[`is-${state}`, { paused }]"
    role="img"
    :aria-label="label"
    :data-state="state"
  >
    <img class="desktop-pet-fallback-mark" :src="codexMark" alt="" draggable="false">
  </span>
</template>

<style scoped>
.desktop-pet-fallback {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 192 / 208;
  overflow: visible;
  border-radius: 36%;
  background:
    radial-gradient(circle at 34% 28%, rgba(255, 255, 255, .95), rgba(255, 255, 255, .58) 44%, rgba(255, 255, 255, .18) 72%),
    linear-gradient(145deg, rgba(185, 180, 255, .86), rgba(106, 145, 255, .76));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .76),
    0 10px 22px rgba(39, 33, 72, .2);
  transform-origin: 50% 76%;
  animation: fallback-breathe 2.8s ease-in-out infinite;
}

.desktop-pet-fallback::after {
  position: absolute;
  right: 18%;
  bottom: 7%;
  left: 18%;
  height: 9%;
  border-radius: 50%;
  background: rgba(35, 31, 55, .18);
  filter: blur(2px);
  content: "";
}

.desktop-pet-fallback-mark {
  position: relative;
  z-index: 1;
  width: 66%;
  height: 66%;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 5px 8px rgba(35, 31, 65, .16));
}

.desktop-pet-fallback.is-waving:not(.paused) .desktop-pet-fallback-mark {
  animation: fallback-wave 1.2s ease-in-out infinite;
}

.desktop-pet-fallback.is-jumping:not(.paused) {
  animation: fallback-jump .74s ease-in-out infinite;
}

.desktop-pet-fallback:is(.is-running, .is-running-left, .is-running-right):not(.paused) {
  animation: fallback-run .46s ease-in-out infinite;
}

.desktop-pet-fallback.is-waiting:not(.paused) {
  animation: fallback-wait 1s ease-in-out infinite;
}

.desktop-pet-fallback.is-failed:not(.paused) {
  animation: fallback-shake .38s ease-in-out infinite;
}

.desktop-pet-fallback.is-review:not(.paused) {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .78),
    0 0 0 4px rgba(63, 174, 120, .12),
    0 12px 24px rgba(39, 33, 72, .2);
}

.desktop-pet-fallback.paused,
.desktop-pet-fallback.paused .desktop-pet-fallback-mark {
  animation: none;
}

@keyframes fallback-breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-3%) scale(1.02); }
}

@keyframes fallback-wave {
  0%, 100% { transform: rotate(0deg); }
  35% { transform: rotate(-7deg); }
  70% { transform: rotate(6deg); }
}

@keyframes fallback-jump {
  0%, 100% { transform: translateY(0) scale(1); }
  45% { transform: translateY(-11%) scale(1.03); }
}

@keyframes fallback-run {
  0%, 100% { transform: translateX(-2%) rotate(-2deg); }
  50% { transform: translateX(2%) rotate(2deg); }
}

@keyframes fallback-wait {
  0%, 100% { transform: translateY(0); filter: saturate(1); }
  50% { transform: translateY(-2%); filter: saturate(1.25); }
}

@keyframes fallback-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3%); }
  75% { transform: translateX(3%); }
}
</style>
