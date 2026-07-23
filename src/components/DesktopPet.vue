<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { t } from '../i18n'
import {
  desktopPetCharacter,
  fetchDesktopPetTasks,
  groupDesktopTasks,
  openDesktopPetSession,
  setDesktopPetCharacter,
  type DesktopPetCharacter,
  type DesktopTask,
  type DesktopTaskState,
} from '../desktopPet'
import momoSvg from '../assets/desktop-pets/momo.svg?raw'
import lumiSvg from '../assets/desktop-pets/lumi.svg?raw'
import kumoSvg from '../assets/desktop-pets/kumo.svg?raw'

const characterImages: Record<DesktopPetCharacter, string> = {
  momo: momoSvg,
  lumi: lumiSvg,
  kumo: kumoSvg,
}

const statuses: Array<{ state: DesktopTaskState; icon: string; labelKey: string }> = [
  { state: 'started', icon: '▶', labelKey: 'desktopPet.status.running' },
  { state: 'blocked', icon: '?', labelKey: 'desktopPet.status.approval' },
  { state: 'completed', icon: '✓', labelKey: 'desktopPet.status.completed' },
  { state: 'failed', icon: '!', labelKey: 'desktopPet.status.failed' },
]

const tasks = ref<DesktopTask[]>([])
const panelOpen = ref(false)
const celebrating = ref(false)
const celebrationRound = ref(0)
const groups = computed(() => groupDesktopTasks(tasks.value))
const orderedTasks = computed(() => statuses.flatMap((status) => groups.value[status.state]))
const hasRunning = computed(() => groups.value.started.length > 0)
const hasBlocked = computed(() => groups.value.blocked.length > 0)
const hasFailed = computed(() => groups.value.failed.length > 0)
const characterSvg = computed(() => characterImages[desktopPetCharacter.value])
const statusByState = Object.fromEntries(
  statuses.map((status) => [status.state, status]),
) as Record<DesktopTaskState, (typeof statuses)[number]>
const noticeDefinitions = [
  { state: 'completed', icon: '✓', labelKey: 'desktopPet.completedNotice' },
  { state: 'blocked', icon: '?', labelKey: 'desktopPet.approvalNotice' },
  { state: 'failed', icon: '!', labelKey: 'desktopPet.failedNotice' },
] as const
const taskNotices = computed(() => noticeDefinitions.flatMap((notice) => {
  const task = groups.value[notice.state].reduce<DesktopTask | null>(
    (latest, item) => !latest || item.updatedAt > latest.updatedAt ? item : latest,
    null,
  )
  return task ? [{ ...notice, task }] : []
}))
let unlisten: UnlistenFn[] = []
let panelCloseTimer: ReturnType<typeof setTimeout> | null = null
let celebrationTimer: ReturnType<typeof setTimeout> | null = null
const dismissedCompletedTasks = new Set<string>()

type TerminalTurnEvent = {
  agent?: string
  path?: string
  state?: string
}

async function refreshTasks() {
  try {
    const snapshot = await fetchDesktopPetTasks()
    tasks.value = snapshot.filter((task) =>
      task.state !== 'completed' || !dismissedCompletedTasks.has(taskIdentity(task)),
    )
  } catch (error) {
    console.warn('[desktop-pet] failed to load tasks:', error)
  }
}

function showPanel() {
  if (panelCloseTimer) clearTimeout(panelCloseTimer)
  panelCloseTimer = null
  panelOpen.value = true
}

function schedulePanelClose() {
  if (panelCloseTimer) clearTimeout(panelCloseTimer)
  panelCloseTimer = setTimeout(() => {
    panelOpen.value = false
    panelCloseTimer = null
  }, 180)
}

function triggerCompletionReminder(task: DesktopTask | null) {
  if (!task) return
  if (celebrationTimer) clearTimeout(celebrationTimer)
  celebrationRound.value += 1
  celebrating.value = true
  celebrationTimer = setTimeout(() => {
    celebrating.value = false
    celebrationTimer = null
  }, 4200)
}

