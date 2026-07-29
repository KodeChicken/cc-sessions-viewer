<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  cursorPosition,
  getCurrentWindow,
  LogicalSize,
  monitorFromPoint,
  PhysicalPosition,
} from '@tauri-apps/api/window'
import {
  activeDesktopPet,
  dominantDesktopTaskState,
  desktopPetCharacter,
  desktopPetPosition,
  desktopPetSize,
  fetchDesktopPetTasks,
  focusDesktopPetMain,
  loadDesktopPetCatalog,
  openDesktopPetSession,
  setDesktopPetCharacter,
  setDesktopPetPosition,
  setDesktopPetSize,
  sortDesktopTasks,
  type DesktopPetCharacter,
  type DesktopTask,
  type DesktopTaskState,
} from '../desktopPet'
import { t } from '../i18n'
import DesktopPetFallback from './DesktopPetFallback.vue'
import PetAtlasPlayer, { type PetAnimationState } from './PetAtlasPlayer.vue'

type PointerSample = {
  screenX: number
  screenY: number
}

type DragSession = {
  hasMoved: boolean
  pointerId: number
  startScreenX: number
  startScreenY: number
  screenX: number
  screenY: number
  startWindow: Promise<{ x: number; y: number; scaleFactor: number }>
}

const DRAG_THRESHOLD = 4
const GAZE_HOLD_MS = 1000

const currentWindow = getCurrentWindow()
const characterArea = ref<HTMLElement>()
const hovered = ref(false)
const dragging = ref(false)
const dragState = ref<'running-left' | 'running-right' | null>(null)
const lookFrame = ref<number | null>(null)
const gazeActive = ref(false)
const baseState = ref<PetAnimationState>('waving')
const tasks = ref<DesktopTask[]>([])
const activityOpen = ref(false)
const orderedTasks = computed(() => sortDesktopTasks(tasks.value))
const dominantTaskState = computed(() => dominantDesktopTaskState(tasks.value))
const taskPresentation: Record<DesktopTaskState, {
  animation: PetAnimationState
  icon: string
  labelKey: string
}> = {
  blocked: { animation: 'waiting', icon: '?', labelKey: 'desktopPet.activity.needsInput' },
  failed: { animation: 'failed', icon: '!', labelKey: 'desktopPet.activity.blocked' },
  completed: { animation: 'review', icon: '✓', labelKey: 'desktopPet.activity.ready' },
  started: { animation: 'running', icon: '▶', labelKey: 'desktopPet.activity.running' },
}
const activityAnimation = computed<PetAnimationState | null>(() => {
  const state = dominantTaskState.value
  return state ? taskPresentation[state].animation : null
})
const dominantPresentation = computed(() => {
  const state = dominantTaskState.value
  return state ? taskPresentation[state] : taskPresentation.started
})
const spritesheetSrc = computed(() => activeDesktopPet.value
  ? convertFileSrc(activeDesktopPet.value.spritesheetPath)
  : '')
const animationState = computed<PetAnimationState>(() => {
  if (dragState.value) return dragState.value
  if (hovered.value) return 'waving'
  return activityAnimation.value ?? baseState.value
})
const effectiveLookFrame = computed(() => {
  if (
    !gazeActive.value
    || hovered.value
    || dragging.value
    || activeDesktopPet.value?.spriteVersionNumber !== 2
  ) {
    return null
  }
  return lookFrame.value
})
const avatarStyle = computed(() => ({
  width: `${desktopPetSize.value}px`,
  height: `${desktopPetSize.value * 208 / 192}px`,
}))
const windowSize = computed(() => {
  const avatarWidth = desktopPetSize.value + 16
  const avatarHeight = Math.ceil(desktopPetSize.value * 208 / 192) + 16
  const activityWidth = orderedTasks.value.length ? desktopPetSize.value + 146 : 0
  const trayWidth = activityOpen.value ? 242 : 0
  const trayHeight = activityOpen.value ? 294 : 0
  return {
    width: Math.ceil(Math.max(avatarWidth, activityWidth, trayWidth)),
    height: Math.ceil(Math.max(avatarHeight, trayHeight)),
  }
})
const overlayStyle = computed(() => ({
  '--desktop-pet-size': `${desktopPetSize.value}px`,
}))

