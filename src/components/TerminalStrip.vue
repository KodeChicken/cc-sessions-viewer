<script setup lang="ts">
// TUI tab 栏 —— main 顶部的横条。左边两个"meta tab"固定描述底层 view：
//   List —— 项目的会话列表（永远显示，前提是处于项目浏览模式）
//   View —— 当前打开的聊天详情（只在 hasOpenSession 时出现）
// 之后是当前 (agent, projectKey) 范围内的所有活跃 PTY tab。
//
// 隐藏的 PTY tab（别的项目 / 别的 agent）不在这里出现，但 PTY 仍在后台跑 ——
// 切回对应项目时它们会再次显示，scrollback 全程不丢。

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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
import type { ViewHistoryEntry } from '../viewHistory'
import { viewHistory, sortViewHistory, toggleViewFavorite, removeView } from '../viewHistory'
import { statusKind } from '../tabStatus'
import { formatTime } from '../format'
import {
  IconClose,
  IconChat,
  IconList,
  IconPlus,
  IconTerminal,
  IconHistory,
  IconStar,
  IconReader,
  IconChevronDown,
  agentIcons,
} from './icons'
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
  /** 当前 View 层渲染的那条 view 的 key（session id / path）—— Views 下拉里据此高亮"正在看的那条" */
  activeViewKey: string | null
  /** 点了 List 但会话/聊天仍常驻（露出列表、View tab 还在）—— 决定 List/View 谁高亮 */
  viewingList: boolean
}>()