async function handleTurnState(event: { payload?: TerminalTurnEvent }) {
  await refreshTasks()
  if (event.payload?.state !== 'completed') return
  const task = tasks.value.find((item) =>
    item.state === 'completed'
      && item.agent === event.payload?.agent
      && item.path === event.payload?.path,
  ) ?? null
  triggerCompletionReminder(task)
}

function formatAgent(agent: string) {
  if (agent === 'claude') return 'Claude Code'
  if (agent === 'codex') return 'Codex'
  if (agent === 'agy') return 'Antigravity'
  return agent
}

function formatUpdatedAt(updatedAt: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))
  if (seconds < 60) return t('desktopPet.time.now')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('desktopPet.time.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  return t('desktopPet.time.hours', { count: hours })
}

function beginDrag(event: PointerEvent) {
  if (event.button !== 0) return
  getCurrentWindow().startDragging().catch((error) => {
    console.warn('[desktop-pet] failed to start dragging:', error)
  })
}

function taskIdentity(task: DesktopTask) {
  return `${task.agent}:${task.path}:${task.updatedAt}`
}

function dismissCompletedTask(task: DesktopTask) {
  if (task.state !== 'completed') return
  dismissedCompletedTasks.add(taskIdentity(task))
  tasks.value = tasks.value.filter((item) => item !== task)
}

async function openTask(task: DesktopTask) {
  try {
    await openDesktopPetSession(task)
    dismissCompletedTask(task)
  } catch (error) {
    console.warn('[desktop-pet] failed to open session:', error)
  }
}

onMounted(async () => {
  await refreshTasks()
  unlisten = await Promise.all([
    listen<TerminalTurnEvent>('terminal-turn://state', handleTurnState),
    listen<{ character?: DesktopPetCharacter }>('desktop-pet://character', (event) => {
      const character = event.payload?.character
      if (character && characterImages[character]) setDesktopPetCharacter(character)
    }),
  ])
})

onUnmounted(() => {
  if (panelCloseTimer) clearTimeout(panelCloseTimer)
  if (celebrationTimer) clearTimeout(celebrationTimer)
  for (const stop of unlisten) stop()
})
</script>

<template>
  <main
    class="desktop-pet"
    :class="{
      'has-running': hasRunning,
      'has-blocked': hasBlocked,
      'has-failed': hasFailed,
      'is-celebrating': celebrating,
    }"
  >
    <section
      v-if="panelOpen"
      class="task-panel"
      :aria-label="t('desktopPet.status.title')"
      @pointerenter="showPanel"
      @pointerleave="schedulePanelClose"
      @focusin="showPanel"
      @focusout="schedulePanelClose"
    >
      <header class="panel-head">
        <span class="panel-spark">✦</span>
        <strong>{{ t('desktopPet.status.title') }}</strong>
        <span class="panel-total">{{ orderedTasks.length }}</span>
      </header>

      <div class="status-summary">
        <div
          v-for="status in statuses"
          :key="status.state"
          class="status-pill"
          :class="`is-${status.state}`"
        >
          <span class="status-dot">{{ status.icon }}</span>
          <span class="status-label">{{ t(status.labelKey) }}</span>
          <strong>{{ groups[status.state].length }}</strong>
        </div>
      </div>

      <div v-if="orderedTasks.length" class="task-list">
        <button
          v-for="task in orderedTasks"
          :key="`${task.agent}:${task.path}`"
          type="button"
          class="task-item"
          @click="openTask(task)"
        >
          <span class="task-state" :class="`is-${task.state}`">
            {{ statusByState[task.state].icon }}
          </span>
          <span class="task-copy">
            <span class="task-agent">{{ formatAgent(task.agent) }}</span>
            <span class="task-title">{{ task.title }}</span>
          </span>
          <span class="task-time">{{ formatUpdatedAt(task.updatedAt) }}</span>
        </button>
      </div>
      <p v-else class="task-empty">{{ t('desktopPet.empty') }}</p>
    </section>

    <div v-if="!panelOpen && taskNotices.length" class="status-notices" aria-live="polite">
      <button
        v-for="notice in taskNotices"
        :key="notice.state"
        type="button"
        class="status-notice"
        :class="`is-${notice.state}`"
        :title="notice.task.title"
        @click="openTask(notice.task)"
      >
        <span class="notice-icon">{{ notice.icon }}</span>
        <span>{{ t(notice.labelKey) }}</span>
      </button>
    </div>

    <div
      class="character-area"
      tabindex="0"
      role="button"
      :aria-label="t('desktopPet.status.title')"
      :aria-expanded="panelOpen"
      @pointerdown="beginDrag"
      @mouseenter="showPanel"
      @mouseleave="schedulePanelClose"
      @click="showPanel"
      @focusin="showPanel"
      @focusout="schedulePanelClose"
    >
      <div class="character-glow" />
      <div :key="celebrationRound" class="character-stage">
        <span class="hover-heart" aria-hidden="true">♥</span>
        <span v-if="celebrating" class="celebration-stars" aria-hidden="true">
          <i>✦</i><i>★</i><i>✧</i>
        </span>
        <span v-if="hasBlocked && !celebrating" class="approval-mark" aria-hidden="true">!</span>
        <span v-if="hasFailed && !celebrating" class="failure-mark" aria-hidden="true">×</span>
        <span
          class="pet-art"
          :class="`is-${desktopPetCharacter}`"
          :data-character="desktopPetCharacter"
          role="img"
          :aria-label="t(`desktopPet.character.${desktopPetCharacter}`)"
          v-html="characterSvg"
        />
      </div>
      <span class="drag-hint">⋮⋮</span>
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