let dragSession: DragSession | null = null
let pendingWindowPosition: { x: number; y: number } | null = null
let moveFrame = 0
let cursorTimer: ReturnType<typeof setInterval> | null = null
let wakeTimer: ReturnType<typeof setTimeout> | null = null
let gazeTimer: ReturnType<typeof setTimeout> | null = null
let lastCursorPosition: { x: number; y: number } | null = null
let activityCloseTimer: ReturnType<typeof setTimeout> | null = null
let cursorPollPending = false
let unlisten: UnlistenFn[] = []

async function syncWindowSize() {
  const next = windowSize.value
  await currentWindow.setSize(new LogicalSize(next.width, next.height)).catch(() => {})
}

async function refreshTasks() {
  try {
    tasks.value = await fetchDesktopPetTasks()
    if (!tasks.value.length) activityOpen.value = false
  } catch (error) {
    console.warn('[desktop-pet] failed to load task activity:', error)
  }
}

function showActivity() {
  if (activityCloseTimer) clearTimeout(activityCloseTimer)
  activityCloseTimer = null
  activityOpen.value = true
}

function scheduleActivityClose() {
  if (activityCloseTimer) clearTimeout(activityCloseTimer)
  activityCloseTimer = setTimeout(() => {
    activityOpen.value = false
    activityCloseTimer = null
  }, 220)
}

function formatAgent(agent: string) {
  if (agent === 'claude') return 'Claude Code'
  if (agent === 'codex') return 'Codex'
  if (agent === 'agy') return 'Antigravity'
  return agent
}

async function openTask(task: DesktopTask) {
  try {
    await openDesktopPetSession(task)
  } catch (error) {
    console.warn('[desktop-pet] failed to open task activity:', error)
  }
}

function pointerSample(event: PointerEvent): PointerSample {
  return { screenX: event.screenX, screenY: event.screenY }
}

function hasDragMovement(session: DragSession, sample: PointerSample) {
  return session.hasMoved
    || Math.abs(sample.screenX - session.startScreenX) >= DRAG_THRESHOLD
    || Math.abs(sample.screenY - session.startScreenY) >= DRAG_THRESHOLD
}

function cancelWindowMotion() {
  if (moveFrame) cancelAnimationFrame(moveFrame)
  moveFrame = 0
  pendingWindowPosition = null
}

function queueWindowPosition(position: { x: number; y: number }) {
  pendingWindowPosition = position
  if (moveFrame) return
  moveFrame = requestAnimationFrame(() => {
    moveFrame = 0
    const next = pendingWindowPosition
    pendingWindowPosition = null
    if (next) {
      void currentWindow.setPosition(new PhysicalPosition(Math.round(next.x), Math.round(next.y)))
    }
  })
}

async function persistCurrentPosition(fallback?: { x: number; y: number }) {
  try {
    const position = fallback ?? await currentWindow.outerPosition()
    setDesktopPetPosition({ x: Math.round(position.x), y: Math.round(position.y) })
  } catch {
    // Position persistence is best-effort when the window is closing.
  }
}

async function finishDragMotion(
  session: DragSession,
  release: PointerSample,
) {
  const start = await session.startWindow
  if (moveFrame) cancelAnimationFrame(moveFrame)
  moveFrame = 0
  pendingWindowPosition = null
  const position = {
    x: start.x + (release.screenX - session.startScreenX) * start.scaleFactor,
    y: start.y + (release.screenY - session.startScreenY) * start.scaleFactor,
  }
  await currentWindow.setPosition(new PhysicalPosition(Math.round(position.x), Math.round(position.y)))
  await persistCurrentPosition(position)
}

function beginDrag(event: PointerEvent) {
  if (
    event.button !== 0
    || event.ctrlKey
    || !(event.target instanceof Element)
    || event.target.closest('.no-drag')
  ) return

  event.preventDefault()
  cancelWindowMotion()
  event.currentTarget instanceof Element
    && event.currentTarget.setPointerCapture?.(event.pointerId)
  const sample = pointerSample(event)
  dragSession = {
    hasMoved: false,
    pointerId: event.pointerId,
    startScreenX: sample.screenX,
    startScreenY: sample.screenY,
    screenX: sample.screenX,
    screenY: sample.screenY,
    startWindow: Promise.all([
      currentWindow.outerPosition(),
      currentWindow.scaleFactor(),
    ]).then(([position, scaleFactor]) => ({ ...position, scaleFactor })),
  }
  dragState.value = null
}

