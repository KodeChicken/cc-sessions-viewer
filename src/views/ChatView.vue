<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Agent, Msg, SessionMeta, Block } from '../types'
import { renderText, formatTime } from '../format'
import { t } from '../i18n'
import ToolResult from '../components/ToolResult.vue'
import CollapsibleBox from '../components/CollapsibleBox.vue'
import VueEasyLightbox from 'vue-easy-lightbox'
import {
  IconArrowLeft,
  IconRefresh,
  IconTrash,
  IconPlay,
  IconFolder,
  IconArrowUp,
  IconArrowDown,
  IconChevronRight,
  IconPencil,
  IconCopy,
  agentIcons,
} from '../components/icons'

const props = defineProps<{
  agent: Agent
  session: SessionMeta
  messages: Msg[]
}>()

defineEmits<{
  back: []
  refresh: []
  delete: []
  resume: []
  rename: []
  reveal: []
  copyId: []
}>()

function shortId(id: string): string {
  if (!id) return ''
  return id.length > 8 ? id.slice(0, 8) : id
}

function isToolOnly(m: Msg): boolean {
  return m.role === 'user' && m.blocks.every((b) => b.kind === 'tool_result')
}

function toolLabel(b: Block): string {
  if (b.kind === 'tool_use') return t('tool.call', { name: b.toolName ?? '' })
  if (b.kind === 'thinking') return t('tool.thinking')
  return ''
}

// 这几个工具会让 tool_result 携带 structuredPatch / 文件 diff，需要单独以
// 一个块呈现，便于一眼看到改动；其它工具（Read / Bash / TaskUpdate / Grep …）
// 的结果只是文本输出，嵌入到 Tool call 内部更紧凑。
const FILE_MUTATING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
])

const resultByToolId = computed(() => {
  const map = new Map<string, Block>()
  for (const m of props.messages) {
    for (const b of m.blocks) {
      if (b.kind === 'tool_result' && b.toolId) map.set(b.toolId, b)
    }
  }
  return map
})

const inlinedResultIds = computed(() => {
  const set = new Set<string>()
  for (const m of props.messages) {
    for (const b of m.blocks) {
      if (
        b.kind === 'tool_use' &&
        b.toolId &&
        !FILE_MUTATING_TOOLS.has(b.toolName ?? '') &&
        resultByToolId.value.has(b.toolId)
      ) {
        set.add(b.toolId)
      }
    }
  }
  return set
})

function inlinedResultFor(b: Block): Block | undefined {
  if (b.kind !== 'tool_use' || !b.toolId) return undefined
  if (!inlinedResultIds.value.has(b.toolId)) return undefined
  return resultByToolId.value.get(b.toolId)
}

function isInlinedResult(b: Block): boolean {
  return b.kind === 'tool_result' && !!b.toolId && inlinedResultIds.value.has(b.toolId)
}

function rowHasContent(m: Msg): boolean {
  if (!isToolOnly(m)) return true
  return m.blocks.some((b) => !isInlinedResult(b))
}

const assistantName = computed(() =>
  props.agent === 'codex' ? 'Codex' : 'Claude',
)

const stats = computed(() => {
  const u = props.messages.filter((m) => m.role === 'user' && !isToolOnly(m)).length
  const a = props.messages.filter((m) => m.role === 'assistant').length
  return { u, a }
})

const lightboxVisible = ref(false)
const lightboxSrc = ref('')
function openLightbox(src: string) {
  lightboxSrc.value = src
  lightboxVisible.value = true
}

const scrollEl = ref<HTMLElement>()