.desktop-pet {
  --pet-ink: #44394e;
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--pet-ink);
  font-family: Inter, ui-rounded, "SF Pro Rounded", "Microsoft YaHei", sans-serif;
  user-select: none;
}

.character-area {
  position: absolute;
  z-index: 2;
  right: 5px;
  bottom: 0;
  width: 138px;
  height: 166px;
  outline: none;
  cursor: grab;
  touch-action: none;
}

.character-area:active { cursor: grabbing; }

.character-glow {
  position: absolute;
  left: 22px;
  right: 15px;
  bottom: 14px;
  height: 32px;
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(123, 103, 181, 0.24), transparent 70%);
  filter: blur(8px);
  transition: opacity 180ms ease, transform 180ms ease;
}

.character-stage {
  position: absolute;
  inset: 0;
}

.pet-art {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
}

.pet-art :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 10px 9px rgba(53, 40, 68, .12));
  transition: filter 180ms ease;
}

.pet-art :deep(.pet-head),
.pet-art :deep(.pet-ear),
.pet-art :deep(.pet-tail),
.pet-art :deep(.pet-paw),
.pet-art :deep(.pet-wing),
.pet-art :deep(.pet-body),
.pet-art :deep(.pet-eye),
.pet-art :deep(.pet-laptop-screen) {
  transform-box: fill-box;
}

.pet-art :deep(.pet-head) { transform-origin: 50% 82%; }
.pet-art :deep(.pet-ear-left) { transform-origin: 82% 88%; }
.pet-art :deep(.pet-ear-right) { transform-origin: 18% 88%; }
.pet-art :deep(.pet-tail) { transform-origin: 80% 55%; }
.pet-art :deep(.pet-paw-left) { transform-origin: 70% 18%; }
.pet-art :deep(.pet-paw-right) { transform-origin: 30% 18%; }
.pet-art :deep(.pet-wing-left) { transform-origin: 92% 45%; }
.pet-art :deep(.pet-wing-right) { transform-origin: 8% 45%; }
.pet-art :deep(.pet-body) {
  transform-origin: 50% 90%;
  animation: pet-breathe 2.8s ease-in-out infinite;
}
.pet-art :deep(.pet-eye) {
  transform-origin: center;
  animation: pet-blink 4.8s ease-in-out infinite;
}
.pet-art :deep(.pet-mouth-neutral),
.pet-art :deep(.pet-mouth-happy) { transition: opacity 120ms ease; }
.pet-art :deep(.pet-mouth-happy) { opacity: 0; }
.pet-art :deep(.pet-screen-light) {
  opacity: 0;
  pointer-events: none;
}

.drag-hint {
  position: absolute;
  right: 87px;
  bottom: 7px;
  color: rgba(67, 55, 78, 0.36);
  font-size: 13px;
  letter-spacing: -3px;
  opacity: 0;
  transition: opacity 160ms ease;
}

