<script setup lang="ts">
// TUI tab 栏 —— main 顶部的横条。左边两个"meta tab"固定描述底层 view：
//   List —— 项目的会话列表（永远显示，前提是处于项目浏览模式）
//   View —— 当前打开的聊天详情（只在 hasOpenSession 时出现）
// 之后是当前 (agent, projectKey) 范围内的所有活跃 PTY tab。
//
// 隐藏的 PTY tab（别的项目 / 别的 agent）不在这里出现，但 PTY 仍在后台跑 ——
// 切回对应项目时它们会再次显示，scrollback 全程不丢。

import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Agent } from '../types'
import type { TerminalTab, SavedTab } from '../terminals'
import { tabs, activeUiId, setActive, closeTab, markTabViewed, savedTabs, removeSavedTab } from '../terminals'
import { statusKind } from '../tabStatus'
import { IconClose, IconChat, IconList, IconPlus, agentIcons } from './icons'
import { t } from '../i18n'

const props = defineProps<{
  /** 当前侧栏选中的 agent */
  agent: Agent
  /** 当前选中的项目 dirName；null = 没选项目（欢迎页 / 回收站 / 统计页） */
  projectKey: string | null
  /** 当前是否处于"项目浏览"模式（活动项目 + 非回收站/统计） */
  inProjectBrowse: boolean
  /** 当前是否打开了某个会话 —— 用来决定要不要显示 View tab */
  hasOpenSession: boolean
}>()

const emit = defineEmits<{
  /** List —— 关闭当前会话 + 退出 TUI，回到项目会话列表 */
  listClick: []
  /** View —— 保留当前会话，仅退出 TUI，回到聊天详情 */
  viewClick: []
  /** Tab 被手动关闭（点 ×）—— App 据此刷新数据 */
  tabClosed: [sessionPath: string]
  /** TUI tab 操作菜单 —— 复用会话重命名弹窗 */
  tabRename: [tab: TerminalTab]
  /** 双击 tab 条空白处 —— 复用列表页加号的新建会话能力 */
  newSession: []
  hydrateSaved: [saved: SavedTab]
}>()

const visibleTabs = computed(() =>
  tabs.value.filter(
    (t) => t.agent === props.agent && t.projectKey === (props.projectKey ?? ''),
  ),
)
const visibleSaved = computed(() =>
  savedTabs.value.filter(
    (t) => t.agent === props.agent && t.projectKey === (props.projectKey ?? ''),
  ),
)
const visible = computed(() => visibleTabs.value.length > 0 || visibleSaved.value.length > 0)

function onSavedClick(saved: SavedTab) {
  removeSavedTab(saved.sessionPath)
  emit('hydrateSaved', saved)
}

function onSavedClose(saved: SavedTab, ev: Event) {
  ev.stopPropagation()
  removeSavedTab(saved.sessionPath)
}
const listActive = computed(
  () => activeUiId.value === null && !props.hasOpenSession,
)
const viewActive = computed(
  () => activeUiId.value === null && props.hasOpenSession,
)
const tabCtx = ref<{ x: number; y: number; tab: TerminalTab } | null>(null)
const stripCtx = ref<{ x: number; y: number } | null>(null)
const nativeMenuSupported = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function shortTitle(title: string): string {
  if (!title) return t('chat.tui.untitled')
  if (title.length > 22) return title.slice(0, 20) + '…'
  return title
}

function onTabClick(uiId: number) {
  markTabViewed(uiId)
  // 点已激活的 tab 不做切换 —— 避免和"× 关闭"的视觉位置混淆。要回 view 用左侧的 meta tab。
  if (activeUiId.value === uiId) return
  setActive(uiId)
}

function onListClick() {
  emit('listClick')
}
function onViewClick() {
  emit('viewClick')
}

