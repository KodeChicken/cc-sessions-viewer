<script setup lang="ts">
// TUI tab 栏 —— main 顶部的横条。左边 List 固定，之后是 view tabs（会话查看 / chat），
// 再后面是当前 (agent, projectKey) 范围内的所有活跃 PTY tab。
// 隐藏的 PTY/view tab（别的项目 / 别的 agent）不在这里出现，但仍在后台活着。

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
import { statusKind } from '../tabStatus'
import type { ViewTab } from '../viewTabs'
import {
  IconClose,
  IconChat,
  IconList,
  IconPlus,
  IconReader,
  IconTerminal,
  agentIcons,
} from './icons'
import { t } from '../i18n'

const props = defineProps<{
  agent: Agent
  projectKey: string | null
  inProjectBrowse: boolean
  viewTabs: ViewTab[]
  activeViewTabId: number | null
}>()

const emit = defineEmits<{
  /** List —— 关闭当前会话 + 退出 TUI，回到项目会话列表 */
  listClick: []
  /** View tab 被点击 —— 激活指定 view tab */
  viewClick: [uiId: number]
  /** View tab × 被点击 —— 关闭指定 view tab */
  viewClose: [uiId: number]
  /** View tab 右键菜单操作 */
  viewRename: [vt: ViewTab]
  viewCloseOthers: [vt: ViewTab]
  viewCloseProject: [type: 'session' | 'chat']
  /** 关闭除指定 tab 外的所有 tab（终端 + view） */
  closeOthersAll: [keepUiId: number, keepKind: 'tui' | 'view']
  /** 关闭当前项目所有 tab（终端 + view） */
  closeAll: []
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

type UnifiedTab =
  | { kind: 'tui'; tab: TerminalTab; order: number }
  | { kind: 'saved'; saved: SavedTab; index: number; order: number }
  | { kind: 'view'; vt: ViewTab; order: number }

const unifiedTabs = computed<UnifiedTab[]>(() => {
  const items: UnifiedTab[] = []
  for (const tab of visibleTabs.value) {
    items.push({ kind: 'tui', tab, order: tab.createdAt })
  }
  for (let i = 0; i < visibleSaved.value.length; i++) {
    const saved = visibleSaved.value[i]
    items.push({ kind: 'saved', saved, index: i, order: saved.createdAt ?? 0 })
  }
  for (const vt of props.viewTabs) {
    items.push({ kind: 'view', vt, order: vt.createdAt })
  }
  items.sort((a, b) => a.order - b.order)
  return items
})

// 一旦打开了会话（View tab 存在），整条 strip 就保持可见 —— 即使右侧 PTY tab 全部关闭，
// List / View 两个 meta tab 仍在，View 只能由它自己的 × 手动关闭，不再自动隐藏。
const visible = computed(
  () =>
    visibleTabs.value.length > 0 ||
    visibleSaved.value.length > 0 ||
    (props.inProjectBrowse && props.viewTabs.length > 0),
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
  () => activeUiId.value === null && props.activeViewTabId === null,
)
const tabCtx = ref<{ x: number; y: number; tab: TerminalTab } | null>(null)
const savedCtx = ref<{ x: number; y: number; saved: SavedTab } | null>(null)
const stripCtx = ref<{ x: number; y: number } | null>(null)
const viewTabCtx = ref<{ x: number; y: number; vt: ViewTab; typeLabel: string } | null>(null)
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
})
onUnmounted(() => {
  document.removeEventListener('click', onNewMenuDocClick)
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
function onViewTabClick(uiId: number) {
  emit('viewClick', uiId)
}
function onViewTabClose(uiId: number, ev: Event) {
  ev.stopPropagation()
  emit('viewClose', uiId)
}

async function onViewTabContextMenu(vt: ViewTab, ev: MouseEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  if (await openNativeViewTabContextMenu(vt, ev)) return
  openFallbackViewTabContextMenu(vt, ev)
}

async function openNativeViewTabContextMenu(vt: ViewTab, ev: MouseEvent): Promise<boolean> {
  if (!nativeMenuSupported) return false
  try {
    const [{ Menu }, { LogicalPosition }] = await Promise.all([
      import('@tauri-apps/api/menu'),
      import('@tauri-apps/api/dpi'),
    ])
    const typeLabel = vt.type === 'chat' ? t('chat.tui.chatTab') : t('chat.tui.viewTab')
    const menu = await Menu.new({
      items: [
        {
          id: 'vt-rename',
          text: t('chat.tui.tabRenameView'),
          action: () => emit('viewRename', vt),
        },
        { item: 'Separator' },
        {
          id: 'vt-close',
          text: t('chat.tui.tabClose'),
          action: () => emit('viewClose', vt.uiId),
        },
        {
          id: 'vt-close-others',
          text: t('chat.tui.tabCloseOthersView', { type: typeLabel }),
          action: () => emit('viewCloseOthers', vt),
        },
        {
          id: 'vt-close-project',
          text: t('chat.tui.tabCloseProjectView', { type: typeLabel }),
          action: () => emit('viewCloseProject', vt.type),
        },
        { item: 'Separator' },
        {
          id: 'vt-close-others-all',
          text: t('chat.tui.tabCloseOthersAll'),
          action: () => emit('closeOthersAll', vt.uiId, 'view'),
        },
        {
          id: 'vt-close-all',
          text: t('chat.tui.tabCloseAll'),
          action: () => emit('closeAll'),
        },
      ],
    })
    await menu.popup(new LogicalPosition(ev.clientX, ev.clientY))
    return true
  } catch {
    return false
  }
}

function openFallbackViewTabContextMenu(vt: ViewTab, ev: MouseEvent) {
  const typeLabel = vt.type === 'chat' ? t('chat.tui.chatTab') : t('chat.tui.viewTab')
  viewTabCtx.value = {
    x: Math.max(8, Math.min(ev.clientX, window.innerWidth - 220 - 8)),
    y: Math.max(8, Math.min(ev.clientY, window.innerHeight - 200 - 8)),
    vt,
    typeLabel,
  }
}

function closeViewTabCtx() {
  viewTabCtx.value = null
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
        { item: 'Separator' },
        {
          id: 'saved-close-all',
          text: t('chat.tui.tabCloseAll'),
          action: () => emit('closeAll'),
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
          text: t(tab.isShell ? 'chat.tui.tabCloseOthers' : 'chat.tui.tabCloseOthersSession'),
          action: () => closeOtherNativeCtxTabs(tab),
        },
        {
          id: 'tab-close-project',
          text: t(tab.isShell ? 'chat.tui.tabCloseProject' : 'chat.tui.tabCloseProjectSession'),
          action: () => closeProjectNativeCtxTabs(tab),
        },
        { item: 'Separator' },
        {
          id: 'tab-close-others-all',
          text: t('chat.tui.tabCloseOthersAll'),
          action: () => emit('closeOthersAll', tab.uiId, 'tui'),
        },
        {
          id: 'tab-close-all',
          text: t('chat.tui.tabCloseAll'),
          action: () => emit('closeAll'),
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
  viewTabCtx.value = null
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
    if (item.uiId !== tab.uiId && item.isShell === tab.isShell) closeTab(item.uiId)
  }
  emit('tabClosed')
}

function closeProjectCtxTabs() {
  const tab = tabCtx.value?.tab
  closeTabCtx()
  if (tab) closeProjectNativeCtxTabs(tab)
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
    if (item.uiId !== tab.uiId && item.isShell === tab.isShell) closeTab(item.uiId)
  }
  for (const s of [...visibleSaved.value]) {
    if (s.isShell === tab.isShell) removeSavedTab(s.sessionPath ? s.sessionPath : s)
  }
  emit('tabClosed')
}

function closeProjectNativeCtxTabs(tab: TerminalTab) {
  for (const item of visibleTabs.value) {
    if (item.isShell === tab.isShell) closeTab(item.uiId)
  }
  for (const s of [...visibleSaved.value]) {
    if (s.isShell === tab.isShell) removeSavedTab(s.sessionPath ? s.sessionPath : s)
  }
  emit('tabClosed')
}


function onDocMouseDown(e: MouseEvent) {
  if (!tabCtx.value && !stripCtx.value && !savedCtx.value && !viewTabCtx.value) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.term-tab-ctx-menu, .term-strip-ctx-menu')) return
  closeTabCtx()
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeTabCtx()
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

      <div
        v-if="viewTabs.length > 0 || visibleTabs.length > 0 || visibleSaved.length > 0"
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

      <template v-for="ut in unifiedTabs" :key="ut.kind === 'tui' ? ut.tab.uiId : ut.kind === 'saved' ? 'saved:' + (ut.saved.sessionPath || `shell-${ut.index}`) : 'vt:' + ut.vt.uiId">
        <!-- TUI (live terminal/session) tab -->
        <div
          v-if="ut.kind === 'tui'"
          class="term-tab"
          :class="{
            active: activeUiId === ut.tab.uiId,
            dragging: draggingTabUiId === ut.tab.uiId,
            'drop-before': dropTarget?.uiId === ut.tab.uiId && dropTarget.position === 'before',
            'drop-after': dropTarget?.uiId === ut.tab.uiId && dropTarget.position === 'after',
            'state-working': !ut.tab.isShell && statusKind(ut.tab) === 'working',
            'state-done': !ut.tab.isShell && statusKind(ut.tab) === 'done',
            'state-blocked': !ut.tab.isShell && statusKind(ut.tab) === 'blocked',
            'state-error': !ut.tab.isShell && statusKind(ut.tab) === 'error',
            'state-exited': !ut.tab.isShell && statusKind(ut.tab) === 'exited',
            'state-unknown': !ut.tab.isShell && statusKind(ut.tab) === 'unknown',
          }"
          v-tooltip:bottom="ut.tab.title"
          :data-tab-ui-id="ut.tab.uiId"
          role="button"
          tabindex="0"
          @click="onTabClick(ut.tab.uiId, $event)"
          @dblclick.stop="renameTab(ut.tab, $event)"
          @contextmenu="onTabContextMenu(ut.tab, $event)"
          @pointerdown="onTabPointerDown(ut.tab, $event)"
          @keydown.enter.prevent="onTabClick(ut.tab.uiId)"
          @keydown.space.prevent="onTabClick(ut.tab.uiId)"
        >
          <IconTerminal v-if="ut.tab.isShell" class="term-tab-agent" />
          <component v-else :is="agentIcons[ut.tab.agent]" class="term-tab-agent" :class="ut.tab.agent" />
          <span class="term-tab-title">{{ shortTitle(ut.tab.title) }}</span>
          <span
            v-if="!ut.tab.isShell && statusKind(ut.tab) === 'working'"
            class="term-tab-status term-tab-status-working"
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>
          <span
            v-else-if="!ut.tab.isShell && statusKind(ut.tab) !== 'none'"
            class="term-tab-status"
            :class="'term-tab-status-' + statusKind(ut.tab)"
            aria-hidden="true"
          />
          <span
            class="term-tab-close"
            v-tooltip:bottom="t('chat.tui.tabClose')"
            role="button"
            tabindex="0"
            @click="onClose(ut.tab.uiId, $event)"
            @keydown.enter.prevent="onClose(ut.tab.uiId, $event)"
          >
            <IconClose />
          </span>
        </div>

        <!-- Saved (lazy-restore) tab -->
        <div
          v-else-if="ut.kind === 'saved'"
          class="term-tab term-tab-saved"
          v-tooltip:bottom="ut.saved.title"
          role="button"
          tabindex="0"
          @click="onSavedClick(ut.saved)"
          @contextmenu="onSavedContextMenu(ut.saved, $event)"
        >
          <IconTerminal v-if="ut.saved.isShell" class="term-tab-agent" />
          <component v-else :is="agentIcons[ut.saved.agent]" class="term-tab-agent" :class="ut.saved.agent" />
          <span class="term-tab-title">{{ shortTitle(ut.saved.title) }}</span>
          <span
            class="term-tab-close"
            v-tooltip:bottom="t('chat.tui.tabClose')"
            role="button"
            tabindex="0"
            @click="onSavedClose(ut.saved, $event)"
            @keydown.enter.prevent="onSavedClose(ut.saved, $event)"
          >
            <IconClose />
          </span>
        </div>

        <!-- View (read/chat) tab -->
        <div
          v-else
          class="term-tab view-tab view-tab-closable"
          :class="{ active: activeUiId === null && activeViewTabId === ut.vt.uiId }"
          v-tooltip:bottom="ut.vt.title || (ut.vt.type === 'chat' ? t('chat.tui.chatTab') : t('chat.tui.viewTab'))"
          role="button"
          tabindex="0"
          @click="onViewTabClick(ut.vt.uiId)"
          @contextmenu="onViewTabContextMenu(ut.vt, $event)"
          @keydown.enter.prevent="onViewTabClick(ut.vt.uiId)"
          @keydown.space.prevent="onViewTabClick(ut.vt.uiId)"
        >
          <component :is="ut.vt.type === 'chat' ? IconChat : IconReader" class="term-tab-agent" />
          <span class="term-tab-title">{{ ut.vt.title ? shortTitle(ut.vt.title) : (ut.vt.type === 'chat' ? t('chat.tui.chatTab') : t('chat.tui.viewTab')) }}</span>
          <span
            class="term-tab-close"
            v-tooltip:bottom="t('chat.tui.tabClose')"
            role="button"
            tabindex="0"
            @click="onViewTabClose(ut.vt.uiId, $event)"
            @keydown.enter.prevent="onViewTabClose(ut.vt.uiId, $event)"
          >
            <IconClose />
          </span>
        </div>
      </template>
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
        <span>{{ t(tabCtx?.tab?.isShell ? 'chat.tui.tabCloseOthers' : 'chat.tui.tabCloseOthersSession') }}</span>
      </button>
      <button
        type="button"
        class="ctx-item danger"
        data-menu-action="tab-close-project"
        @click="closeProjectCtxTabs"
      >
        <span>{{ t(tabCtx?.tab?.isShell ? 'chat.tui.tabCloseProject' : 'chat.tui.tabCloseProjectSession') }}</span>
      </button>
      <div class="ctx-sep" />
      <button type="button" class="ctx-item" @click="closeTabCtx(); tabCtx && emit('closeOthersAll', tabCtx.tab.uiId, 'tui')">
        <span>{{ t('chat.tui.tabCloseOthersAll') }}</span>
      </button>
      <button type="button" class="ctx-item danger" @click="closeTabCtx(); emit('closeAll')">
        <span>{{ t('chat.tui.tabCloseAll') }}</span>
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
      <div class="ctx-sep" />
      <button type="button" class="ctx-item danger" @click="closeTabCtx(); emit('closeAll')">
        <span>{{ t('chat.tui.tabCloseAll') }}</span>
      </button>
    </div>

    <!-- View tab 右键菜单 (fallback) -->
    <div
      v-if="viewTabCtx"
      class="ctx-menu term-tab-ctx-menu"
      :style="{ left: viewTabCtx.x + 'px', top: viewTabCtx.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <button type="button" class="ctx-item" @click="closeViewTabCtx(); emit('viewRename', viewTabCtx!.vt)">
        <span>{{ t('chat.tui.tabRenameView') }}</span>
      </button>
      <div class="ctx-sep" />
      <button type="button" class="ctx-item" @click="closeViewTabCtx(); emit('viewClose', viewTabCtx!.vt.uiId)">
        <span>{{ t('chat.tui.tabClose') }}</span>
      </button>
      <button type="button" class="ctx-item" @click="closeViewTabCtx(); emit('viewCloseOthers', viewTabCtx!.vt)">
        <span>{{ t('chat.tui.tabCloseOthersView', { type: viewTabCtx!.typeLabel }) }}</span>
      </button>
      <button type="button" class="ctx-item danger" @click="closeViewTabCtx(); emit('viewCloseProject', viewTabCtx!.vt.type)">
        <span>{{ t('chat.tui.tabCloseProjectView', { type: viewTabCtx!.typeLabel }) }}</span>
      </button>
      <div class="ctx-sep" />
      <button type="button" class="ctx-item" @click="const vt = viewTabCtx!.vt; closeViewTabCtx(); emit('closeOthersAll', vt.uiId, 'view')">
        <span>{{ t('chat.tui.tabCloseOthersAll') }}</span>
      </button>
      <button type="button" class="ctx-item danger" @click="closeViewTabCtx(); emit('closeAll')">
        <span>{{ t('chat.tui.tabCloseAll') }}</span>
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