.character-area:hover .drag-hint { opacity: 1; }
.character-area:hover .character-glow,
.character-area:focus .character-glow {
  opacity: .95;
  transform: scale(1.15);
}

.character-area:hover .pet-art :deep(.pet-head),
.character-area:focus .pet-art :deep(.pet-head) {
  animation: pet-head-greet 1.05s ease-in-out infinite alternate;
}
.character-area:hover .pet-art :deep(.pet-ear-left),
.character-area:focus .pet-art :deep(.pet-ear-left) {
  animation: pet-ear-left-greet .42s ease-in-out infinite alternate;
}
.character-area:hover .pet-art :deep(.pet-ear-right),
.character-area:focus .pet-art :deep(.pet-ear-right) {
  animation: pet-ear-right-greet .42s .08s ease-in-out infinite alternate;
}
.character-area:hover .pet-art :deep(.pet-tail),
.character-area:focus .pet-art :deep(.pet-tail) {
  animation: pet-tail-wag .48s ease-in-out infinite alternate;
}
.character-area:hover .pet-art :deep(.pet-paw-left),
.character-area:focus .pet-art :deep(.pet-paw-left) {
  animation: pet-paw-wave .5s ease-in-out infinite alternate;
}
.character-area:hover .pet-art :deep(.pet-wing-left),
.character-area:focus .pet-art :deep(.pet-wing-left) {
  animation: pet-wing-left-flap .42s ease-in-out infinite alternate;
}
.character-area:hover .pet-art :deep(.pet-wing-right),
.character-area:focus .pet-art :deep(.pet-wing-right) {
  animation: pet-wing-right-flap .42s .08s ease-in-out infinite alternate;
}

.hover-heart {
  position: absolute;
  z-index: 4;
  top: 14px;
  right: 10px;
  color: #f27991;
  font-size: 17px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(5px) scale(.5) rotate(8deg);
  transition: opacity 150ms ease, transform 230ms cubic-bezier(.2, .9, .3, 1.3);
  text-shadow: 0 3px 8px rgba(199, 69, 100, .28);
}
.character-area:hover .hover-heart,
.character-area:focus .hover-heart {
  opacity: 1;
  transform: translateY(0) scale(1) rotate(-5deg);
}

.approval-mark,
.failure-mark {
  position: absolute;
  z-index: 5;
  display: grid;
  place-items: center;
  width: 23px;
  height: 23px;
  border: 2px solid rgba(255, 255, 255, .92);
  border-radius: 50%;
  color: #fff;
  font-size: 15px;
  font-weight: 900;
  line-height: 1;
  pointer-events: none;
  box-shadow: 0 5px 12px rgba(67, 50, 78, .2);
}