function onClose(uiId: number, ev: Event) {
  ev.stopPropagation()
  const tab = tabs.value.find(t => t.uiId === uiId)
  const sessionPath = tab?.sessionPath ?? ''
  closeTab(uiId)
  emit('tabClosed', sessionPath)
}

function onStripDoubleClick(ev: MouseEvent) {
  const target = ev.target as HTMLElement | null
  if (target?.closest('.term-tab, .term-tab-ctx-menu')) return
  closeTabCtx()
  emit('newSession')
}

async function onStripContextMenu(ev: MouseEvent) {
  const target = ev.target as HTMLElement | null
  if (target?.closest('.term-tab, .term-tab-ctx-menu, .term-strip-ctx-menu')) return
  ev.preventDefault()
  closeTabCtx()
  if (await openNativeStripContextMenu(ev)) return
  openFallbackStripContextMenu(ev)
}

async function onTabContextMenu(tab: TerminalTab, ev: MouseEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  closeTabCtx()
  if (await openNativeTabContextMenu(tab, ev)) return
  openFallbackTabContextMenu(tab, ev)
}

async function openNativeTabContextMenu(tab: TerminalTab, ev: MouseEvent): Promise<boolean> {
  if (!nativeMenuSupported) return false
  try {
    const [{ Menu }, { LogicalPosition }] = await Promise.all([
      import('@tauri-apps/api/menu'),
      import('@tauri-apps/api/dpi'),
    ])
    const menu = await Menu.new({
      items: [
        {
          id: 'tab-rename',
          text: t('chat.tui.tabRename'),
          action: () => emit('tabRename', tab),
        },
        { item: 'Separator' },
        {
          id: 'tab-close',
          text: t('chat.tui.tabClose'),
          action: () => closeNativeCtxTab(tab),
        },
        {
          id: 'tab-close-others',
          text: t('chat.tui.tabCloseOthers'),
          action: () => closeOtherNativeCtxTabs(tab),
        },
        {
          id: 'tab-close-project',
          text: t('chat.tui.tabCloseProject'),
          action: () => closeProjectNativeCtxTabs(),
        },
      ],
    })
    await menu.popup(new LogicalPosition(ev.clientX, ev.clientY))
    return true
  } catch (err) {
    console.warn('Failed to open native tab context menu, falling back to HTML menu', err)
    return false
  }
}

async function openNativeStripContextMenu(ev: MouseEvent): Promise<boolean> {
  if (!nativeMenuSupported) return false
  try {
    const [{ Menu }, { LogicalPosition }] = await Promise.all([
      import('@tauri-apps/api/menu'),
      import('@tauri-apps/api/dpi'),
    ])
    const menu = await Menu.new({
      items: [
        {
          id: 'strip-new-session',
          text: t('list.action.newSession'),
          action: () => emit('newSession'),
        },
      ],
    })
    await menu.popup(new LogicalPosition(ev.clientX, ev.clientY))
    return true
  } catch (err) {
    console.warn('Failed to open native strip context menu, falling back to HTML menu', err)
    return false
  }
}

function openFallbackTabContextMenu(tab: TerminalTab, ev: MouseEvent) {
  const menuW = 220
  const menuH = 318
  tabCtx.value = {
    x: Math.max(8, Math.min(ev.clientX, window.innerWidth - menuW - 8)),
    y: Math.max(8, Math.min(ev.clientY, window.innerHeight - menuH - 8)),
    tab,
  }
}

function openFallbackStripContextMenu(ev: MouseEvent) {
  const menuW = 220
  const menuH = 44
  stripCtx.value = {
    x: Math.max(8, Math.min(ev.clientX, window.innerWidth - menuW - 8)),
    y: Math.max(8, Math.min(ev.clientY, window.innerHeight - menuH - 8)),
  }
}

function closeTabCtx() {
  tabCtx.value = null
  stripCtx.value = null
}

function newSessionFromStripCtx() {
  closeTabCtx()
  emit('newSession')
}

