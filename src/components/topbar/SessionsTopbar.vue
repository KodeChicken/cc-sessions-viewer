<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { t } from '../../i18n'
import type { SessionMeta } from '../../types'
import {
  sessionSearch,
  sessionSort,
  sessionWithIdOnly,
  sessionSelectMode,
  selectedSessions,
  exitSessionSelectMode,
  filterSessions,
  type SessionSort,
} from '../../sessionsToolbar'
import { useDebouncedSearch } from '../../useDebouncedSearch'
import {
  IconSearch,
  IconClose,
  IconHash,
  IconChevronDown,
  IconCheck,
  IconSelect,
  IconTrash,
  IconDownload,
  IconMarkdown,
  IconHtml,
  IconJson,
} from '../icons'

const props = defineProps<{ sessions: SessionMeta[] }>()
const emit = defineEmits<{
  (e: 'batch-delete'): void
  (e: 'batch-export', kind: 'md' | 'html' | 'json'): void
}>()

// 搜索框防抖：打字时 `draft` 立即跟着光标走，静止 220ms 后才同步到共享
// `sessionSearch`，避免每个按键都触发整张会话列表的 filter / 高亮重算。
// IME 组合中（中文 / 日文输入法）不会触发 —— 等 compositionend 才同步。
const {
  draft: searchDraft,
  commit: commitSearch,
  onInput: onSearchInput,
  onCompositionStart: onSearchCompStart,
  onCompositionEnd: onSearchCompEnd,
} = useDebouncedSearch(sessionSearch, 220)
const hasQuery = computed(() => searchDraft.value.length > 0)

function clearSearch() {
  commitSearch('')
}

// 排序下拉 —— 复用 .ct-scope-* 样式（同 ChatTopbar 的 scope / TrashTopbar 的项目筛选）。
const SORTS: { value: SessionSort; key: string }[] = [
  { value: 'recent', key: 'list.tb.sortRecent' },
  { value: 'oldest', key: 'list.tb.sortOldest' },
  { value: 'size', key: 'list.tb.sortSize' },
  { value: 'messages', key: 'list.tb.sortMessages' },
]
const sortMenuOpen = ref(false)
const sortMenuEl = ref<HTMLElement>()
const sortLabel = computed(() => {
  const found = SORTS.find((s) => s.value === sessionSort.value)
  return t(found?.key ?? 'list.tb.sortRecent')
})
function toggleSortMenu(e: Event) {
  e.stopPropagation()
  sortMenuOpen.value = !sortMenuOpen.value
}
function pickSort(s: SessionSort) {
  sessionSort.value = s
  sortMenuOpen.value = false
}
function onDocClick(e: MouseEvent) {
  if (!sortMenuOpen.value) return
  if (sortMenuEl.value && sortMenuEl.value.contains(e.target as Node)) return
  sortMenuOpen.value = false
}

// ⌘F / Ctrl+F：会话列表打开时拦截系统 Find，聚焦搜索框并全选。
// 只检测当前平台对应的修饰键，避免 macOS 上 Ctrl+F（光标右移）被误抢。
const searchInput = ref<HTMLInputElement>()
const isMac = /Mac/i.test(navigator.platform)
function onFindShortcut(e: KeyboardEvent) {
  if (e.key !== 'f' && e.key !== 'F') return
  const want = isMac ? e.metaKey : e.ctrlKey
  const other = isMac ? e.ctrlKey : e.metaKey
  if (!want || other || e.shiftKey || e.altKey) return
  e.preventDefault()
  searchInput.value?.focus()
  searchInput.value?.select()
}

// 当前筛选下可见的会话 —— 全选 / 计数都基于它。
const visible = computed(() => filterSessions(props.sessions))
const selectedCount = computed(
  () => props.sessions.filter((s) => selectedSessions.value.has(s.path)).length,
)
const allSelected = computed(
  () =>
    visible.value.length > 0 &&
    visible.value.every((s) => selectedSessions.value.has(s.path)),
)
function toggleSelectAll() {
  const next = new Set(selectedSessions.value)
  for (const s of visible.value) {
    if (allSelected.value) next.delete(s.path)
    else next.add(s.path)
  }
  selectedSessions.value = next
}

// 批量导出的小菜单（MD / HTML），与列表卡片自带的 export-menu 一致。
const exportMenuOpen = ref(false)
const exportMenuEl = ref<HTMLElement>()
function toggleExportMenu(e: Event) {
  e.stopPropagation()
  exportMenuOpen.value = !exportMenuOpen.value
}
function pickExport(kind: 'md' | 'html' | 'json', e: Event) {
  e.stopPropagation()
  exportMenuOpen.value = false
  emit('batch-export', kind)
}
function onDocClickAll(e: MouseEvent) {
  onDocClick(e)
  if (!exportMenuOpen.value) return
  if (exportMenuEl.value && exportMenuEl.value.contains(e.target as Node)) return
  exportMenuOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClickAll)
  window.addEventListener('keydown', onFindShortcut)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClickAll)
  window.removeEventListener('keydown', onFindShortcut)
})
</script>

