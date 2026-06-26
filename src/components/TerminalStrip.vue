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
import {
  tabs,
  activeUiId,
  setActive,
  closeTab,
  markTabViewed,
  savedTabs,
  removeSavedTab,
  moveTab,
} from '../terminals'
import { statusKind } from '../tabStatus'
import { IconClose, IconChat, IconList, IconPlus, IconTerminal, agentIcons } from './icons'
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
  tabsReordered: []
  /** 双击 tab 条空白处 —— 开一个纯 shell tab */
  newSession: []
  newShell: []
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
  removeSavedTab(saved.sessionPath ? saved.sessionPath : saved)
  emit('hydrateSaved', saved)
}

function onSavedClose(saved: SavedTab, ev: Event) {
  ev.stopPropagation()
  removeSavedTab(saved.sessionPath ? saved.sessionPath : saved)
}
const listActive = computed(
  () => activeUiId.value === null && !props.hasOpenSession,
)
const viewActive = computed(
  () => activeUiId.value === null && props.hasOpenSession,
)
const tabCtx = ref<{ x: number; y: number; tab: TerminalTab } | null>(null)
const stripCtx = ref<{ x: number; y: number } | null>(null)
const draggingTabUiId = ref<number | null>(null)
const dropTarget = ref<{ uiId: number; position: 'before' | 'after' } | null>(null)
const dragPreview = ref<{
  tab: TerminalTab
  x: number
  y: number
  width: number
  offsetX: number
  offsetY: number
} | null>(null)
const nativeMenuSupported = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
let pendingDrag: { uiId: number; startX: number; startY: number } | null = null
let suppressNextTabClick = false