const emit = defineEmits<{
  /** List —— 关闭当前会话 + 退出 TUI，回到项目会话列表 */
  listClick: []
  /** View —— 保留当前会话，仅退出 TUI，回到聊天详情 */
  viewClick: []
  /** View 的 × —— 手动关闭聊天详情 tab，清掉当前会话，落回会话列表 */
  viewClose: []
  /** PTY tab 被手动关闭（点 ×）—— App 据此刷新数据 */
  tabClosed: []
  /** TUI tab 操作菜单 —— 复用会话重命名弹窗 */
  tabRename: [tab: TerminalTab]
  tabsReordered: []
  /** 入口 0 - 显式「新建会话(TUI)」（+ 菜单 / 右键菜单） */
  newSession: []
  /** 双击 tab 条空白处 / 默认新建手势 —— 由设置决定开 session/terminal/chat */
  newDefault: []
  /** 入口 1 - GUI：新开一个 live GUI chat */
  newGuiSession: []
  newShell: []
  hydrateSaved: [saved: SavedTab]
  /** saved tab 右键「重命名」—— 复用会话重命名弹窗（saved 分支只改内存标题） */
  savedRename: [saved: SavedTab]
  /** Views 下拉里点了某条历史 View —— App 据此把它渲染回 View tab */
  selectView: [entry: ViewHistoryEntry]
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

// ---- Views 下拉（List 和 View 之间的历史列表，每个 (agent, 项目) 独立）----
const viewsMenuOpen = ref(false)
const viewsMenuEl = ref<HTMLElement>()
const viewsFilter = ref('')
const viewsSearchEl = ref<HTMLInputElement>()
// 本项目历史里所有 View，按 (agent, projectKey) 过滤
const projectViews = computed(() =>
  viewHistory.value.filter(
    (v) => v.agent === props.agent && v.dir === (props.projectKey ?? ''),
  ),
)
// 收藏在前 + 搜索过滤后的列表（纯函数 sortViewHistory）；模板里按 favorite 边界插分组头
const sortedViews = computed(() => sortViewHistory(projectViews.value, viewsFilter.value))
// 有历史才显示 Views 控件，避免空项目堆控件
const hasViews = computed(() => projectViews.value.length > 0)

function toggleViewsMenu(ev?: Event) {
  ev?.stopPropagation()
  viewsMenuOpen.value = !viewsMenuOpen.value
  if (viewsMenuOpen.value) {
    nextTick(() => viewsSearchEl.value?.focus())
  } else {
    viewsFilter.value = ''
  }
}
function onPickView(entry: ViewHistoryEntry) {
  viewsMenuOpen.value = false
  viewsFilter.value = ''
  emit('selectView', entry)
}
function onToggleViewFav(entry: ViewHistoryEntry, ev: Event) {
  ev.stopPropagation()
  toggleViewFavorite(entry.agent, entry.dir, entry.session.id || entry.session.path)
}
function onRemoveView(entry: ViewHistoryEntry, ev: Event) {
  ev.stopPropagation()
  removeView(entry.agent, entry.dir, entry.session.id || entry.session.path)
}
function onViewsMenuDocClick(e: MouseEvent) {
  if (!viewsMenuOpen.value) return
  if (viewsMenuEl.value?.contains(e.target as Node)) return
  viewsMenuOpen.value = false
}
// 一旦打开了会话（View tab 存在），整条 strip 就保持可见 —— 即使右侧 PTY tab 全部关闭，
// List / View 两个 meta tab 仍在，View 只能由它自己的 × 手动关闭，不再自动隐藏。
const visible = computed(
  () =>
    visibleTabs.value.length > 0 ||
    visibleSaved.value.length > 0 ||
    // 有历史 View 时即便没开会话也显示 strip，让用户能从 List 上拉出 Views 下拉。
    (props.inProjectBrowse && (props.hasOpenSession || hasViews.value)),
)

function onSavedClick(saved: SavedTab) {
  removeSavedTab(saved.sessionPath ? saved.sessionPath : saved)
  emit('hydrateSaved', saved)
}

function onSavedClose(saved: SavedTab, ev: Event) {
  ev.stopPropagation()
  removeSavedTab(saved.sessionPath ? saved.sessionPath : saved)
}
const listActive = computed(
  () => activeUiId.value === null && (props.viewingList || !props.hasOpenSession),
)
const viewActive = computed(
  () => activeUiId.value === null && props.hasOpenSession && !props.viewingList,
)
const tabCtx = ref<{ x: number; y: number; tab: TerminalTab } | null>(null)
const savedCtx = ref<{ x: number; y: number; saved: SavedTab } | null>(null)
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

// ---- 横向滑动（无原生滚动条）: translateX + CSS transition ----
// 拿掉丑陋的横向滚动条，把 tab 条做成一个可滑动的遮罩区：所有 tab 放进 .term-strip-track，
// 用 transform: translateX(-scrollX) 平移；滚轮 / 拖空白处改 scrollX（跟手、关 transition），
// 点临近边缘的 tab / 新建 tab 则带 transition 平滑滑入。
const viewportRef = ref<HTMLElement>()
const trackRef = ref<HTMLElement>()
const scrollX = ref(0)
const maxScroll = ref(0)
// panning=true 时关掉 transition，让滚轮 / 拖拽 1:1 跟手；程序化滑动时为 false 走动画。
const panning = ref(false)
const canLeft = computed(() => scrollX.value > 0.5)
const canRight = computed(() => scrollX.value < maxScroll.value - 0.5)
const trackStyle = computed(() => ({ transform: `translateX(${-scrollX.value}px)` }))

function measure() {
  const vp = viewportRef.value
  const tr = trackRef.value
  maxScroll.value = vp && tr ? Math.max(0, tr.scrollWidth - vp.clientWidth) : 0
  if (scrollX.value > maxScroll.value) scrollX.value = maxScroll.value
}
function setScroll(x: number) {
  scrollX.value = Math.max(0, Math.min(x, maxScroll.value))
}

// 滚轮 / 触控板 → 横向平移（取代原生横向滚动）
let wheelIdleTimer = 0
function onWheel(ev: WheelEvent) {
  if (maxScroll.value <= 0) return
  const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY
  if (!delta) return
  ev.preventDefault()
  panning.value = true
  setScroll(scrollX.value + delta)
  window.clearTimeout(wheelIdleTimer)
  wheelIdleTimer = window.setTimeout(() => (panning.value = false), 140)
}

// 拖拽空白处 → 平移（tab 本体的拖拽留给排序逻辑，不在此响应）
let pan: { startX: number; startScroll: number } | null = null
function onPanPointerDown(ev: PointerEvent) {
  if (ev.button !== 0 || maxScroll.value <= 0) return
  const target = ev.target as HTMLElement | null
  if (target?.closest('.term-tab, .term-tab-new')) return
  pan = { startX: ev.clientX, startScroll: scrollX.value }
  panning.value = true
  window.addEventListener('pointermove', onPanPointerMove)
  window.addEventListener('pointerup', onPanPointerUp)
  window.addEventListener('pointercancel', onPanPointerUp)
}
function onPanPointerMove(ev: PointerEvent) {
  if (!pan) return
  setScroll(pan.startScroll - (ev.clientX - pan.startX))
}
function onPanPointerUp() {
  pan = null
  panning.value = false
  window.removeEventListener('pointermove', onPanPointerMove)
  window.removeEventListener('pointerup', onPanPointerUp)
  window.removeEventListener('pointercancel', onPanPointerUp)
}

// 把某个 tab 完整滑入视野；点临近边缘（被遮挡）的 tab 时露出它被切掉的部分
function revealEl(el: HTMLElement | null | undefined) {
  measure()
  const vp = viewportRef.value
  if (!vp || !el || maxScroll.value <= 0) return
  const tabRect = el.getBoundingClientRect()
  const vpRect = vp.getBoundingClientRect()
  const margin = 16
  let dx = 0
  if (tabRect.left < vpRect.left + margin) dx = tabRect.left - (vpRect.left + margin)
  else if (tabRect.right > vpRect.right - margin) dx = tabRect.right - (vpRect.right - margin)
  if (dx === 0) return
  panning.value = false // 程序化滑动：保留 transition 动画
  setScroll(scrollX.value + dx)
}
function revealActiveTab() {
  nextTick(() => {
    const el = trackRef.value?.querySelector<HTMLElement>(
      `.term-tab[data-tab-ui-id="${activeUiId.value}"]`,
    )
    revealEl(el)
  })
}

let stripRo: ResizeObserver | null = null
watch(
  viewportRef,
  (el) => {
    stripRo?.disconnect()
    stripRo = null
    if (!el || typeof ResizeObserver === 'undefined') return
    stripRo = new ResizeObserver(() => measure())
    stripRo.observe(el)
    nextTick(() => {
      if (trackRef.value && stripRo) stripRo.observe(trackRef.value)
      measure()
    })
  },
  { immediate: true },
)
watch([() => visibleTabs.value.length, () => visibleSaved.value.length], () => nextTick(measure))
watch(activeUiId, () => revealActiveTab())
onUnmounted(() => {
  stripRo?.disconnect()
  window.clearTimeout(wheelIdleTimer)
  window.removeEventListener('pointermove', onPanPointerMove)
  window.removeEventListener('pointerup', onPanPointerUp)
  window.removeEventListener('pointercancel', onPanPointerUp)
})

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
function pickNewGui() {
  newMenuOpen.value = false
  emit('newGuiSession')
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
onMounted(() => {
  document.addEventListener('click', onNewMenuDocClick)
  document.addEventListener('click', onViewsMenuDocClick)
})
onUnmounted(() => {
  document.removeEventListener('click', onNewMenuDocClick)
  document.removeEventListener('click', onViewsMenuDocClick)
})

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
  // 点临近边缘（被遮挡）的 tab 时，先把它完整滑入视野
  revealEl((ev?.currentTarget as HTMLElement) ?? null)
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
function onViewClose(ev: Event) {
  ev.stopPropagation()
  emit('viewClose')
}

function onClose(uiId: number, ev: Event) {
  ev.stopPropagation()
  closeTab(uiId)
  emit('tabClosed')
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
  emit('newDefault')
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

// saved（懒恢复）tab 右键 —— 和 live tab 一致：先试原生 Tauri 菜单，失败再退 HTML 菜单。
// 在此之前 saved tab 没挂 @contextmenu，会落到 webview 原生菜单，和 live tab 不一致。
async function onSavedContextMenu(saved: SavedTab, ev: MouseEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  closeTabCtx()
  if (await openNativeSavedContextMenu(saved, ev)) return
  openFallbackSavedContextMenu(saved, ev)
}

async function openNativeSavedContextMenu(saved: SavedTab, ev: MouseEvent): Promise<boolean> {
  if (!nativeMenuSupported) return false
  try {
    const [{ Menu }, { LogicalPosition }] = await Promise.all([
      import('@tauri-apps/api/menu'),
      import('@tauri-apps/api/dpi'),
    ])
    const menu = await Menu.new({
      items: [
        {
          id: 'saved-rename',
          text: t(saved.isShell ? 'chat.tui.tabRenameShell' : 'chat.tui.tabRename'),
          action: () => emit('savedRename', saved),
        },
        { item: 'Separator' },
        {
          id: 'saved-close',
          text: t('chat.tui.tabClose'),
          action: () => removeSaved(saved),
        },
        {
          id: 'saved-close-others',
          text: t('chat.tui.tabCloseOthers'),
          action: () => closeOthersFromSaved(saved),
        },
        {
          id: 'saved-close-project',
          text: t('chat.tui.tabCloseProject'),
          action: () => closeProjectAllTabs(),
        },
      ],
    })
    await menu.popup(new LogicalPosition(ev.clientX, ev.clientY))
    return true
  } catch (err) {
    console.warn('Failed to open native saved tab context menu, falling back to HTML menu', err)
    return false
  }
}

function openFallbackSavedContextMenu(saved: SavedTab, ev: MouseEvent) {
  const menuW = 220
  const menuH = 318
  savedCtx.value = {
    x: Math.max(8, Math.min(ev.clientX, window.innerWidth - menuW - 8)),
    y: Math.max(8, Math.min(ev.clientY, window.innerHeight - menuH - 8)),
    saved,
  }
}

function removeSaved(saved: SavedTab) {
  removeSavedTab(saved.sessionPath ? saved.sessionPath : saved)
}

// 关闭「其它」：saved tab 视角下，其它 = 所有 live tab + 除自己外的 saved tab。
function closeOthersFromSaved(saved: SavedTab) {
  for (const item of visibleTabs.value) closeTab(item.uiId)
  for (const s of [...visibleSaved.value]) {
    if (s !== saved) removeSavedTab(s.sessionPath ? s.sessionPath : s)
  }
  emit('tabClosed')
}

// 关闭整个项目：live + saved 全清。
function closeProjectAllTabs() {
  for (const item of visibleTabs.value) closeTab(item.uiId)
  for (const s of [...visibleSaved.value]) removeSavedTab(s.sessionPath ? s.sessionPath : s)
  emit('tabClosed')
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
          text: t('list.action.newSessionTui'),
          action: () => emit('newSession'),
        },
        // New chat (GUI) 目前只有 claude 支持；codex / gemini 先不放这一项。
        ...(props.agent === 'claude'
          ? [
              {
                id: 'strip-new-gui',
                text: t('list.action.newSessionGui'),
                action: () => emit('newGuiSession'),
              },
            ]
          : []),
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
  savedCtx.value = null
}

function newSessionFromStripCtx() {
  closeTabCtx()
  emit('newSession')
}
function newGuiFromStripCtx() {
  closeTabCtx()
  emit('newGuiSession')
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
  closeTab(tab.uiId)
  emit('tabClosed')
}

function closeOtherCtxTabs() {
  const tab = tabCtx.value?.tab
  closeTabCtx()
  if (!tab) return
  for (const item of visibleTabs.value) {
    if (item.uiId !== tab.uiId) closeTab(item.uiId)
  }
  emit('tabClosed')
}

function closeProjectCtxTabs() {
  closeTabCtx()
  closeProjectNativeCtxTabs()
}

// ---- saved tab 的 HTML fallback 菜单动作（读 savedCtx）----
function renameCtxSaved() {
  const saved = savedCtx.value?.saved
  closeTabCtx()
  if (saved) emit('savedRename', saved)
}
function closeCtxSaved() {
  const saved = savedCtx.value?.saved
  closeTabCtx()
  if (saved) removeSaved(saved)
}
function closeOthersCtxSaved() {
  const saved = savedCtx.value?.saved
  closeTabCtx()
  if (saved) closeOthersFromSaved(saved)
}
function closeProjectCtxSaved() {
  closeTabCtx()
  closeProjectAllTabs()
}

function closeNativeCtxTab(tab: TerminalTab) {
  closeTab(tab.uiId)
  emit('tabClosed')
}

function closeOtherNativeCtxTabs(tab: TerminalTab) {
  for (const item of visibleTabs.value) {
    if (item.uiId !== tab.uiId) closeTab(item.uiId)
  }
  emit('tabClosed')
}

function closeProjectNativeCtxTabs() {
  for (const item of visibleTabs.value) {
    closeTab(item.uiId)
  }
  emit('tabClosed')
}


function onDocMouseDown(e: MouseEvent) {
  if (!tabCtx.value && !stripCtx.value && !savedCtx.value) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.term-tab-ctx-menu, .term-strip-ctx-menu')) return
  closeTabCtx()
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeTabCtx()
    viewsMenuOpen.value = false
  }
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
    <!-- 固定 meta tab：List / View 永远钉在左侧，不随终端 tab 一起滑动 -->
    <div v-if="inProjectBrowse" class="term-strip-meta">
      <!-- List —— 项目浏览模式下永久显示 -->
      <div
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

      <!-- Views —— List 和 View 之间的历史下拉：每个 (agent, 项目) 独立，可搜索 + 收藏。
           选一条历史 View 即渲染回右侧的 View tab；View tab 本身不变。 -->
      <div v-if="hasViews" ref="viewsMenuEl" class="views-menu-wrap">
        <div
          class="term-tab view-tab views-tab"
          :class="{ active: viewsMenuOpen }"
          v-tooltip:bottom="t('chat.tui.viewsTabTooltip')"
          role="button"
          tabindex="0"
          @click.stop="toggleViewsMenu"
          @keydown.enter.prevent="toggleViewsMenu"
          @keydown.space.prevent="toggleViewsMenu"
        >
          <IconHistory class="term-tab-agent" />
          <span class="term-tab-title">{{ t('chat.tui.viewsTab') }}</span>
          <IconChevronDown class="views-tab-caret" />
        </div>
        <div
          v-if="viewsMenuOpen"
          class="views-menu"
          role="menu"
          @contextmenu.stop.prevent
        >
          <div class="views-menu-search">
            <input
              ref="viewsSearchEl"
              v-model="viewsFilter"
              class="views-search-input"
              :placeholder="t('chat.tui.viewsSearchPlaceholder')"
              @keydown.escape.stop="viewsMenuOpen = false"
              @click.stop
            />
          </div>
          <div class="views-menu-list">
            <template v-for="(entry, idx) in sortedViews" :key="entry.session.id || entry.session.path">
              <div
                v-if="idx === 0 && entry.favorite"
                class="views-menu-group"
              >
                {{ t('chat.tui.viewsFavorites') }}
              </div>
              <div
                v-if="!entry.favorite && idx > 0 && sortedViews[idx - 1].favorite"
                class="views-menu-group"
              >
                {{ t('chat.tui.viewsRecent') }}
              </div>
              <div
                class="views-menu-item"
                :class="{ active: (entry.session.id || entry.session.path) === activeViewKey }"
                role="button"
                tabindex="0"
                @click="onPickView(entry)"
                @keydown.enter.prevent="onPickView(entry)"
              >
                <component
                  :is="entry.mode === 'chat' ? IconChat : IconReader"
                  class="views-item-mode"
                  v-tooltip:bottom="
                    entry.mode === 'chat' ? t('chat.action.switchToChat') : t('list.action.view')
                  "
                />
                <span class="views-item-text">{{
                  entry.session.title || t('chat.tui.untitled')
                }}</span>
                <span class="views-item-time">{{ formatTime(entry.openedAt) }}</span>
                <span
                  class="views-item-star"
                  :class="{ filled: entry.favorite }"
                  v-tooltip:bottom="
                    entry.favorite ? t('chat.action.unfavorite') : t('chat.action.favorite')
                  "
                  role="button"
                  tabindex="0"
                  @click="onToggleViewFav(entry, $event)"
                  @keydown.enter.prevent="onToggleViewFav(entry, $event)"
                >
                  <IconStar />
                </span>
                <span
                  class="views-item-remove"
                  v-tooltip:bottom="t('chat.tui.viewRemove')"
                  role="button"
                  tabindex="0"
                  @click="onRemoveView(entry, $event)"
                  @keydown.enter.prevent="onRemoveView(entry, $event)"
                >
                  <IconClose />
                </span>
              </div>
            </template>
            <div v-if="!sortedViews.length" class="views-menu-empty">
              {{ viewsFilter ? t('chat.tui.viewsNoMatch') : t('chat.tui.viewsEmpty') }}
            </div>
          </div>
        </div>
      </div>

      <!-- View —— 打开会话后常驻；只能点它自己的 × 手动关闭，不随 PTY tab 关闭而隐藏 -->
      <div
        v-if="hasOpenSession"
        class="term-tab view-tab view-tab-closable"
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
        <span
          class="term-tab-close"
          v-tooltip:bottom="t('chat.tui.tabClose')"
          role="button"
          tabindex="0"
          @click="onViewClose"
          @keydown.enter.prevent="onViewClose"
        >
          <IconClose />
        </span>
      </div>

      <div
        v-if="visibleTabs.length > 0 || visibleSaved.length > 0"
        class="term-tab-sep"
        aria-hidden="true"
      />
    </div>

    <!-- 滑动区（红框动效区域）：只放终端 / saved tab -->
    <div
      ref="viewportRef"
      class="term-strip-scroll"
      :class="{ 'can-left': canLeft, 'can-right': canRight }"
      @wheel="onWheel"
      @pointerdown="onPanPointerDown"
    >
      <div ref="trackRef" class="term-strip-track" :class="{ panning }" :style="trackStyle">

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
        @contextmenu="onSavedContextMenu(saved, $event)"
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
          <span>{{ t('list.action.newSessionTui') }}</span>
        </button>
        <button type="button" class="new-menu-item" role="menuitem" @click="pickNewGui">
          <IconChat class="new-menu-ic" />
          <span>{{ t('list.action.newSessionGui') }}</span>
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
        <span>{{ t('list.action.newSessionTui') }}</span>
      </button>
      <button
        v-if="agent === 'claude'"
        type="button"
        class="ctx-item"
        data-menu-action="strip-new-gui"
        @click="newGuiFromStripCtx"
      >
        <span>{{ t('list.action.newSessionGui') }}</span>
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

    <div
      v-if="savedCtx"
      class="ctx-menu term-tab-ctx-menu"
      :style="{ left: savedCtx.x + 'px', top: savedCtx.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <button type="button" class="ctx-item" data-menu-action="saved-rename" @click="renameCtxSaved">
        <span>{{ t(savedCtx?.saved?.isShell ? 'chat.tui.tabRenameShell' : 'chat.tui.tabRename') }}</span>
      </button>
      <div class="ctx-sep" />
      <button type="button" class="ctx-item" data-menu-action="saved-close" @click="closeCtxSaved">
        <span>{{ t('chat.tui.tabClose') }}</span>
      </button>
      <button
        type="button"
        class="ctx-item"
        data-menu-action="saved-close-others"
        @click="closeOthersCtxSaved"
      >
        <span>{{ t('chat.tui.tabCloseOthers') }}</span>
      </button>
      <button
        type="button"
        class="ctx-item danger"
        data-menu-action="saved-close-project"
        @click="closeProjectCtxSaved"
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
