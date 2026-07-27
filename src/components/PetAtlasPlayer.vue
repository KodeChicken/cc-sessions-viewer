<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

export type PetAnimationState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

type PetFrame = {
  rowIndex: number
  columnIndex: number
  frameDurationMs: number
}

const props = withDefaults(defineProps<{
  src: string
  state: PetAnimationState
  lookFrame?: number | null
  spriteVersionNumber?: 1 | 2
  restartKey?: number
  paused?: boolean
  label?: string
}>(), {
  lookFrame: null,
  spriteVersionNumber: 2,
  restartKey: 0,
  paused: false,
  label: '',
})

function rowFrames(rowIndex: number, count: number, duration: number, lastDuration: number) {
  return Array.from({ length: count }, (_, columnIndex): PetFrame => ({
    rowIndex,
    columnIndex,
    frameDurationMs: columnIndex === count - 1 ? lastDuration : duration,
  }))
}

const idleFrames: PetFrame[] = [280, 110, 110, 140, 140, 320].map(
  (frameDurationMs, columnIndex) => ({ rowIndex: 0, columnIndex, frameDurationMs }),
)
const slowIdleFrames = idleFrames.map((frame) => ({
  ...frame,
  frameDurationMs: frame.frameDurationMs * 6,
}))
const animations: Record<PetAnimationState, PetFrame[]> = {
  idle: idleFrames,
  'running-right': rowFrames(1, 8, 120, 220),
  'running-left': rowFrames(2, 8, 120, 220),
  waving: rowFrames(3, 4, 140, 280),
  jumping: rowFrames(4, 5, 140, 280),
  failed: rowFrames(5, 8, 140, 240),
  waiting: rowFrames(6, 6, 150, 260),
  running: rowFrames(7, 6, 120, 220),
  review: rowFrames(8, 6, 150, 280),
}

const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
const reducedMotion = ref(media?.matches ?? false)
const sequenceIndex = ref(0)
let frameTimer: ReturnType<typeof setTimeout> | null = null

const spriteRowCount = computed(() => props.spriteVersionNumber === 2 ? 11 : 9)
const normalizedLookFrame = computed(() => ((Math.round(props.lookFrame ?? 0) % 16) + 16) % 16)
const hasLookFrame = computed(() => props.spriteVersionNumber === 2 && props.lookFrame != null)
const sequence = computed(() => {
  const stateFrames = animations[props.state]
  if (props.paused || reducedMotion.value) {
    return { frames: [stateFrames[0]], loopStartIndex: null as number | null }
  }
  if (props.state === 'idle') {
    return { frames: slowIdleFrames, loopStartIndex: 0 }
  }
  const transientFrames = [...stateFrames, ...stateFrames, ...stateFrames]
  return {
    frames: [...transientFrames, ...slowIdleFrames],
    loopStartIndex: transientFrames.length,
  }
})
const animatedFrame = computed(() =>
  sequence.value.frames[Math.min(sequenceIndex.value, sequence.value.frames.length - 1)],
)
const row = computed(() => hasLookFrame.value
  ? 9 + Math.floor(normalizedLookFrame.value / 8)
  : animatedFrame.value.rowIndex)
const column = computed(() => hasLookFrame.value
  ? normalizedLookFrame.value % 8
  : animatedFrame.value.columnIndex)
const spriteStyle = computed(() => ({
  backgroundImage: `url(${JSON.stringify(props.src)})`,
  backgroundPosition: `${column.value / 7 * 100}% ${row.value / (spriteRowCount.value - 1) * 100}%`,
  backgroundSize: `800% ${spriteRowCount.value * 100}%`,
}))

function stopAnimation() {
  if (frameTimer) clearTimeout(frameTimer)
  frameTimer = null
}

function playFrame() {
  stopAnimation()
  if (hasLookFrame.value || props.paused || reducedMotion.value) return
  const current = sequence.value.frames[sequenceIndex.value]
  if (!current) return
  frameTimer = setTimeout(() => {
    const next = sequenceIndex.value + 1
    if (next >= sequence.value.frames.length) {
      const loopStart = sequence.value.loopStartIndex
      if (loopStart == null) return
      sequenceIndex.value = loopStart
    } else {
      sequenceIndex.value = next
    }
    playFrame()
  }, current.frameDurationMs)
}

function onReducedMotionChange(event: MediaQueryListEvent) {
  reducedMotion.value = event.matches
}

watch(
  () => [
    props.src,
    props.state,
    props.lookFrame,
    props.spriteVersionNumber,
    props.restartKey,
    props.paused,
    reducedMotion.value,
  ],
  () => {
    sequenceIndex.value = 0
    playFrame()
  },
  { immediate: true },
)

media?.addEventListener?.('change', onReducedMotionChange)
onBeforeUnmount(() => {
  stopAnimation()
  media?.removeEventListener?.('change', onReducedMotionChange)
})
</script>

<template>
  <span
    class="pet-atlas-sprite"
    role="img"
    :aria-label="label"
    :data-state="state"
    :data-row="row"
    :data-frame="column"
    :data-look-frame="hasLookFrame ? normalizedLookFrame : undefined"
    :data-sprite-version="spriteVersionNumber"
    :style="spriteStyle"
  />
</template>

<style scoped>
.pet-atlas-sprite {
  display: block;
  aspect-ratio: 192 / 208;
  background-repeat: no-repeat;
  image-rendering: pixelated;
}
</style>