// ---- 新建会话下拉菜单（+ 按钮） ----
const newMenuOpen = ref(false)
const newMenuEl = ref<HTMLElement>()
function toggleNewMenu(ev?: Event) {
  ev?.stopPropagation()
  newMenuOpen.value = !newMenuOpen.value
}
function pickNewAgent() {
  newMenuOpen.value = false
  emit('newSession')
}
function pickNewShell() {
  newMenuOpen.value = false
  emit('newShell')
}
function onNewMenuDocClick(e: MouseEvent) {
  if (!newMenuOpen.value) return
  if (newMenuEl.value?.contains(e.target as Node)) return
  newMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', onNewMenuDocClick))
onUnmounted(() => document.removeEventListener('click', onNewMenuDocClick))

function shortTitle(title: string): string {
  if (!title) return t('chat.tui.untitled')
  if (title.length > 22) return title.slice(0, 20) + '…'
  return title
}

function onTabClick(uiId: number, ev?: Event) {
  if (suppressNextTabClick) {
    ev?.preventDefault()
    ev?.stopPropagation()
    suppressNextTabClick = false
    return
  }
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

function renameTab(tab: TerminalTab, ev?: Event) {
  ev?.stopPropagation()
  closeTabCtx()
  emit('tabRename', tab)
}

function clearDragState() {
  pendingDrag = null
  draggingTabUiId.value = null
  dropTarget.value = null
  dragPreview.value = null
  document.body.classList.remove('is-tab-reordering')
  window.removeEventListener('pointermove', onTabPointerMove)
  window.removeEventListener('pointerup', onTabPointerUp)
  window.removeEventListener('pointercancel', onTabPointerUp)
}

function onTabPointerDown(tab: TerminalTab, ev: PointerEvent) {
  if (ev.button !== 0 || visibleTabs.value.length < 2) return
  const target = ev.target as HTMLElement | null
  if (target?.closest('.term-tab-close')) return
  pendingDrag = { uiId: tab.uiId, startX: ev.clientX, startY: ev.clientY }
  window.addEventListener('pointermove', onTabPointerMove)
  window.addEventListener('pointerup', onTabPointerUp)
  window.addEventListener('pointercancel', onTabPointerUp)
}

function onTabPointerMove(ev: PointerEvent) {
  if (!pendingDrag) return
  const dx = ev.clientX - pendingDrag.startX
  const dy = ev.clientY - pendingDrag.startY
  if (draggingTabUiId.value === null) {
    if (Math.hypot(dx, dy) < 5) return
    closeTabCtx()
    draggingTabUiId.value = pendingDrag.uiId
    dropTarget.value = null
    suppressNextTabClick = true
    const sourceEl = document.querySelector<HTMLElement>(`.term-tab[data-tab-ui-id="${pendingDrag.uiId}"]`)
    const rect = sourceEl?.getBoundingClientRect()
    const tab = tabs.value.find((t) => t.uiId === pendingDrag?.uiId)
    if (rect && tab) {
      dragPreview.value = {
        tab,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        offsetX: pendingDrag.startX - rect.left,
        offsetY: pendingDrag.startY - rect.top,
      }
    }
    document.body.classList.add('is-tab-reordering')
  }
  ev.preventDefault()
  if (dragPreview.value) {
    dragPreview.value.x = ev.clientX - dragPreview.value.offsetX
    dragPreview.value.y = ev.clientY - dragPreview.value.offsetY
  }
  updateDropTargetFromPoint(ev.clientX, ev.clientY)
}

function updateDropTargetFromPoint(x: number, y: number) {
  const sourceUiId = draggingTabUiId.value
  if (sourceUiId === null) return
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.term-tab[data-tab-ui-id]')
  const targetUiId = Number(el?.dataset.tabUiId)
  if (!el || !Number.isFinite(targetUiId) || targetUiId === sourceUiId) {
    dropTarget.value = null
    return
  }
  const rect = el.getBoundingClientRect()
  dropTarget.value = {
    uiId: targetUiId,
    position: x < rect.left + rect.width / 2 ? 'before' : 'after',
  }
}

function onTabPointerUp(ev: PointerEvent) {
  const sourceUiId = draggingTabUiId.value
  const target = dropTarget.value
  if (sourceUiId !== null && target && moveTab(sourceUiId, target.uiId, target.position)) {
    emit('tabsReordered')
  }
  clearDragState()
  if (sourceUiId !== null) {
    ev.preventDefault()
    window.setTimeout(() => {
      suppressNextTabClick = false
    }, 0)
  }
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
          text: t(tab.isShell ? 'chat.tui.tabRenameShell' : 'chat.tui.tabRename'),
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
          id: 'strip-new-agent',
          text: t('list.action.newAgentSession'),
          action: () => emit('newSession'),
        },
        {
          id: 'strip-new-shell',
          text: t('list.action.newTerminal'),
          action: () => emit('newShell'),
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
  const menuH = 80
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
function newShellFromStripCtx() {
  closeTabCtx()
  emit('newShell')
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
  clearDragState()
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
          dragging: draggingTabUiId === tab.uiId,
          'drop-before': dropTarget?.uiId === tab.uiId && dropTarget.position === 'before',
          'drop-after': dropTarget?.uiId === tab.uiId && dropTarget.position === 'after',
          'state-working': !tab.isShell && statusKind(tab) === 'working',
          'state-done': !tab.isShell && statusKind(tab) === 'done',
          'state-blocked': !tab.isShell && statusKind(tab) === 'blocked',
          'state-error': !tab.isShell && statusKind(tab) === 'error',
          'state-exited': !tab.isShell && statusKind(tab) === 'exited',
          'state-unknown': !tab.isShell && statusKind(tab) === 'unknown',
        }"
        v-tooltip:bottom="tab.title"
        :data-tab-ui-id="tab.uiId"
        role="button"
        tabindex="0"
        @click="onTabClick(tab.uiId, $event)"
        @dblclick.stop="renameTab(tab, $event)"
        @contextmenu="onTabContextMenu(tab, $event)"
        @pointerdown="onTabPointerDown(tab, $event)"
        @keydown.enter.prevent="onTabClick(tab.uiId)"
        @keydown.space.prevent="onTabClick(tab.uiId)"
      >
        <IconTerminal v-if="tab.isShell" class="term-tab-agent" />
        <component v-else :is="agentIcons[tab.agent]" class="term-tab-agent" :class="tab.agent" />
        <span class="term-tab-title">{{ shortTitle(tab.title) }}</span>
        <span
          v-if="!tab.isShell && statusKind(tab) === 'working'"
          class="term-tab-status term-tab-status-working"
          aria-hidden="true"
        >
          <i />
          <i />
          <i />
        </span>
        <span
          v-else-if="!tab.isShell && statusKind(tab) !== 'none'"
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
        v-for="(saved, si) in visibleSaved"
        :key="'saved:' + (saved.sessionPath || `shell-${si}`)"
        class="term-tab term-tab-saved"
        v-tooltip:bottom="saved.title"
        role="button"
        tabindex="0"
        @click="onSavedClick(saved)"
      >
        <IconTerminal v-if="saved.isShell" class="term-tab-agent" />
        <component v-else :is="agentIcons[saved.agent]" class="term-tab-agent" :class="saved.agent" />
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

    <div ref="newMenuEl" class="new-menu-wrap" style="flex-shrink:0">
      <div
        class="term-tab-new"
        :class="{ active: newMenuOpen }"
        v-tooltip:bottom="t('list.action.newSession')"
        role="button"
        tabindex="0"
        @click.stop="toggleNewMenu"
        @keydown.enter.prevent="toggleNewMenu"
      >
        <IconPlus />
      </div>
      <div v-if="newMenuOpen" class="new-menu" role="menu">
        <button type="button" class="new-menu-item" role="menuitem" @click="pickNewAgent">
          <component :is="agentIcons[agent]" class="new-menu-ic" />
          <span>{{ t('list.action.newAgentSession') }}</span>
        </button>
        <button type="button" class="new-menu-item" role="menuitem" @click="pickNewShell">
          <IconTerminal class="new-menu-ic" />
          <span>{{ t('list.action.newTerminal') }}</span>
        </button>
      </div>
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
        data-menu-action="strip-new-agent"
        @click="newSessionFromStripCtx"
      >
        <span>{{ t('list.action.newAgentSession') }}</span>
      </button>
      <button
        type="button"
        class="ctx-item"
        data-menu-action="strip-new-shell"
        @click="newShellFromStripCtx"
      >
        <span>{{ t('list.action.newTerminal') }}</span>
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
        <span>{{ t(tabCtx?.tab?.isShell ? 'chat.tui.tabRenameShell' : 'chat.tui.tabRename') }}</span>
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

    <Teleport to="body">
      <div
        v-if="dragPreview"
        class="term-tab term-tab-drag-preview"
        :class="{
          active: activeUiId === dragPreview.tab.uiId,
          'state-working': !dragPreview.tab.isShell && statusKind(dragPreview.tab) === 'working',
          'state-done': !dragPreview.tab.isShell && statusKind(dragPreview.tab) === 'done',
          'state-blocked': !dragPreview.tab.isShell && statusKind(dragPreview.tab) === 'blocked',
          'state-error': !dragPreview.tab.isShell && statusKind(dragPreview.tab) === 'error',
          'state-exited': !dragPreview.tab.isShell && statusKind(dragPreview.tab) === 'exited',
          'state-unknown': !dragPreview.tab.isShell && statusKind(dragPreview.tab) === 'unknown',
        }"
        :style="{
          left: dragPreview.x + 'px',
          top: dragPreview.y + 'px',
          width: dragPreview.width + 'px',
        }"
      >
        <IconTerminal v-if="dragPreview.tab.isShell" class="term-tab-agent" />
        <component
          v-else
          :is="agentIcons[dragPreview.tab.agent]"
          class="term-tab-agent"
          :class="dragPreview.tab.agent"
        />
        <span class="term-tab-title">{{ shortTitle(dragPreview.tab.title) }}</span>
        <span
          v-if="!dragPreview.tab.isShell && statusKind(dragPreview.tab) === 'working'"
          class="term-tab-status term-tab-status-working"
          aria-hidden="true"
        >
          <i />
          <i />
          <i />
        </span>
        <span
          v-else-if="!dragPreview.tab.isShell && statusKind(dragPreview.tab) !== 'none'"
          class="term-tab-status"
          :class="'term-tab-status-' + statusKind(dragPreview.tab)"
          aria-hidden="true"
        />
      </div>
    </Teleport>
  </div>
</template>