function renameCtxTab() {
  const tab = tabCtx.value?.tab
  closeTabCtx()
  if (tab) emit('tabRename', tab)
}

function closeCtxTab() {
  const tab = tabCtx.value?.tab
  closeTabCtx()
  if (!tab) return
  const sessionPath = tab.sessionPath ?? ''
  closeTab(tab.uiId)
  emit('tabClosed', sessionPath)
}

function closeOtherCtxTabs() {
  const tab = tabCtx.value?.tab
  closeTabCtx()
  if (!tab) return
  for (const item of visibleTabs.value) {
    if (item.uiId !== tab.uiId) closeTab(item.uiId)
  }
  emit('tabClosed', '')
}

function closeProjectCtxTabs() {
  closeTabCtx()
  closeProjectNativeCtxTabs()
}

function closeNativeCtxTab(tab: TerminalTab) {
  const sessionPath = tab.sessionPath ?? ''
  closeTab(tab.uiId)
  emit('tabClosed', sessionPath)
}

function closeOtherNativeCtxTabs(tab: TerminalTab) {
  for (const item of visibleTabs.value) {
    if (item.uiId !== tab.uiId) closeTab(item.uiId)
  }
  emit('tabClosed', '')
}

function closeProjectNativeCtxTabs() {
  for (const item of visibleTabs.value) {
    closeTab(item.uiId)
  }
  emit('tabClosed', '')
}


function onDocMouseDown(e: MouseEvent) {
  if (!tabCtx.value && !stripCtx.value) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.term-tab-ctx-menu, .term-strip-ctx-menu')) return
  closeTabCtx()
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeTabCtx()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onDocKeydown)
  document.addEventListener('wheel', closeTabCtx, { passive: true })
  window.addEventListener('blur', closeTabCtx)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onDocKeydown)
  document.removeEventListener('wheel', closeTabCtx)
  window.removeEventListener('blur', closeTabCtx)
})
</script>