function moveDrag(event: PointerEvent) {
  const session = dragSession
  if (!session || session.pointerId !== event.pointerId) return
  event.stopPropagation()
  const sample = pointerSample(event)
  const deltaX = sample.screenX - session.screenX
  const deltaY = sample.screenY - session.screenY
  if (Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) return

  event.preventDefault()
  session.hasMoved = true
  session.screenX = sample.screenX
  session.screenY = sample.screenY
  dragging.value = true
  if (deltaX >= DRAG_THRESHOLD) dragState.value = 'running-right'
  else if (deltaX <= -DRAG_THRESHOLD) dragState.value = 'running-left'

  const totalX = sample.screenX - session.startScreenX
  const totalY = sample.screenY - session.startScreenY
  void session.startWindow.then((start) => {
    if (dragSession !== session) return
    queueWindowPosition({
      x: start.x + totalX * start.scaleFactor,
      y: start.y + totalY * start.scaleFactor,
    })
  })
}

function releasePointer(event: PointerEvent) {
  const element = event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : event.target instanceof HTMLElement ? event.target : null
  if (element?.hasPointerCapture?.(event.pointerId)) {
    element.releasePointerCapture?.(event.pointerId)
  }
}

function endDrag(event: PointerEvent) {
  const session = dragSession
  if (!session || session.pointerId !== event.pointerId) return
  dragSession = null
  releasePointer(event)
  const release = pointerSample(event)

  dragging.value = false
  dragState.value = null
  if (!hasDragMovement(session, release)) {
    void focusDesktopPetMain()
    return
  }
  event.preventDefault()
  void finishDragMotion(session, release)
}

function cancelDrag(event: PointerEvent) {
  const session = dragSession
  if (!session || session.pointerId !== event.pointerId) return
  dragSession = null
  releasePointer(event)
  dragging.value = false
  dragState.value = null
  const release = { screenX: session.screenX, screenY: session.screenY }
  if (session.hasMoved) void finishDragMotion(session, release)
  else void persistCurrentPosition()
}

function updateLookDirection(deltaX: number, deltaY: number, deadZone: number) {
  if (Math.hypot(deltaX, deltaY) <= deadZone) {
    lookFrame.value = null
    return
  }
  const angle = Math.atan2(deltaX, -deltaY)
  lookFrame.value = (Math.round(angle / (Math.PI / 8)) + 16) % 16
}

function activateGaze() {
  gazeActive.value = true
  if (gazeTimer) clearTimeout(gazeTimer)
  gazeTimer = setTimeout(() => {
    gazeActive.value = false
    gazeTimer = null
  }, GAZE_HOLD_MS)
}

function updateLocalLook(event: PointerEvent) {
  const bounds = characterArea.value?.getBoundingClientRect()
  if (!bounds) return
  if (!dragging.value) activateGaze()
  updateLookDirection(
    event.clientX - (bounds.left + bounds.width / 2),
    event.clientY - (bounds.top + bounds.height / 2),
    1,
  )
}

async function pollGlobalCursor() {
  if (cursorPollPending || !characterArea.value || dragging.value) return
  cursorPollPending = true
  try {
    const [pointer, windowPosition, scaleFactor] = await Promise.all([
      cursorPosition(),
      currentWindow.outerPosition(),
      currentWindow.scaleFactor(),
    ])
    if (lastCursorPosition && (
      pointer.x !== lastCursorPosition.x || pointer.y !== lastCursorPosition.y
    )) {
      activateGaze()
    }
    lastCursorPosition = { x: pointer.x, y: pointer.y }
    const bounds = characterArea.value.getBoundingClientRect()
    const centerX = windowPosition.x + (bounds.left + bounds.width / 2) * scaleFactor
    const centerY = windowPosition.y + (bounds.top + bounds.height / 2) * scaleFactor
    updateLookDirection(pointer.x - centerX, pointer.y - centerY, scaleFactor)
  } catch {
    // Local pointer events remain available in tests and unsupported environments.
  } finally {
    cursorPollPending = false
  }
}