// 自定义 rAF 平滑滚动：原生 behavior:'smooth' 在长会话里会随距离把动画拉长，
// 每帧又触发大段 reflow，所以 420 条消息时就会卡。这里用固定时长 + ease-out，
// 并在用户滚动/再次点击时打断。
let scrollRAF = 0
function cancelScroll() {
  if (scrollRAF) {
    cancelAnimationFrame(scrollRAF)
    scrollRAF = 0
  }
}
function smoothScrollTo(target: number) {
  const el = scrollEl.value
  if (!el) return
  cancelScroll()
  const start = el.scrollTop
  const dest = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight))
  const dist = dest - start
  if (Math.abs(dist) < 2) {
    el.scrollTop = dest
    return
  }
  // 距离越长动画稍微拉长一点，但封顶 360ms，避免长会话拖沓
  const duration = Math.min(360, 180 + Math.abs(dist) * 0.05)
  const t0 = performance.now()
  // easeOutCubic
  const ease = (p: number) => 1 - Math.pow(1 - p, 3)
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration)
    el.scrollTop = start + dist * ease(p)
    if (p < 1) {
      scrollRAF = requestAnimationFrame(step)
    } else {
      scrollRAF = 0
    }
  }
  // 用户主动滚动则中断
  const onUserScroll = () => {
    cancelScroll()
    el.removeEventListener('wheel', onUserScroll)
    el.removeEventListener('touchmove', onUserScroll)
  }
  el.addEventListener('wheel', onUserScroll, { passive: true, once: true })
  el.addEventListener('touchmove', onUserScroll, { passive: true, once: true })
  scrollRAF = requestAnimationFrame(step)
}
function scrollToTop() {
  smoothScrollTo(0)
}
function scrollToBottom() {
  const el = scrollEl.value
  if (el) smoothScrollTo(el.scrollHeight)
}

// 到顶 / 到底时分别隐藏对应方向的 FAB，留一点 8px 阈值避免抖动
const atTop = ref(true)
const atBottom = ref(true)
function updateEdges() {
  const el = scrollEl.value
  if (!el) return
  atTop.value = el.scrollTop <= 8
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
}
let rafEdge = 0
function onScroll() {
  if (rafEdge) return
  rafEdge = requestAnimationFrame(() => {
    rafEdge = 0
    updateEdges()
  })
}
onMounted(() => {
  scrollEl.value?.addEventListener('scroll', onScroll, { passive: true })
  // 内容渲染完再算一次（长消息列表挂载后 scrollHeight 才稳定）
  requestAnimationFrame(updateEdges)
})
onUnmounted(() => {
  scrollEl.value?.removeEventListener('scroll', onScroll)
  if (rafEdge) cancelAnimationFrame(rafEdge)
  cancelScroll()
})
</script>