<template>
  <div
    v-if="visible"
    class="terminal-strip"
    data-tauri-drag-region="false"
    @dblclick="onStripDoubleClick"
    @contextmenu="onStripContextMenu"
  >
    <div class="term-strip-scroll">
      <!-- List —— 项目浏览模式下永久显示 -->
      <div
        v-if="inProjectBrowse"
        class="term-tab view-tab"
        :class="{ active: listActive }"
        v-tooltip:bottom="t('chat.tui.listTabTooltip')"
        role="button"
        tabindex="0"
        @click="onListClick"
        @keydown.enter.prevent="onListClick"
        @keydown.space.prevent="onListClick"
      >
        <IconList class="term-tab-agent" />
        <span class="term-tab-title">{{ t('chat.tui.listTab') }}</span>
      </div>

      <!-- View —— 仅当用户已经打开了某个会话时显示 -->
      <div
        v-if="inProjectBrowse && hasOpenSession"
        class="term-tab view-tab"
        :class="{ active: viewActive }"
        v-tooltip:bottom="t('chat.tui.viewTabTooltip')"
        role="button"
        tabindex="0"
        @click="onViewClick"
        @keydown.enter.prevent="onViewClick"
        @keydown.space.prevent="onViewClick"
      >
        <IconChat class="term-tab-agent" />
        <span class="term-tab-title">{{ t('chat.tui.viewTab') }}</span>
      </div>

      <div
        v-if="inProjectBrowse && visibleTabs.length > 0"
        class="term-tab-sep"
        aria-hidden="true"
      />

      <div
      v-for="tab in visibleTabs"
      :key="tab.uiId"
      class="term-tab"
      :class="{
        active: activeUiId === tab.uiId,
        'state-working': statusKind(tab) === 'working',
        'state-done': statusKind(tab) === 'done',
        'state-blocked': statusKind(tab) === 'blocked',
        'state-error': statusKind(tab) === 'error',
        'state-exited': statusKind(tab) === 'exited',
        'state-unknown': statusKind(tab) === 'unknown',
      }"
      v-tooltip:bottom="tab.title"
      role="button"
      tabindex="0"
      @click="onTabClick(tab.uiId)"
      @contextmenu="onTabContextMenu(tab, $event)"
      @keydown.enter.prevent="onTabClick(tab.uiId)"
      @keydown.space.prevent="onTabClick(tab.uiId)"
    >
      <component :is="agentIcons[tab.agent]" class="term-tab-agent" :class="tab.agent" />
      <span class="term-tab-title">{{ shortTitle(tab.title) }}</span>
      <span
        v-if="statusKind(tab) === 'working'"
        class="term-tab-status term-tab-status-working"
        aria-hidden="true"
      >
        <i />
        <i />
        <i />
      </span>
      <span
        v-else-if="statusKind(tab) !== 'none'"
        class="term-tab-status"
        :class="'term-tab-status-' + statusKind(tab)"
        aria-hidden="true"
      />
      <span
        class="term-tab-close"
        v-tooltip:bottom="t('chat.tui.tabClose')"
        role="button"
        tabindex="0"
        @click="onClose(tab.uiId, $event)"
        @keydown.enter.prevent="onClose(tab.uiId, $event)"
      >
        <IconClose />
      </span>
      </div>

      <!-- Saved (lazy-restore) tabs: pill only, no xterm/PTY until clicked -->
      <div
        v-for="saved in visibleSaved"
        :key="'saved:' + saved.sessionPath"
        class="term-tab term-tab-saved"
        v-tooltip:bottom="saved.title"
        role="button"
        tabindex="0"
        @click="onSavedClick(saved)"
      >
        <component :is="agentIcons[saved.agent]" class="term-tab-agent" :class="saved.agent" />
        <span class="term-tab-title">{{ shortTitle(saved.title) }}</span>
        <span
          class="term-tab-close"
          v-tooltip:bottom="t('chat.tui.tabClose')"
          role="button"
          tabindex="0"
          @click="onSavedClose(saved, $event)"
          @keydown.enter.prevent="onSavedClose(saved, $event)"
        >
          <IconClose />
        </span>
      </div>
    </div>

    <div
      class="term-tab-new"
      v-tooltip:bottom="t('chat.tui.newSessionTitle')"
      role="button"
      tabindex="0"
      @click="emit('newSession')"
      @keydown.enter.prevent="emit('newSession')"
    >
      <IconPlus />
    </div>

    <div
      v-if="stripCtx"
      class="ctx-menu term-strip-ctx-menu"
      :style="{ left: stripCtx.x + 'px', top: stripCtx.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <button
        type="button"
        class="ctx-item"
        data-menu-action="strip-new-session"
        @click="newSessionFromStripCtx"
      >
        <span>{{ t('list.action.newSession') }}</span>
      </button>
    </div>

    <div
      v-if="tabCtx"
      class="ctx-menu term-tab-ctx-menu"
      :style="{ left: tabCtx.x + 'px', top: tabCtx.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <button type="button" class="ctx-item" data-menu-action="tab-rename" @click="renameCtxTab">
        <span>{{ t('chat.tui.tabRename') }}</span>
      </button>
      <div class="ctx-sep" />
      <button type="button" class="ctx-item" data-menu-action="tab-close" @click="closeCtxTab">
        <span>{{ t('chat.tui.tabClose') }}</span>
      </button>
      <button
        type="button"
        class="ctx-item"
        data-menu-action="tab-close-others"
        @click="closeOtherCtxTabs"
      >
        <span>{{ t('chat.tui.tabCloseOthers') }}</span>
      </button>
      <button
        type="button"
        class="ctx-item danger"
        data-menu-action="tab-close-project"
        @click="closeProjectCtxTabs"
      >
        <span>{{ t('chat.tui.tabCloseProject') }}</span>
      </button>
    </div>
  </div>
</template>