.approval-mark {
  top: 24px;
  left: 12px;
  background: linear-gradient(135deg, #ffc85d, #ef8c43);
  animation: approval-ping .8s ease-in-out infinite;
}

.failure-mark {
  top: 52px;
  right: 2px;
  background: linear-gradient(135deg, #f07a91, #ce405f);
  animation: failure-jitter .46s ease-in-out infinite;
}

.task-panel {
  position: absolute;
  z-index: 5;
  top: 12px;
  left: 9px;
  width: 218px;
  max-height: 205px;
  padding: 11px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .84);
  border-radius: 18px;
  background: linear-gradient(145deg, rgba(255, 255, 255, .95), rgba(248, 244, 255, .9));
  box-shadow: 0 16px 38px rgba(52, 37, 70, .19), inset 0 0 0 1px rgba(102, 81, 124, .05);
  backdrop-filter: blur(24px) saturate(1.18);
  animation: panel-in 160ms cubic-bezier(.2, .8, .2, 1);
}

.panel-head {
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 3px 7px;
  font-size: 12px;
}

.panel-spark { color: #8871df; font-size: 14px; }
.panel-head strong { flex: 1; font-weight: 760; }
.panel-total {
  min-width: 18px;
  padding: 2px 6px;
  border-radius: 999px;
  background: #ece7f7;
  color: #75678a;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.status-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  margin-bottom: 8px;
}

.status-pill {
  min-width: 0;
  height: 28px;
  padding: 0 7px 0 5px;
  display: flex;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(90, 71, 111, .08);
  border-radius: 10px;
  background: rgba(255, 255, 255, .64);
}

.status-dot,
.task-state {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 7px;
  color: #fff;
  font-size: 9px;
  font-weight: 900;
}

.status-dot { width: 18px; height: 18px; }
.status-pill .status-label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: #766c7e;
  font-size: 9px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.status-pill strong { color: #4f435a; font-size: 11px; font-variant-numeric: tabular-nums; }

.is-started .status-dot,
.task-state.is-started { background: linear-gradient(135deg, #7895ff, #7766dc); }
.is-blocked .status-dot,
.task-state.is-blocked { background: linear-gradient(135deg, #f5bc5f, #ec8b4f); }
.is-completed .status-dot,
.task-state.is-completed { background: linear-gradient(135deg, #66d7af, #3bad8e); }
.is-failed .status-dot,
.task-state.is-failed { background: linear-gradient(135deg, #f17b91, #dc566f); }

.task-list { max-height: 103px; overflow-y: auto; scrollbar-width: none; }
.task-list::-webkit-scrollbar { display: none; }

.task-item {
  width: 100%;
  min-width: 0;
  height: 38px;
  padding: 4px 6px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--pet-ink);
  cursor: pointer;
  text-align: left;
}

.task-item:hover,
.task-item:focus-visible { background: rgba(235, 229, 247, .7); outline: none; }
.task-state { width: 21px; height: 21px; }
.task-copy { min-width: 0; display: grid; gap: 1px; }
.task-agent { color: #887c91; font-size: 8.5px; font-weight: 650; }
.task-title { overflow: hidden; font-size: 10.5px; font-weight: 670; white-space: nowrap; text-overflow: ellipsis; }
.task-time { color: #908699; font-size: 9px; white-space: nowrap; }

.task-empty {
  margin: 10px 0 4px;
  color: #94899c;
  font-size: 10px;
  text-align: center;
}

.status-notices {
  position: absolute;
  z-index: 8;
  right: 146px;
  bottom: 14px;
  width: 220px;
  display: grid;
  gap: 6px;
}

.status-notice {
  min-width: 0;
  min-height: 34px;
  padding: 7px 11px 7px 8px;
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(255, 255, 255, .9);
  border-radius: 13px 13px 4px 13px;
  background: rgba(255, 255, 255, .95);
  color: #574966;
  box-shadow: 0 10px 25px rgba(62, 43, 80, .18);
  backdrop-filter: blur(18px);
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  animation: notice-in 220ms cubic-bezier(.2, .9, .3, 1), notice-breathe 2s ease-in-out 250ms infinite;
}

.status-notice > span:last-child {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.notice-icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 8px;
  color: #fff;
  font-size: 11px;
}

.status-notice.is-completed .notice-icon { background: linear-gradient(135deg, #69d8b1, #43b696); }
.status-notice.is-blocked .notice-icon { background: linear-gradient(135deg, #f5bc5f, #ec8b4f); }
.status-notice.is-failed .notice-icon { background: linear-gradient(135deg, #f17b91, #dc566f); }

.status-notice:hover,
.status-notice:focus-visible { transform: translateX(-2px); outline: none; }

.celebration-stars {
  position: absolute;
  z-index: 3;
  inset: 12px 18px 25px;
  pointer-events: none;
}

.celebration-stars i {
  position: absolute;
  color: #f3bc4f;
  font-style: normal;
  text-shadow: 0 2px 7px rgba(222, 154, 42, .35);
  animation: star-pop .85s ease-in-out infinite;
}
.celebration-stars i:nth-child(1) { top: 18px; left: 8px; font-size: 20px; }
.celebration-stars i:nth-child(2) { top: 0; right: 10px; font-size: 15px; animation-delay: .18s; }
.celebration-stars i:nth-child(3) { top: 72px; right: 0; font-size: 19px; animation-delay: .34s; }

.has-running:not(.is-celebrating) .pet-art :deep(.pet-paw-left) {
  animation: pet-type-left .34s ease-in-out infinite;
}
.has-running:not(.is-celebrating) .pet-art :deep(.pet-paw-right) {
  animation: pet-type-right .34s .17s ease-in-out infinite;
}
.has-running:not(.is-celebrating) .pet-art :deep(.pet-laptop-screen) {
  animation: laptop-working 1.1s ease-in-out infinite;
}
.has-running:not(.is-celebrating) .pet-art :deep(.pet-screen-light) {
  animation: screen-light-cast 1.1s ease-in-out infinite;
}

.has-blocked:not(.is-celebrating) .pet-art :deep(.pet-paw-right) {
  animation: pet-approval-raise .72s ease-in-out infinite;
}

.has-failed:not(.is-celebrating) .pet-art :deep(.pet-head) {
  animation: pet-head-failed .5s ease-in-out infinite;
}
.has-failed:not(.is-celebrating) .pet-art :deep(.pet-ear-left) {
  animation: pet-ear-left-failed .7s ease-in-out infinite alternate;
}
.has-failed:not(.is-celebrating) .pet-art :deep(.pet-ear-right) {
  animation: pet-ear-right-failed .7s ease-in-out infinite alternate;
}
.has-failed:not(.is-celebrating) .pet-art :deep(.pet-laptop-screen) {
  animation: laptop-failed .52s ease-in-out infinite;
}

.is-celebrating .pet-art :deep(svg) { filter: drop-shadow(0 0 13px rgba(240, 181, 73, .42)); }
.is-celebrating .character-glow { opacity: .9; transform: scale(1.18); }
.is-celebrating .pet-art :deep(.pet-mouth-neutral) { opacity: 0; }
.is-celebrating .pet-art :deep(.pet-mouth-happy) { opacity: 1; }
.is-celebrating .pet-art :deep(.pet-head) {
  animation: pet-head-cheer .58s ease-in-out infinite;
}
.is-celebrating .pet-art :deep(.pet-ear-left) {
  animation: pet-ear-left-cheer .26s ease-in-out infinite alternate;
}
.is-celebrating .pet-art :deep(.pet-ear-right) {
  animation: pet-ear-right-cheer .26s ease-in-out infinite alternate;
}
.is-celebrating .pet-art :deep(.pet-tail) {
  animation: pet-tail-cheer .24s ease-in-out infinite alternate;
}
.is-celebrating .pet-art :deep(.pet-paw-left) {
  animation: pet-paw-left-cheer .34s ease-in-out infinite alternate;
}
.is-celebrating .pet-art :deep(.pet-paw-right) {
  animation: pet-paw-right-cheer .34s ease-in-out infinite alternate;
}
.is-celebrating .pet-art :deep(.pet-wing-left) {
  animation: pet-wing-left-cheer .28s ease-in-out infinite alternate;
}
.is-celebrating .pet-art :deep(.pet-wing-right) {
  animation: pet-wing-right-cheer .28s ease-in-out infinite alternate;
}

@keyframes pet-breathe {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(1.018); }
}

@keyframes pet-blink {
  0%, 43%, 47%, 100% { transform: scaleY(1); }
  45% { transform: scaleY(.08); }
}

@keyframes pet-head-greet {
  from { transform: rotate(-2deg) translateY(0); }
  to { transform: rotate(5deg) translateY(2px); }
}

@keyframes pet-ear-left-greet {
  from { transform: rotate(0); }
  to { transform: rotate(-11deg); }
}

@keyframes pet-ear-right-greet {
  from { transform: rotate(0); }
  to { transform: rotate(11deg); }
}

@keyframes pet-tail-wag {
  from { transform: rotate(-7deg); }
  to { transform: rotate(15deg); }
}

@keyframes pet-paw-wave {
  from { transform: rotate(2deg); }
  to { transform: rotate(-24deg) translateY(-2px); }
}

@keyframes pet-type-left {
  0%, 100% { transform: translateY(0) rotate(-3deg); }
  50% { transform: translateY(9px) rotate(4deg); }
}

@keyframes pet-type-right {
  0%, 100% { transform: translateY(8px) rotate(-4deg); }
  50% { transform: translateY(0) rotate(3deg); }
}

@keyframes pet-approval-raise {
  0%, 100% { transform: translateY(-70px) rotate(22deg); }
  50% { transform: translateY(-78px) rotate(32deg); }
}

@keyframes pet-head-failed {
  0%, 100% { transform: translateY(5px) rotate(-3deg); }
  50% { transform: translateY(7px) rotate(3deg); }
}

@keyframes pet-ear-left-failed {
  from { transform: rotate(12deg); }
  to { transform: rotate(18deg); }
}

@keyframes pet-ear-right-failed {
  from { transform: rotate(-12deg); }
  to { transform: rotate(-18deg); }
}

@keyframes laptop-working {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.28); }
}

@keyframes screen-light-cast {
  0%, 100% { opacity: .34; filter: brightness(.98); }
  50% { opacity: .78; filter: brightness(1.1); }
}

@keyframes laptop-failed {
  0%, 100% { fill: #ef6680; filter: brightness(.9); }
  50% { fill: #ffb1bc; filter: brightness(1.15); }
}

@keyframes pet-wing-left-flap {
  from { transform: rotate(2deg) scaleY(1); }
  to { transform: rotate(-14deg) scaleY(.9); }
}

@keyframes pet-wing-right-flap {
  from { transform: rotate(-2deg) scaleY(1); }
  to { transform: rotate(14deg) scaleY(.9); }
}

@keyframes pet-head-cheer {
  0%, 100% { transform: rotate(-4deg) translateY(0); }
  50% { transform: rotate(5deg) translateY(-5px); }
}

@keyframes pet-ear-left-cheer {
  from { transform: rotate(-14deg); }
  to { transform: rotate(9deg); }
}

@keyframes pet-ear-right-cheer {
  from { transform: rotate(14deg); }
  to { transform: rotate(-9deg); }
}

@keyframes pet-tail-cheer {
  from { transform: rotate(-15deg); }
  to { transform: rotate(24deg); }
}

@keyframes pet-paw-left-cheer {
  from { transform: translateY(-66px) rotate(-24deg); }
  to { transform: translateY(-82px) rotate(-38deg); }
}

@keyframes pet-paw-right-cheer {
  from { transform: translateY(-66px) rotate(24deg); }
  to { transform: translateY(-82px) rotate(38deg); }
}

@keyframes pet-wing-left-cheer {
  from { transform: rotate(6deg) scaleY(1); }
  to { transform: rotate(-23deg) scaleY(.82); }
}

@keyframes pet-wing-right-cheer {
  from { transform: rotate(-6deg) scaleY(1); }
  to { transform: rotate(23deg) scaleY(.82); }
}

@keyframes panel-in {
  from { opacity: 0; transform: translateX(7px) scale(.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes notice-in {
  from { opacity: 0; transform: translateY(8px) scale(.92); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes notice-breathe {
  0%, 100% { box-shadow: 0 10px 25px rgba(62, 43, 80, .18); }
  50% { box-shadow: 0 12px 29px rgba(91, 68, 124, .28); }
}

@keyframes star-pop {
  0%, 100% { opacity: .35; transform: scale(.65) rotate(-8deg); }
  50% { opacity: 1; transform: scale(1.15) rotate(8deg); }
}

@keyframes approval-ping {
  0%, 100% { transform: translateY(0) scale(.94); }
  50% { transform: translateY(-4px) scale(1.08); }
}

@keyframes failure-jitter {
  0%, 100% { transform: translateX(-2px) rotate(-5deg); }
  50% { transform: translateX(2px) rotate(5deg); }
}

@media (prefers-reduced-motion: reduce) {
  .task-panel,
  .status-notice,
  .celebration-stars i,
  .approval-mark,
  .failure-mark,
  .pet-art :deep(.pet-head),
  .pet-art :deep(.pet-ear),
  .pet-art :deep(.pet-tail),
  .pet-art :deep(.pet-paw),
  .pet-art :deep(.pet-wing),
  .pet-art :deep(.pet-body),
  .pet-art :deep(.pet-eye),
  .pet-art :deep(.pet-screen-light),
  .pet-art :deep(.pet-laptop-screen) { animation: none !important; }

  .has-running:not(.is-celebrating) .pet-art :deep(.pet-screen-light) { opacity: .56; }
}
</style>
