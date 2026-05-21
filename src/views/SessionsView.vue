<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { ProjectInfo, SessionMeta } from '../types'
import { formatSize, formatTime, shortName } from '../format'
import { t } from '../i18n'
import {
  IconTrash,
  IconPlay,
  IconFolder,
  IconInbox,
  IconPencil,
  IconCopy,
  IconDownload,
  IconMarkdown,
  IconHtml,
} from '../components/icons'

defineProps<{
  project: ProjectInfo
  sessions: SessionMeta[]
  sessionTotal: number
  loading: boolean
  loadingMore: boolean
}>()

const emit = defineEmits<{
  (e: 'open', s: SessionMeta): void
  (e: 'rename', s: SessionMeta): void
  (e: 'resume', s: SessionMeta): void
  (e: 'reveal', path: string): void
  (e: 'delete', s: SessionMeta): void
  (e: 'copy', text: string): void
  (e: 'export', s: SessionMeta, kind: 'md' | 'html'): void
  (e: 'load-more'): void
  (e: 'scroll', scrollTop: number): void
}>()

const scrollEl = ref<HTMLElement>()

// 每张卡片自己的导出菜单状态：只允许一个打开，按 session path 标识。
const openExportFor = ref<string | null>(null)
const exportMenuEls = ref<Record<string, HTMLElement | null>>({})
function setExportMenuEl(path: string, el: Element | null) {
  exportMenuEls.value[path] = el as HTMLElement | null
}
function toggleExport(path: string, e: Event) {
  e.stopPropagation()
  openExportFor.value = openExportFor.value === path ? null : path
}
function pickExport(s: SessionMeta, kind: 'md' | 'html', e: Event) {
  e.stopPropagation()
  openExportFor.value = null
  emit('export', s, kind)
}
function onDocClick(e: MouseEvent) {
  const p = openExportFor.value
  if (!p) return
  const anchor = exportMenuEls.value[p]
  if (anchor && anchor.contains(e.target as Node)) return
  openExportFor.value = null
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))

function shortId(id: string): string {
  if (!id) return ''
  return id.length > 8 ? id.slice(0, 8) : id
}

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  emit('scroll', el.scrollTop)
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 280) emit('load-more')
}

defineExpose({ scrollEl })
</script>

<template>
  <div class="list-head">
    <h2>{{ shortName(project.displayPath) }}</h2>
    <div class="path">{{ project.displayPath }}</div>
  </div>
  <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
  <div v-else-if="!sessions.length" class="empty">
    <div class="big"><IconInbox /></div>
    <div>{{ t('list.empty') }}</div>
  </div>
  <div v-else ref="scrollEl" class="scroll-area" @scroll="onScroll">
    <div
      v-for="s in sessions"
      :key="s.path"
      class="session-card"
      @click="emit('open', s)"
    >
      <div class="session-main">
        <div class="session-title">
          <span class="session-title-text">{{ s.title }}</span>
          <button
            class="title-rename-ic"
            v-tooltip="t('list.action.rename')"
            @click.stop="emit('rename', s)"
          >
            <IconPencil />
          </button>
        </div>
        <div class="session-meta">
          <span>{{ t('list.messages', { n: s.messageCount }) }}</span>
          <span>{{ formatSize(s.size) }}</span>
          <span>{{ t('list.updated', { time: formatTime(s.modified) }) }}</span>
          <span v-if="s.id" class="session-id" v-tooltip="s.id">
            <span class="session-id-label">{{ t('session.id') }}</span>
            <span class="session-id-text">{{ shortId(s.id) }}</span>
            <button
              class="session-id-copy"
              v-tooltip="t('list.action.copyId')"
              @click.stop="emit('copy', s.id)"
            >
              <IconCopy />
            </button>
          </span>
        </div>
      </div>
      <div class="session-actions">
        <button
          class="icon-btn"
          v-tooltip="t('list.action.resume')"
          @click.stop="emit('resume', s)"
        >
          <IconPlay />
        </button>
        <button
          class="icon-btn"
          v-tooltip="t('list.action.reveal')"
          @click.stop="emit('reveal', s.path)"
        >
          <IconFolder />
        </button>
        <div
          :ref="(el) => setExportMenuEl(s.path, el as Element | null)"
          class="export-menu-wrap"
        >
          <button
            class="icon-btn"
            :class="{ active: openExportFor === s.path }"
            v-tooltip:top="t('chat.tb.export.md') + ' / ' + t('chat.tb.export.html')"
            @click.stop="toggleExport(s.path, $event)"
          >
            <IconDownload />
          </button>
          <div v-if="openExportFor === s.path" class="export-menu" role="menu">
            <button
              class="export-menu-item"
              role="menuitem"
              @click.stop="pickExport(s, 'md', $event)"
            >
              <IconMarkdown />
              <span>{{ t('chat.tb.export.md') }}</span>
            </button>
            <button
              class="export-menu-item"
              role="menuitem"
              @click.stop="pickExport(s, 'html', $event)"
            >
              <IconHtml />
              <span>{{ t('chat.tb.export.html') }}</span>
            </button>
          </div>
        </div>
        <button
          class="icon-btn danger"
          v-tooltip="t('list.action.trash')"
          @click.stop="emit('delete', s)"
        >
          <IconTrash />
        </button>
      </div>
    </div>
    <div class="list-footer">
      <span v-if="loadingMore">{{ t('list.footer.loading') }}</span>
      <span v-else-if="sessions.length < sessionTotal">
        {{
          t('list.footer.partial', {
            shown: sessions.length,
            total: sessionTotal,
          })
        }}
      </span>
      <span v-else>
        {{ t('list.footer.all', { total: sessionTotal }) }}
      </span>
    </div>
  </div>
</template>