async function restoreWindowPosition() {
  const saved = desktopPetPosition.value
  if (!saved) return
  const monitor = await monitorFromPoint(saved.x + 1, saved.y + 1)
  if (monitor) await currentWindow.setPosition(new PhysicalPosition(saved.x, saved.y))
}

onMounted(async () => {
  await loadDesktopPetCatalog().catch((error) => {
    console.warn('[desktop-pet] failed to load pet catalog:', error)
  })
  await restoreWindowPosition().catch(() => {})

  unlisten = await Promise.all([
    listen<{ character?: DesktopPetCharacter; size?: number }>(
      'desktop-pet://preferences',
      async (event) => {
        if (event.payload?.character) setDesktopPetCharacter(event.payload.character)
        if (event.payload?.size != null) setDesktopPetSize(event.payload.size)
        await loadDesktopPetCatalog().catch(() => {})
      },
    ),
    listen('terminal-turn://state', () => refreshTasks()),
    listen('desktop-pet://activity-acknowledged', () => refreshTasks()),
  ])
  await refreshTasks()
  await syncWindowSize()
  await currentWindow.show().catch(() => {})
  cursorTimer = setInterval(pollGlobalCursor, 50)
  wakeTimer = setTimeout(() => { baseState.value = 'idle' }, 8000)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', cancelDrag)
  void pollGlobalCursor()
})

onUnmounted(() => {
  cancelWindowMotion()
  if (cursorTimer) clearInterval(cursorTimer)
  if (wakeTimer) clearTimeout(wakeTimer)
  if (gazeTimer) clearTimeout(gazeTimer)
  if (activityCloseTimer) clearTimeout(activityCloseTimer)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', cancelDrag)
  for (const stop of unlisten) stop()
})

watch(
  () => [desktopPetSize.value, orderedTasks.value.length, activityOpen.value],
  () => { void syncWindowSize() },
  { immediate: true },
)
</script>

<template>
  <main class="desktop-avatar-overlay" :style="overlayStyle" @pointermove="updateLocalLook">
    <section v-if="orderedTasks.length" class="activity-shell no-drag">
      <button
        type="button"
        class="activity-trigger"
        :class="`is-${dominantTaskState}`"
        :data-state="dominantTaskState"
        :aria-expanded="activityOpen"
        @click="activityOpen ? scheduleActivityClose() : showActivity()"
        @mouseenter="showActivity"
        @mouseleave="scheduleActivityClose"
        @focus="showActivity"
        @blur="scheduleActivityClose"
      >
        <span class="activity-trigger-icon">{{ dominantPresentation.icon }}</span>
        <span>{{ t(dominantPresentation.labelKey) }}</span>
      </button>

      <Transition name="activity-tray">
        <div
          v-if="activityOpen"
          class="activity-tray"
          @mouseenter="showActivity"
          @mouseleave="scheduleActivityClose"
        >
          <div class="activity-tray-title">{{ t('desktopPet.activity.title') }}</div>
          <div class="activity-list">
            <button
              v-for="task in orderedTasks"
              :key="`${task.agent}:${task.path}`"
              type="button"
              class="activity-item"
              :class="`is-${task.state}`"
              @click="openTask(task)"
            >
              <span class="activity-item-icon">{{ taskPresentation[task.state].icon }}</span>
              <span class="activity-item-copy">
                <span class="activity-item-agent">{{ formatAgent(task.agent) }}</span>
                <span class="activity-item-title">{{ task.title }}</span>
              </span>
              <span class="activity-item-status">{{ t(taskPresentation[task.state].labelKey) }}</span>
            </button>
          </div>
        </div>
      </Transition>
    </section>

    <div
      ref="characterArea"
      class="avatar-button"
      :class="{ dragging }"
      :style="avatarStyle"
      role="img"
      :aria-label="activeDesktopPet?.displayName || 'Codex pet'"
      @pointerenter="hovered = true"
      @pointerleave="hovered = false"
      @pointerdown="beginDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="cancelDrag"
      @lostpointercapture="cancelDrag"
    >
      <PetAtlasPlayer
        v-if="spritesheetSrc"
        class="avatar-sprite"
        :src="spritesheetSrc"
        :state="animationState"
        :look-frame="effectiveLookFrame"
        :sprite-version-number="activeDesktopPet?.spriteVersionNumber"
        :label="activeDesktopPet?.displayName"
        :data-character="desktopPetCharacter"
      />
      <DesktopPetFallback
        v-else
        class="avatar-sprite"
        :state="animationState"
        :label="activeDesktopPet?.displayName || 'Codex pet'"
        :data-character="desktopPetCharacter"
      />
    </div>
  </main>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent !important;
}