<template>
  <div class="chat-head">
    <button class="icon-btn" v-tooltip="t('chat.back')" @click="$emit('back')">
      <IconArrowLeft />
    </button>
    <div class="chat-head-info">
      <div class="t">
        <span class="t-text">{{ session.title }}</span>
        <button
          class="title-rename-ic"
          v-tooltip="t('chat.action.rename')"
          @click="$emit('rename')"
        >
          <IconPencil />
        </button>
      </div>
      <div class="s">
        <span>{{
          t('chat.stats', {
            u: stats.u,
            a: stats.a,
            time: formatTime(session.created),
          })
        }}</span>
        <span v-if="session.id" class="session-id" v-tooltip="session.id">
          <span class="session-id-label">{{ t('session.id') }}</span>
          <span class="session-id-text">{{ shortId(session.id) }}</span>
          <button
            class="session-id-copy"
            v-tooltip="t('chat.action.copyId')"
            @click="$emit('copyId')"
          >
            <IconCopy />
          </button>
        </span>
      </div>
    </div>
    <button
      class="icon-btn"
      v-tooltip="t('chat.action.resume')"
      @click="$emit('resume')"
    >
      <IconPlay />
    </button>
    <button
      class="icon-btn"
      v-tooltip="t('chat.action.reveal')"
      @click="$emit('reveal')"
    >
      <IconFolder />
    </button>
    <button
      class="icon-btn"
      v-tooltip="t('chat.action.refresh')"
      @click="$emit('refresh')"
    >
      <IconRefresh />
    </button>
    <button
      class="icon-btn danger"
      v-tooltip="t('chat.action.delete')"
      @click="$emit('delete')"
    >
      <IconTrash />
    </button>
  </div>

  <div ref="scrollEl" class="chat-scroll">
    <div class="chat-inner">
      <div
        v-for="(m, i) in messages"
        :key="m.uuid ?? i"
        v-show="rowHasContent(m)"
        class="msg-row"
        :class="isToolOnly(m) ? 'tool-only' : m.role"
      >
        <div v-if="isToolOnly(m)" style="max-width: 86%; min-width: 0">
          <template v-for="(b, bi) in m.blocks" :key="bi">
            <ToolResult v-if="!isInlinedResult(b)" :block="b" />
          </template>
        </div>

        <div v-else class="bubble" :class="m.role">
          <div class="role-tag">
            <span class="name">
              <component
                v-if="m.role === 'assistant'"
                :is="agentIcons[agent]"
                class="agent-icon"
                :class="agent"
              />
              {{ m.role === 'user' ? t('chat.role.me') : assistantName }}
            </span>
            <span v-if="m.model" class="tool-chip">{{ m.model }}</span>
            <span v-if="m.sidechain" class="sidechain-badge">
              {{ t('chat.badge.subtask') }}
            </span>
            <span>{{ formatTime(m.timestamp) }}</span>
          </div>

          <CollapsibleBox :enabled="m.role === 'user'" :max-height="320">
            <template v-for="(b, bi) in m.blocks" :key="bi">
              <div v-if="b.kind === 'text'" class="text-run" v-html="renderText(b.text ?? '')" />

              <div
                v-else-if="b.kind === 'image' && b.imageSrc"
                class="inline-image-wrap"
                @click="openLightbox(b.imageSrc)"
              >
                <img
                  :src="b.imageSrc"
                  class="inline-image"
                  loading="lazy"
                  alt=""
                />
              </div>

              <details
                v-else-if="b.kind === 'thinking'"
                class="block-card"
                :class="{ 'in-user': m.role === 'user' }"
              >
                <summary class="block-summary">
                  <span class="chev"><IconChevronRight /></span>
                  <span class="label">{{ toolLabel(b) }}</span>
                </summary>
                <div class="block-body"><pre>{{ b.text }}</pre></div>
              </details>

              <details
                v-else-if="b.kind === 'tool_use'"
                class="block-card"
                :class="{ 'in-user': m.role === 'user' }"
              >
                <summary class="block-summary">
                  <span class="chev"><IconChevronRight /></span>
                  <span class="label">{{ toolLabel(b) }}</span>
                </summary>
                <div class="block-body">
                  <pre>{{ b.toolInput }}</pre>
                  <ToolResult
                    v-if="inlinedResultFor(b)"
                    :block="inlinedResultFor(b)!"
                  />
                </div>
              </details>

              <ToolResult
                v-else-if="b.kind === 'tool_result' && !isInlinedResult(b)"
                :block="b"
                :in-user="m.role === 'user'"
              />
            </template>
          </CollapsibleBox>
        </div>
      </div>

      <div v-if="!messages.length" class="empty" style="height: 200px">
        <div>{{ t('chat.empty') }}</div>
      </div>
    </div>
  </div>

  <div v-if="messages.length" class="scroll-fab">
    <button
      v-if="!atTop"
      class="fab"
      v-tooltip="t('chat.action.top')"
      @click="scrollToTop"
    >
      <IconArrowUp />
    </button>
    <button
      v-if="!atBottom"
      class="fab"
      v-tooltip="t('chat.action.bottom')"
      @click="scrollToBottom"
    >
      <IconArrowDown />
    </button>
  </div>

  <VueEasyLightbox
    :visible="lightboxVisible"
    :imgs="lightboxSrc"
    @hide="lightboxVisible = false"
  />
</template>