<template>
  <div class="chat-topbar">
    <div class="ct-search" :class="{ active: hasQuery }">
      <div ref="sortMenuEl" class="ct-scope-wrap">
        <button
          type="button"
          class="ct-scope-btn"
          :class="{ active: sortMenuOpen }"
          v-tooltip:right="t('list.tb.sort')"
          @click="toggleSortMenu"
        >
          <span class="ct-scope-label">{{ sortLabel }}</span>
          <IconChevronDown class="ct-scope-chev" />
        </button>
        <div v-if="sortMenuOpen" class="ct-scope-menu" role="menu">
          <button
            v-for="s in SORTS"
            :key="s.value"
            type="button"
            class="ct-scope-item"
            :class="{ active: sessionSort === s.value }"
            role="menuitemradio"
            :aria-checked="sessionSort === s.value"
            @click="pickSort(s.value)"
          >
            <span class="ct-scope-check">
              <IconCheck v-if="sessionSort === s.value" />
            </span>
            <span>{{ t(s.key) }}</span>
          </button>
        </div>
      </div>
      <span class="ct-search-ic"><IconSearch /></span>
      <input
        ref="searchInput"
        :value="searchDraft"
        type="text"
        class="ct-search-input"
        :placeholder="t('list.tb.searchPlaceholder')"
        spellcheck="false"
        autocomplete="off"
        @input="onSearchInput"
        @compositionstart="onSearchCompStart"
        @compositionend="onSearchCompEnd"
      />
      <button
        v-if="hasQuery"
        class="ct-btn"
        v-tooltip="t('chat.tb.search.clear')"
        @click="clearSearch"
      >
        <IconClose />
      </button>
    </div>

    <div class="ct-actions">
      <template v-if="sessionSelectMode">
        <span class="ct-search-count">{{
          t('list.tb.selectedCount', { n: selectedCount })
        }}</span>
        <button
          class="ct-btn"
          :class="{ active: allSelected }"
          v-tooltip="allSelected ? t('list.tb.selectNone') : t('list.tb.selectAll')"
          @click="toggleSelectAll"
        >
          <IconCheck />
        </button>
        <!-- 批量导出：与卡片导出菜单同款 MD / HTML 小弹层 -->
        <div ref="exportMenuEl" class="export-menu-wrap">
          <button
            class="ct-btn"
            :class="{ active: exportMenuOpen }"
            :disabled="selectedCount === 0"
            v-tooltip="t('list.tb.exportSelected')"
            @click="toggleExportMenu"
          >
            <IconDownload />
          </button>
          <div
            v-if="exportMenuOpen"
            class="export-menu"
            role="menu"
            @click.stop
          >
            <button
              class="export-menu-item"
              role="menuitem"
              @click.stop="pickExport('md', $event)"
            >
              <IconMarkdown />
              <span>{{ t('chat.tb.export.md') }}</span>
            </button>
            <button
              class="export-menu-item"
              role="menuitem"
              @click.stop="pickExport('html', $event)"
            >
              <IconHtml />
              <span>{{ t('chat.tb.export.html') }}</span>
            </button>
            <button
              class="export-menu-item"
              role="menuitem"
              @click.stop="pickExport('json', $event)"
            >
              <IconJson />
              <span>{{ t('chat.tb.export.json') }}</span>
            </button>
          </div>
        </div>
        <button
          class="ct-btn danger"
          :disabled="selectedCount === 0"
          v-tooltip="t('list.tb.deleteSelected')"
          @click="emit('batch-delete')"
        >
          <IconTrash />
        </button>
        <button
          class="ct-btn"
          v-tooltip="t('list.tb.selectCancel')"
          @click="exitSessionSelectMode"
        >
          <IconClose />
        </button>
      </template>
      <template v-else>
        <button
          class="ct-btn"
          :class="{ active: sessionWithIdOnly }"
          v-tooltip="t('list.tb.withId')"
          @click="sessionWithIdOnly = !sessionWithIdOnly"
        >
          <IconHash />
        </button>
        <!-- 批量操作只在 2 条以上才有意义 -->
        <button
          v-if="sessions.length > 1"
          class="ct-btn"
          v-tooltip="t('list.tb.select')"
          @click="sessionSelectMode = true"
        >
          <IconSelect />
        </button>
      </template>
    </div>
  </div>
</template>