.desktop-avatar-overlay {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
}

.activity-shell {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  font-family: Inter, ui-rounded, "SF Pro Rounded", "Microsoft YaHei", sans-serif;
}

.activity-trigger {
  position: absolute;
  right: calc(var(--desktop-pet-size) + 14px);
  bottom: 28px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 116px;
  min-height: 30px;
  padding: 5px 9px 5px 6px;
  border: 1px solid rgba(74, 67, 91, .13);
  border-radius: 999px;
  background: rgba(255, 255, 255, .92);
  box-shadow: 0 7px 20px rgba(42, 34, 64, .15);
  color: #51495e;
  font: 600 11px/1.2 inherit;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: auto;
  backdrop-filter: blur(12px);
}

.activity-trigger:hover,
.activity-trigger:focus-visible {
  transform: translateY(-1px);
  border-color: rgba(102, 84, 171, .26);
  outline: none;
}

.activity-trigger-icon,
.activity-item-icon {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #eef0ff;
  color: #6555a4;
  font-size: 10px;
  font-weight: 800;
}

.activity-trigger.is-blocked .activity-trigger-icon,
.activity-item.is-blocked .activity-item-icon {
  background: #fff2d9;
  color: #a56608;
}

.activity-trigger.is-failed .activity-trigger-icon,
.activity-item.is-failed .activity-item-icon {
  background: #ffe9ec;
  color: #c34758;
}

.activity-trigger.is-completed .activity-trigger-icon,
.activity-item.is-completed .activity-item-icon {
  background: #e5f7ee;
  color: #23865a;
}

.activity-tray {
  position: absolute;
  left: 8px;
  bottom: 64px;
  box-sizing: border-box;
  width: 226px;
  max-height: 222px;
  padding: 8px;
  overflow: hidden;
  border: 1px solid rgba(66, 57, 84, .12);
  border-radius: 15px;
  background: rgba(255, 255, 255, .95);
  box-shadow: 0 16px 38px rgba(37, 29, 55, .2);
  pointer-events: auto;
  backdrop-filter: blur(18px);
}

.activity-tray-title {
  padding: 2px 6px 7px;
  color: #6c6477;
  font-size: 11px;
  font-weight: 700;
}

.activity-list {
  display: grid;
  gap: 4px;
  max-height: 190px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.activity-item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 42px;
  padding: 6px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #494251;
  text-align: left;
  cursor: pointer;
}

.activity-item:hover,
.activity-item:focus-visible {
  background: rgba(103, 87, 159, .08);
  outline: none;
}

.activity-item-copy {
  display: grid;
  min-width: 0;
}

.activity-item-agent {
  color: #8a8293;
  font-size: 9px;
  font-weight: 700;
}

.activity-item-title {
  overflow: hidden;
  color: #443d4c;
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-item-status {
  color: #8a8293;
  font-size: 9px;
  white-space: nowrap;
}

.activity-tray-enter-active,
.activity-tray-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
  transform-origin: bottom right;
}

.activity-tray-enter-from,
.activity-tray-leave-to {
  opacity: 0;
  transform: translateY(5px) scale(.98);
}

.avatar-button {
  position: absolute;
  right: 8px;
  bottom: 8px;
  cursor: grab;
  touch-action: none;
}

.avatar-button.dragging {
  cursor: grabbing;
}

.avatar-sprite {
  width: 100%;
  pointer-events: none;
}

</style>
