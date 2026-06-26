<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { Agent, ProjectInfo, SessionMeta, TrashItem, Msg } from './types'
import * as api from './api'
import { shortName } from './format'
import { t } from './i18n'
import {
  clearAppCache,
  codexShowArchivedSessions,
  codexShowInternalSessions,
  lang,
  setLang,
  setTheme,
  theme,
  useExternalTerminal,
  launchArgs,
  terminalApp,
  applyTerminalDefault,
  visibleAgents,
} from './settings'
import { focusSearchBox, navigate as chatNavigate, resetChatToolbar } from './chatToolbar'
import { emitMenuSync, installMenuRouter, type MenuHandlers } from './menu'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { resetTrashToolbar, exitSelectMode, selectedTrash } from './trashToolbar'
import {
  resetSessionsToolbar,
  sessionsFilterActive,
  selectedSessions,
  exitSessionSelectMode,
} from './sessionsToolbar'
import {
  exportMarkdown,
  exportHtml,
  exportJson,
  exportMarkdownToDir,
  exportHtmlToDir,
  exportJsonToDir,
  pickExportDir,
  batchExportFolderName,
  type ExportKind,
} from './export'
import { fly } from './fly'
import { recordRecent } from './recents'
import { recordExport, type ExportRecord } from './exportHistory'
import { globalSearchOpen, openGlobalSearch } from './globalSearch'
import { runBackgroundCheck } from './updateCheck'
import type { SearchHit } from './types'
import ChatView from './views/ChatView.vue'
import SettingsModal from './components/SettingsModal.vue'
import { IconSearch } from './components/icons'
import WindowsTitlebar, { type WindowMenuGroup } from './components/WindowsTitlebar.vue'
import ChatTopbar from './components/topbar/ChatTopbar.vue'
import TrashTopbar from './components/topbar/TrashTopbar.vue'
import SessionsTopbar from './components/topbar/SessionsTopbar.vue'
import TrashView from './views/TrashView.vue'
import SessionsView from './views/SessionsView.vue'
import WelcomeView from './views/WelcomeView.vue'
import StatsView from './views/StatsView.vue'
import Sidebar from './components/Sidebar.vue'
import SidebarTopbar from './components/SidebarTopbar.vue'
import TerminalStrip from './components/TerminalStrip.vue'
import TerminalPaneSlot from './components/TerminalPaneSlot.vue'
import ConfirmModal from './modals/ConfirmModal.vue'
import RenameModal from './modals/RenameModal.vue'
import GlobalSearchModal from './modals/GlobalSearchModal.vue'
import ExportHistoryView from './views/ExportHistoryView.vue'
import PricingView from './views/PricingView.vue'
import ProjectContextMenu from './modals/ProjectContextMenu.vue'
import {
  clearPendingLiveNotification,
  enqueueLiveNotification,
} from './liveNotifications'
import {
  activeUiId,
  openOrFocusTui,
  openShellTab,
  setActive as setActiveTui,
  activeTab as currentActiveTab,
  closeTab,
  closeTabsByProject,
  closeTabBySessionPath,
  reconcileNewTabs,
  syncTabTitlesFromSessions,
  syncTabTitleBySessionPath,
  setTabTitleByUiId,
  isTabProcessAlive,
  markTabSessionActivity,
  markTabTurnStarted,
  markTabTurnCompleted,
  markTabTurnBlocked,
  markTabTurnFailed,
  migrateTabsProjectKey,
  tabs as tuiTabs,
  persistTabState,
  loadSavedNav,
  savedTabs,
  removeSavedTab,
  clearAllTabs,
  type TerminalTab,
  type SavedTab,
} from './terminals'

// ---------- 状态 ----------
// 默认进首个可见 agent —— 用户若在设置里关掉了 claude，启动时就不该停在隐藏的 agent 上。
const agent = ref<Agent>(visibleAgents.value[0] ?? 'claude')
const projects = ref<ProjectInfo[]>([])
const activeDir = ref<string | null>(null)
const showTrash = ref(false)
const showStats = ref(false)
const showExportHistory = ref(false)
const showPricing = ref(false)
const showSettings = ref(false)
const settingsTab = ref<'general' | 'advanced' | 'shortcuts'>('general')
const sidebarOpen = ref(true)
const refreshing = ref(false)
const isWindows = /Win/i.test(navigator.platform)
function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

const SIDEBAR_WIDTH_KEY = 'sidebarWidth:v1'
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420

function clampSidebarWidth(width: number): number {
  const viewportMax = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 360)
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH, viewportMax))
}

function loadSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return clampSidebarWidth(Number.isFinite(raw) && raw > 0 ? raw : 248)
}

const sidebarWidth = ref(loadSidebarWidth())
const sidebarResizing = ref(false)
const appStyle = computed<Record<string, string>>(() => ({
  '--sidebar-w': `${sidebarWidth.value}px`,
}))
let sidebarResizeStartX = 0
let sidebarResizeStartWidth = 0

function onSidebarResizePointerDown(e: PointerEvent) {
  e.preventDefault()
  sidebarResizing.value = true
  sidebarResizeStartX = e.clientX
  sidebarResizeStartWidth = sidebarWidth.value
  document.body.classList.add('is-sidebar-resizing')
  window.addEventListener('pointermove', onSidebarResizePointerMove)
  window.addEventListener('pointerup', onSidebarResizePointerUp, { once: true })
  window.addEventListener('pointercancel', onSidebarResizePointerUp, { once: true })
}

function onSidebarResizePointerMove(e: PointerEvent) {
  if (!sidebarResizing.value) return
  sidebarWidth.value = clampSidebarWidth(
    sidebarResizeStartWidth + e.clientX - sidebarResizeStartX,
  )
}

function onSidebarResizePointerUp() {
  if (!sidebarResizing.value) return
  sidebarResizing.value = false
  document.body.classList.remove('is-sidebar-resizing')
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
  window.removeEventListener('pointermove', onSidebarResizePointerMove)
  window.removeEventListener('pointerup', onSidebarResizePointerUp)
  window.removeEventListener('pointercancel', onSidebarResizePointerUp)
}

function onWindowResize() {
  sidebarWidth.value = clampSidebarWidth(sidebarWidth.value)
}

const codexSessionOptions = computed(() => ({
  includeCodexInternal: codexShowInternalSessions.value,
  includeCodexArchived: codexShowArchivedSessions.value,
}))

function sessionListOptions() {
  return agent.value === 'codex' ? codexSessionOptions.value : undefined
}

/** 顶栏刷新：重新拉取项目 + 当前列表 + 当前打开的对话，全部静默，不动选中与滚动。 */
async function refreshAll() {
  if (refreshing.value) return
  refreshing.value = true
  const tasks: Promise<unknown>[] = []

  // 1. 项目列表（保留 activeDir）
  tasks.push(
    api.listProjects(agent.value, sessionListOptions()).then((p) => {
      projects.value = p
    }).catch(() => {}),
  )

  // 2. 当前列表（项目会话 or 回收站）
  if (showTrash.value) {
    tasks.push(
      api.listTrash().then((t) => {
        trash.value = t
      }).catch(() => {}),
    )
  } else if (activeDir.value) {
    const keepScroll = listScrollEl.value?.scrollTop ?? savedListScroll
    // 保留当前已加载数量，避免分页回退
    const n = Math.max(sessions.value.length, PAGE_SIZE)
    tasks.push(
      api
        .listSessions(agent.value, activeDir.value, 0, n, sessionListOptions())
        .then((page) => {
          sessions.value = page.sessions
          sessionTotal.value = page.total
          nextTick(() => {
            if (listScrollEl.value) listScrollEl.value.scrollTop = keepScroll
          })
        })
        .catch(() => {}),
    )
  }

  // 3. 当前打开的对话（如有）—— 静默替换 messages
  if (openSession.value) {
    tasks.push(
      api
        .readSession(agent.value, openSession.value.path)
        .then((msgs) => {
          chatMsgs.value = msgs
        })
        .catch(() => {}),
    )
  }

  try {
    await Promise.all(tasks)
  } finally {
    refreshing.value = false
  }
}
const sessions = shallowRef<SessionMeta[]>([])
const sessionTotal = ref(0)
const loadingMore = ref(false)
const trash = shallowRef<TrashItem[]>([])
const loadingList = ref(false)

const PAGE_SIZE = 40

const openSession = ref<SessionMeta | null>(null)
// 非空表示当前打开的会话来自回收站（只读查看）—— 详情页据此切换为「回收站模式」。
const openTrashItem = ref<TrashItem | null>(null)
const chatMsgs = shallowRef<Msg[]>([])
const loadingChat = ref(false)
// "● Live" 徽章：仅当会话**确实正在被写入**时为 true。
//   - 打开时 mtime 距今 < FRESH_MS → 视作"刚才还在跑"，先亮起来
//   - 收到 session:append 事件 → 文件真的有新增 → 亮起 / 续命
//   - 安静 STALE_MS 后自动熄灭 —— CLI 进程通常已结束
// 这与"是否在后端追这个文件"分离：watcher 对所有非回收站会话都开，
// 否则用户从终端 resume 一个老会话时我们就漏掉了。
const liveTailing = ref(false)
// "Live"判定阈值，单位 ms
const LIVE_FRESH_MS = 3 * 60 * 1000 // 打开时：3 分钟内动过 → 算 live
const LIVE_STALE_MS = 2 * 60 * 1000 // append 后：2 分钟内没新动静 → 熄灭
let liveFadeTimer = 0
function markLive() {
  liveTailing.value = true
  window.clearTimeout(liveFadeTimer)
  liveFadeTimer = window.setTimeout(() => {
    liveTailing.value = false
  }, LIVE_STALE_MS)
}
function clearLive() {
  liveTailing.value = false
  window.clearTimeout(liveFadeTimer)
  liveFadeTimer = 0
}

// 单会话统计目标。非空 → StatsView 切换到 session 模式，scope 锁定到这条 JSONL。
// 与 showStats=true 联用：全局统计时此值为 null，会话统计时填上 {agent, path, title}。
const sessionStatsTarget = ref<{ agent: Agent; path: string; title?: string } | null>(null)
// 单会话统计是从哪进入的：决定「返回」按钮往哪走。
//   'chat'   ← ChatTopbar 的统计按钮（关闭 → 回到原聊天）
//   'global' ← 全局 StatsView Top Sessions 行点击（关闭 → 回到全局 StatsView）
const sessionStatsFrom = ref<'chat' | 'global' | null>(null)

const sessionsViewRef = ref<InstanceType<typeof SessionsView> | null>(null)
const chatViewRef = ref<InstanceType<typeof ChatView> | null>(null)
const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null)
const listScrollEl = computed<HTMLElement | undefined>(
  () => sessionsViewRef.value?.scrollEl,
)
let savedListScroll = 0
const TUI_TITLE_SYNC_INTERVAL_MS = 4000
let tuiTitleSyncTimer = 0
let syncingTuiTitles = false

watch(openSession, (val, old) => {
  // 切换 / 关闭会话时把聊天页顶栏（搜索 / 折叠 / 等）状态归零，
  // 否则前一个会话的搜索词 / 折叠态会留到下一个，体验古怪。
  if (val?.path !== old?.path) resetChatToolbar()
  // 关闭会话即退出回收站模式 —— openTrashItem 永远不残留到下一次打开。
  if (!val) openTrashItem.value = null
  // 切到别的会话 / 关闭会话 → 立刻让后端停掉旧 watcher。
  // openChat 里会再起新的；openTrashSession / null 都不需要 watcher。
  if (val?.path !== old?.path) {
    clearLive()
    clearPendingLiveNotification()
    api.unwatchSession().catch(() => {})
  }
  if (!val && old) {
    nextTick(() => {
      if (listScrollEl.value) listScrollEl.value.scrollTop = savedListScroll
    })
  }
})

const activeProject = computed(() =>
  projects.value.find((p) => p.dirName === activeDir.value),
)
const activeAgentLabel = computed(() =>
  agent.value === 'codex' ? 'Codex' : agent.value === 'gemini' ? 'Gemini' : 'Claude',
)
const topbarContextTitle = computed(() => {
  if (showStats.value) return t('sidebar.stats')
  if (showTrash.value) return t('sidebar.trash')
  if (showExportHistory.value) return t('sidebar.history')
  if (showPricing.value) return t('sidebar.pricing')
  return activeProject.value ? shortName(activeProject.value.displayPath) : activeAgentLabel.value
})
const topbarContextMeta = computed(() => {
  if (showStats.value || showTrash.value || showExportHistory.value || showPricing.value) {
    return activeAgentLabel.value
  }
  if (openSession.value) return t('chat.tui.viewTab')
  if (activeProject.value) return t('chat.tui.listTab')
  return ''
})
// 从「导出历史」列表打开会话时所属的 agent —— 可能与侧栏当前 agent 不同，
// 且不该切换整个侧栏。打开普通 / 回收站会话时清空。
const importedAgent = ref<Agent | null>(null)
// 详情页用的 agent：回收站会话用条目自己的 agent；导出历史会话用记录自带的 agent；
// 否则跟随侧栏当前 agent。三者可能彼此不同，优先级：回收站 > 导出历史 > 侧栏。
const chatAgent = computed<Agent>(
  () => openTrashItem.value?.agent ?? importedAgent.value ?? agent.value,
)

// ChatView 用来 spawn 内嵌 TUI 的 cwd。优先用会话自带的 cwd（Codex / Gemini 可靠），
// 退到当前激活项目的 displayPath（Claude 的项目就是路径）。回收站模式不需要 —— TerminalPane
// 仅在 !trashed 且 cwd 非空时挂载。
const chatCwd = computed<string>(() => {
  if (openTrashItem.value) return ''
  return openSession.value?.cwd || activeProject.value?.displayPath || ''
})

// ---------- 项目置顶 / 沉底偏好（持久化到 localStorage）----------
type ProjState = 'pinned' | 'sunk'
const PREFS_KEY = 'projPrefs:v1'

function loadPrefs(): Record<string, ProjState> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
  } catch {
    return {}
  }
}
const projPrefs = ref<Record<string, ProjState>>(loadPrefs())

function prefKey(p: ProjectInfo): string {
  return `${agent.value}::${p.dirName}`
}
function projStateOf(p: ProjectInfo): ProjState | undefined {
  return projPrefs.value[prefKey(p)]
}
function setProjState(p: ProjectInfo, state: ProjState) {
  const key = prefKey(p)
  if (projPrefs.value[key] === state) {
    delete projPrefs.value[key]
  } else {
    projPrefs.value[key] = state
  }
  projPrefs.value = { ...projPrefs.value }
  localStorage.setItem(PREFS_KEY, JSON.stringify(projPrefs.value))
}

// "缓存"目前只有置顶/沉底偏好这一项，字节数等于其 JSON 序列化后的 UTF-8 长度。
const cacheBytes = computed(() => {
  const json = JSON.stringify(projPrefs.value)
  if (json === '{}') return 0
  return new TextEncoder().encode(json).length
})

// ---------- 项目右键菜单 ----------
interface CtxMenu {
  x: number
  y: number
  project: ProjectInfo
}
const ctxMenu = ref<CtxMenu | null>(null)
function openCtxMenu(e: MouseEvent, p: ProjectInfo) {
  e.preventDefault()
  // 菜单大约 168×180，靠近视口右/下边时收回来一点，避免被截掉
  const W = 176
  const H = 180
  const x = Math.min(e.clientX, window.innerWidth - W - 8)
  const y = Math.min(e.clientY, window.innerHeight - H - 8)
  ctxMenu.value = { x, y, project: p }
}
function closeCtxMenu() {
  ctxMenu.value = null
}
function ctxToggleState(state: ProjState) {
  if (!ctxMenu.value) return
  setProjState(ctxMenu.value.project, state)
  closeCtxMenu()
}
function ctxRefresh() {
  closeCtxMenu()
  refreshAll()
}
function ctxDeleteProject() {
  const p = ctxMenu.value?.project
  closeCtxMenu()
  if (!p) return
  deleteProject(p)
}
function ctxRemoveBookmark() {
  const p = ctxMenu.value?.project
  closeCtxMenu()
  if (!p) return
  removeBookmark(p)
}

// 删除当前打开的项目 —— SessionsView 顶部操作区的删除按钮。
function deleteActiveProject() {
  if (activeProject.value) deleteProject(activeProject.value)
}

function deleteProject(p: ProjectInfo) {
  ask({
    title: t('dialog.deleteProject.title'),
    message: t('dialog.deleteProject.body', {
      name: shortName(p.displayPath),
      n: p.sessionCount,
    }),
    okText: t('dialog.deleteProject.ok'),
    danger: true,
    onOk: async () => {
      // 在该项目从侧边栏移除前抓取起点，触发飞向回收站的弧线动画
      const srcRect = projectSourceRect(p)
      try {
        // 先刷新项目列表：TUI 运行期间 CLI 可能已在 ~/.claude/projects/ 下
        // 创建了真实项目目录，但此前的 projects.value 还没有它。刷新后
        // counterpart 才能发现真实项目，确保其会话也被一并删除。
        await loadProjects()
        // 书签和真实项目（~/.claude/projects/ 下同 displayPath 的目录）可能同时存在，
        // 且会话只存在于真实项目目录里。两边都要扫、都要删才能彻底清除。
        const counterpart = projects.value.find(
          (rp) => rp.dirName !== p.dirName && rp.displayPath === p.displayPath,
        )
        const keysToScan = [p.dirName]
        if (counterpart) keysToScan.push(counterpart.dirName)

        // 先杀 PTY，再移文件——否则 CLI 进程检测到文件消失会重建空会话。
        closeTabsByProject(p.dirName)
        if (counterpart) closeTabsByProject(counterpart.dirName)

        const all: SessionMeta[] = []
        for (const key of keysToScan) {
          let offset = 0
          while (true) {
            const page = await api.listSessions(agent.value, key, offset, 200, sessionListOptions())
            all.push(...page.sessions)
            offset += page.sessions.length
            if (all.length >= page.total || page.sessions.length === 0) break
          }
        }
        for (const s of all) {
          try {
            await api.softDeleteSession(agent.value, s.path, p.displayPath)
          } catch {}
        }
        // 始终尝试移除书签：书签可能已被 loadProjects 合并进真实项目，
        // counterpart 在当前列表里找不到。removeBookmark 是幂等的，不存在也不会报错。
        await api.removeBookmark(agent.value, p.displayPath)
        fly({
          from: srcRect,
          to: document.querySelector<HTMLElement>('.topbar-trash-btn'),
          variant: 'trash',
        })
        if (activeDir.value === p.dirName || activeDir.value === counterpart?.dirName) {
          activeDir.value = null
          sessions.value = []
          openSession.value = null
        }
        await loadProjects()
        // 批量删除后刷新回收站，保持顶栏红点准确
        api.listTrash().then((items) => { trash.value = items }).catch(() => {})
        notify(t('toast.projDeleted'))
      } catch (e) {
        notify(t('toast.deleteFail', { e: String(e) }), true)
      }
    },
  })
}

function batchDeleteProjects(dirs: string[]) {
  if (!dirs.length) return
  const totalSessions = dirs.reduce((sum, dir) => {
    const p = projects.value.find(pp => pp.dirName === dir)
    return sum + (p?.sessionCount ?? 0)
  }, 0)
  ask({
    title: t('dialog.batchDeleteProject.title'),
    message: t('dialog.batchDeleteProject.body', { n: dirs.length, sessions: totalSessions }),
    okText: t('dialog.batchDeleteProject.ok'),
    danger: true,
    onOk: async () => {
      try {
        await loadProjects()
        for (const dir of dirs) {
          const p = projects.value.find(pp => pp.dirName === dir)
          if (!p) continue
          const counterpart = projects.value.find(
            (rp) => rp.dirName !== p.dirName && rp.displayPath === p.displayPath,
          )
          closeTabsByProject(p.dirName)
          if (counterpart) closeTabsByProject(counterpart.dirName)

          const all: SessionMeta[] = []
          const keysToScan = [p.dirName]
          if (counterpart) keysToScan.push(counterpart.dirName)
          for (const key of keysToScan) {
            let offset = 0
            while (true) {
              const page = await api.listSessions(agent.value, key, offset, 200, sessionListOptions())
              all.push(...page.sessions)
              offset += page.sessions.length
              if (all.length >= page.total || page.sessions.length === 0) break
            }
          }
          for (const s of all) {
            try {
              if (openSession.value?.path === s.path) {
                openSession.value = null
                clearLive()
              }
              await api.softDeleteSession(agent.value, s.path, p.displayPath)
            } catch {}
          }
          await api.removeBookmark(agent.value, p.displayPath)
        }
        if (activeDir.value && dirs.includes(activeDir.value)) {
          activeDir.value = null
          sessions.value = []
          openSession.value = null
        }
        sidebarRef.value?.exitSelect()
        await loadProjects()
        api.listTrash().then((items) => { trash.value = items }).catch(() => {})
        notify(t('toast.batchProjDeleted', { n: dirs.length }))
      } catch (e) {
        notify(t('toast.deleteFail', { e: String(e) }), true)
      }
    },
  })
}

// ---------- 确认弹窗 ----------
interface ConfirmState {
  show: boolean
  title: string
  message: string
  okText: string
  danger: boolean
  onOk: () => void
  altText?: string
  onAlt?: () => void
}
const confirm = ref<ConfirmState>({
  show: false,
  title: '',
  message: '',
  okText: '',
  danger: false,
  onOk: () => {},
})
function ask(opts: Partial<ConfirmState> & { onOk: () => void }) {
  confirm.value = {
    show: true,
    title: opts.title ?? t('common.confirm'),
    message: opts.message ?? '',
    okText: opts.okText ?? t('common.ok'),
    danger: opts.danger ?? false,
    onOk: opts.onOk,
    altText: opts.altText,
    onAlt: opts.onAlt,
  }
}
function runConfirm() {
  const fn = confirm.value.onOk
  confirm.value.show = false
  fn()
}

function runAlt() {
  const fn = confirm.value.onAlt
  confirm.value.show = false
  fn?.()
}

// ---------- 重命名会话 ----------
// 等价于 Claude Code 的 `/rename` —— 后端往原 JSONL 末尾追加官方 schema 的
// 元数据行（Claude 是 custom-title，Codex 是 event_msg.thread_name_updated），
// 不动用户对话内容，CLI 端再次读取这个会话时也会看到新名字。
interface RenameState {
  show: boolean
  agent: Agent
  path: string
  id: string
  value: string
  defaultTitle: string
  /** shell tab 重命名不走后端，直接改内存中的 tab title。 */
  shellTabUiId?: number
}
const renameModal = ref<RenameState>({
  show: false,
  agent: 'claude',
  path: '',
  id: '',
  value: '',
  defaultTitle: '',
})
const renaming = ref(false)
function openRename(s: SessionMeta) {
  renameModal.value = {
    show: true,
    agent: agent.value,
    path: s.path,
    id: s.id,
    value: s.title,
    defaultTitle: s.title,
  }
}

function openRenameState(a: Agent, path: string, id: string, title: string) {
  renameModal.value = {
    show: true,
    agent: a,
    path,
    id,
    value: title,
    defaultTitle: title,
  }
}

async function confirmRename() {
  const m = renameModal.value
  if (!m.show || renaming.value) return
  const name = m.value.trim()
  if (!name || name === m.defaultTitle) {
    m.show = false
    return
  }
  if (m.shellTabUiId != null) {
    setTabTitleByUiId(m.shellTabUiId, name)
    m.show = false
    notify(t('toast.renamed'))
    saveTabState()
    return
  }
  renaming.value = true
  try {
    await api.renameSession(m.agent, m.path, name)
    const patch = (s: SessionMeta) =>
      s.path === m.path ? { ...s, title: name } : s
    sessions.value = sessions.value.map(patch)
    if (openSession.value?.path === m.path) {
      openSession.value = { ...openSession.value, title: name }
    }
    syncTabTitleBySessionPath(m.agent, m.path, name)
    m.show = false
    notify(t('toast.renamed'))
    saveTabState()
  } catch (e) {
    notify(t('toast.renameFail', { e: String(e) }), true)
  } finally {
    renaming.value = false
  }
}

// ---------- toast ----------
const toast = ref({ show: false, msg: '', error: false })
let toastTimer: number | undefined
function notify(msg: string, error = false) {
  toast.value = { show: true, msg, error }
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value.show = false), 2600)
}

// ---------- 数据加载 ----------
async function loadProjects() {
  try {
    projects.value = await api.listProjects(agent.value, sessionListOptions())
  } catch (e) {
    notify(t('toast.loadProjectsFail', { e: String(e) }), true)
    projects.value = []
  }
  // 书签被后端合并进真实项目时（display_path 一致 → 书签条目被跳过），
  // activeDir 仍指向旧的 "bookmark:..." key，导致 refreshSessions 查错目录。
  // 这里检测到书签消失后自动重定向到真实项目的 dirName。
  if (
    activeDir.value?.startsWith('bookmark:') &&
    !projects.value.some((p) => p.dirName === activeDir.value)
  ) {
    const bmPath = activeDir.value.slice('bookmark:'.length)
    const real = projects.value.find(
      (p) => !p.dirName.startsWith('bookmark:') && p.displayPath === bmPath,
    )
    if (real) {
      migrateTabsProjectKey(activeDir.value, real.dirName)
      activeDir.value = real.dirName
    }
  }
}

async function addBookmarkByPath(path: string) {
  // 先刷新项目列表，避免用 stale 的列表做重复判断
  await loadProjects()
  const existing = projects.value.find(p => p.displayPath === path)
  if (existing) {
    // 已有同路径项目 → 不重复添加，直接选中它
    selectProject(existing.dirName)
    notify(t('toast.bookmarkExists'))
    return
  }
  try {
    await api.addBookmark(agent.value, path)
    await loadProjects()
    notify(t('toast.bookmarkAdded'))
    const added = projects.value.find(p => p.displayPath === path)
    if (added) {
      selectProject(added.dirName)
      nextTick(() => {
        const el = document.querySelector<HTMLElement>(`.proj-item.active`)
        if (el) {
          el.classList.add('flash')
          el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true })
        }
      })
    }
  } catch (e) {
    notify(`${e}`, true)
  }
}

async function addBookmark() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false })
  if (!selected) return
  const path = typeof selected === 'string' ? selected : selected[0]
  if (!path) return
  await addBookmarkByPath(path)
}


async function removeBookmark(p: ProjectInfo) {
  try {
    await api.removeBookmark(agent.value, p.displayPath)
    await loadProjects()
    notify(t('toast.bookmarkRemoved'))
  } catch (e) {
    notify(`${e}`, true)
  }
}

// 用户在设置里关掉了当前所处的 agent → 自动切到第一个仍可见的 agent，
// 否则界面会停在一个已隐藏、且切换栏里再也点不到的 agent 上。
watch(visibleAgents, (list) => {
  if (!list.includes(agent.value)) switchAgent(list[0])
})

function switchAgent(a: Agent) {
  if (agent.value === a) return
  agent.value = a
  activeDir.value = null
  sessions.value = []
  openSession.value = null
  showTrash.value = false
  showExportHistory.value = false
  showPricing.value = false
  // 任何主区视图切换 → 把 TUI 层收起，让用户看到刚切到的视图。TUI tab 不关，
  // 用户在 TerminalStrip 里随时能切回。
  setActiveTui(null)
  // showStats 不重置 —— 统计是 agent-scoped，切 agent 后 StatsView 自己 refetch。
  loadProjects()
}

async function selectProject(dir: string) {
  // 任何点项目 / 切项目的动作都先把 TUI 层收起，否则用户点了项目却看不到列表。
  setActiveTui(null)
  // 再次点击当前已选中的项目：
  //   - 若右侧是会话详情 → 关闭详情，回到会话列表（不收起项目）
  //   - 若右侧已是会话列表 → 收起项目，回到「请选择项目」空状态
  if (activeDir.value === dir && !showTrash.value && !showStats.value) {
    if (openSession.value) {
      openSession.value = null
      return
    }
    activeDir.value = null
    sessions.value = []
    sessionTotal.value = 0
    resetSessionsToolbar()
    return
  }
  showTrash.value = false
  showStats.value = false
  showExportHistory.value = false
  showPricing.value = false
  sessionStatsTarget.value = null
  activeDir.value = dir
  recordRecent(agent.value, dir)
  openSession.value = null
  sessions.value = []
  sessionTotal.value = 0
  savedListScroll = 0
  resetSessionsToolbar()
  loadingList.value = true
  try {
    const page = await api.listSessions(agent.value, dir, 0, PAGE_SIZE, sessionListOptions())
    sessions.value = page.sessions
    sessionTotal.value = page.total
  } catch (e) {
    notify(t('toast.loadSessionsFail', { e: String(e) }), true)
    sessions.value = []
  } finally {
    loadingList.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || loadingList.value || !activeDir.value) return
  if (sessions.value.length >= sessionTotal.value) return
  loadingMore.value = true
  try {
    const page = await api.listSessions(
      agent.value,
      activeDir.value,
      sessions.value.length,
      PAGE_SIZE,
      sessionListOptions(),
    )
    sessions.value = [...sessions.value, ...page.sessions]
    sessionTotal.value = page.total
  } catch (e) {
    notify(t('toast.loadMoreFail', { e: String(e) }), true)
  } finally {
    loadingMore.value = false
  }
}

function onListScroll(scrollTop: number) {
  savedListScroll = scrollTop
}

// 一次性把当前项目剩余的会话全部拉进来。分页窗口只覆盖已滚动到的部分，
// 而搜索 / 排序需要面向整个项目才正确，故工具栏一旦被激活就补齐全量。
async function loadAllSessions() {
  if (!activeDir.value || loadingList.value || loadingMore.value) return
  if (sessions.value.length >= sessionTotal.value) return
  loadingMore.value = true
  try {
    const page = await api.listSessions(
      agent.value,
      activeDir.value,
      0,
      sessionTotal.value,
      sessionListOptions(),
    )
    sessions.value = page.sessions
    sessionTotal.value = page.total
    syncTuiTabsFromCurrentSessions()
  } catch (e) {
    notify(t('toast.loadMoreFail', { e: String(e) }), true)
  } finally {
    loadingMore.value = false
  }
}

// 工具栏从默认态切到「有筛选」时补齐全量会话；清空筛选后已加载的全量列表保留即可。
watch(sessionsFilterActive, (active) => {
  if (active) loadAllSessions()
})

function syncTuiTabsFromCurrentSessions() {
  if (!activeDir.value) return
  reconcileNewTabs(activeDir.value, sessions.value, agent.value)
  syncTabTitlesFromSessions(agent.value, activeDir.value, sessions.value)
}

function hasCurrentProjectTuiTabs(): boolean {
  if (!activeDir.value || showTrash.value || showStats.value) return false
  return tuiTabs.value.some(
    (tab) =>
      tab.agent === agent.value &&
      tab.projectKey === activeDir.value &&
      isTabProcessAlive(tab),
  )
}

async function syncTuiTitlesNow() {
  if (!activeDir.value || syncingTuiTitles || !hasCurrentProjectTuiTabs()) return
  syncingTuiTitles = true
  try {
    const page = await api.listSessions(
      agent.value,
      activeDir.value,
      0,
      Math.max(PAGE_SIZE, sessions.value.length),
      sessionListOptions(),
    )
    sessions.value = page.sessions
    sessionTotal.value = page.total
    syncTuiTabsFromCurrentSessions()
  } catch {
    // 后台标题同步不能打扰正在运行的 TUI；用户手动刷新时会看到错误 toast。
  } finally {
    syncingTuiTitles = false
  }
}

async function refreshSessions() {
  if (!activeDir.value || loadingList.value) return
  loadingList.value = true
  try {
    const page = await api.listSessions(
      agent.value,
      activeDir.value,
      0,
      Math.max(PAGE_SIZE, sessions.value.length),
      sessionListOptions(),
    )
    sessions.value = page.sessions
    sessionTotal.value = page.total
    syncTuiTabsFromCurrentSessions()
  } catch (e) {
    notify(t('toast.loadSessionsFail', { e: String(e) }), true)
  } finally {
    loadingList.value = false
  }
}

// 打开统计概览：和回收站 / 会话视图互斥；再点一次同一按钮收起。
// 数据加载自身在 StatsView 里完成，App 这一层只切顶层状态。
function openStats() {
  setActiveTui(null)
  if (showStats.value) {
    showStats.value = false
    sessionStatsTarget.value = null
    return
  }
  showStats.value = true
  // 全局统计模式：清掉单会话目标，避免上次留下来。
  sessionStatsTarget.value = null
  showTrash.value = false
  showExportHistory.value = false
  showPricing.value = false
  activeDir.value = null
  openSession.value = null
  sessions.value = []
  sessionTotal.value = 0
}

async function loadTrash() {
  setActiveTui(null)
  showTrash.value = true
  showStats.value = false
  showExportHistory.value = false
  showPricing.value = false
  sessionStatsTarget.value = null
  activeDir.value = null
  openSession.value = null
  resetTrashToolbar()
  loadingList.value = true
  try {
    trash.value = await api.listTrash()
  } catch (e) {
    notify(t('toast.loadTrashFail', { e: String(e) }), true)
    trash.value = []
  } finally {
    loadingList.value = false
  }
}

async function openChat(s: SessionMeta) {
  setActiveTui(null)
  loadingChat.value = true
  openTrashItem.value = null
  importedAgent.value = null
  openSession.value = s
  chatMsgs.value = []
  clearLive()
  try {
    chatMsgs.value = await api.readSession(agent.value, s.path)
    // 整文件读完再开 watcher。watch_session 内部会把当前 Msg 数记为 baseline，
    // 后续只 emit 新增；read 之前开则可能把整段当 append 推回来。
    // watcher 始终启用 —— 即使会话当前看似"完成"，用户也可能从终端 resume，
    // 那一刻文件会重新被写，append 事件会把 Live 徽章亮起来。
    try {
      await api.watchSession(agent.value, s.path)
      // mtime 是毫秒。session.modified 由 agent 模块写入，单位与 now_millis 一致。
      const ageMs = Date.now() - (s.modified ?? 0)
      if (ageMs >= 0 && ageMs < LIVE_FRESH_MS) {
        markLive()
      }
    } catch {
      // watcher 起不来：不显示 Live（也不抛错 —— 只是失去自动刷新而已）
    }
  } catch (e) {
    notify(t('toast.readFail', { e: String(e) }), true)
    openSession.value = null
  } finally {
    loadingChat.value = false
  }
  // ⚠️ 这里曾经会顺手拉一次 api.sessionUsage 给顶栏角标用。后端 session_usage
  // 会全文件再扫一次 JSONL，长会话下明显拖累聊天首屏 —— 已经移到独立的会话
  // 统计页面，由用户点 ChatTopbar 的「统计」按钮按需触发（流式推送）。
}

// 导出历史视图入口（侧栏按钮）—— 和回收站 / 统计 / 价格互斥；再点一次同一按钮收起。
function openExportHistory() {
  setActiveTui(null)
  if (showExportHistory.value) {
    showExportHistory.value = false
    return
  }
  showExportHistory.value = true
  showTrash.value = false
  showStats.value = false
  showPricing.value = false
  sessionStatsTarget.value = null
  activeDir.value = null
  openSession.value = null
  sessions.value = []
  sessionTotal.value = 0
}

// 价格视图入口（顶栏 More 菜单）—— 和回收站 / 统计 / 历史互斥；再点一次收起。
function openPricing() {
  setActiveTui(null)
  if (showPricing.value) {
    showPricing.value = false
    return
  }
  showPricing.value = true
  showTrash.value = false
  showStats.value = false
  showExportHistory.value = false
  sessionStatsTarget.value = null
  activeDir.value = null
  openSession.value = null
  sessions.value = []
  sessionTotal.value = 0
}

// 点开导出历史里的一条 —— 用平时查看会话的同一套逻辑（read_session）打开**原始**
// transcript，和落盘的导出文件无关。沿用回收站的跨 agent 打开机制：用 importedAgent
// 记录这条记录的 agent，不切换整个侧栏。原始文件已被移动 / 删除时后端抛错 —— 仅提示，
// 不自动删历史（可能只是临时不可达，让用户在列表里手动移除）。showExportHistory 保持
// true，关闭会话详情时自动回到历史列表（与回收站一致）。
async function openHistorySession(rec: ExportRecord) {
  setActiveTui(null)
  loadingChat.value = true
  openTrashItem.value = null
  importedAgent.value = rec.agent
  openSession.value = {
    id: rec.sessionId,
    fileName: shortName(rec.path),
    path: rec.path,
    title: rec.title,
    cwd: rec.cwd,
    modified: 0,
    size: 0,
    messageCount: 0,
    codexAppListScanned: 0,
    codexAppFirstPageSize: 0,
    codexAppFirstPagePosition: 0,
    codexInternal: false,
    codexArchived: false,
  }
  chatMsgs.value = []
  clearLive()
  try {
    chatMsgs.value = await api.readSession(rec.agent, rec.path)
  } catch (e) {
    notify(t('toast.readFail', { e: String(e) }), true)
    openSession.value = null
    importedAgent.value = null
  } finally {
    loadingChat.value = false
  }
}

// 会话统计入口：从 ChatTopbar 的统计按钮触发，跳到独立统计页面。
// 走和全局统计一样的 SSE 推送通道，主聊天页面保持轻量 —— 后端 scope 拼成
// `session:<agent>:<path>`，由 stats::stream::run_session_scope 单独处理。
function openSessionStats() {
  if (!openSession.value) return
  const sess = openSession.value
  sessionStatsTarget.value = {
    agent: chatAgent.value,
    path: sess.path,
    title: sess.title,
  }
  sessionStatsFrom.value = 'chat'
  showStats.value = true
  showTrash.value = false
  // 注意：不清空 openSession / activeDir —— 用户关闭统计页时回到原会话上下文。
}

// 从全局 StatsView 的 Top Sessions 列表跳进单会话统计。和上面的区别只在 "from"，
// 决定返回时回到全局统计而不是某个聊天。
function openSessionStatsFromGlobal(a: Agent, path: string, title?: string) {
  sessionStatsTarget.value = { agent: a, path, title }
  sessionStatsFrom.value = 'global'
  // showStats 保持 true —— 我们仍然在 StatsView 里，只是 props.session 变了，
  // StatsView 内部的 watch(props.session?.path) 会重启流。
}

function closeStats() {
  // 单会话模式下点「返回」：根据进入路径决定回到哪
  if (sessionStatsTarget.value) {
    if (sessionStatsFrom.value === 'global') {
      // 仍留在 StatsView，但切回全局视图
      sessionStatsTarget.value = null
      sessionStatsFrom.value = null
      return
    }
    // 'chat' / null：完整关闭，openSession 还在 → 自动回落到 ChatView
  }
  showStats.value = false
  sessionStatsTarget.value = null
  sessionStatsFrom.value = null
}

// 在回收站里打开一个已删除会话的只读详情。回收站 JSONL 仍是完整文件，
// 直接按 trashPath 解析即可；详情页通过 openTrashItem 进入「回收站模式」。
async function openTrashSession(item: TrashItem) {
  setActiveTui(null)
  loadingChat.value = true
  importedAgent.value = null
  openTrashItem.value = item
  openSession.value = {
    id: '',
    fileName: item.trashFile,
    path: item.trashPath,
    title: item.title,
    modified: item.deletedAt,
    size: item.size,
    messageCount: 0,
    codexAppListRank: null,
    codexAppListScanned: 0,
    codexAppFirstPageSize: 50,
    codexAppFirstPagePosition: 0,
    codexInternal: false,
    codexArchived: false,
  }
  chatMsgs.value = []
  try {
    chatMsgs.value = await api.readSession(item.agent, item.trashPath)
  } catch (e) {
    notify(t('toast.readFail', { e: String(e) }), true)
    openSession.value = null
  } finally {
    loadingChat.value = false
  }
}

// ---------- 删除 / 恢复 ----------
// 删除起点矩形：列表里取对应 .session-card，详情页取聊天顶栏的删除按钮。
function deleteSourceRect(s: SessionMeta): DOMRect | null {
  const cards = document.querySelectorAll<HTMLElement>('.session-card')
  for (const c of cards) {
    if (c.dataset.path === s.path) return c.getBoundingClientRect()
  }
  const chatDel = document.querySelector<HTMLElement>('.chat-head .icon-btn.danger')
  return chatDel ? chatDel.getBoundingClientRect() : null
}

// 删除项目起点矩形：侧边栏里该项目的行。
function projectSourceRect(p: ProjectInfo): DOMRect | null {
  for (const el of document.querySelectorAll<HTMLElement>('.proj-item')) {
    if (el.dataset.path === p.displayPath) return el.getBoundingClientRect()
  }
  return null
}

// 恢复起点矩形：回收站列表里对应的 .session-card（按 trashFile 匹配），
// 在回收站详情页里恢复时没有列表卡片，改用顶栏的恢复按钮作起点。
function restoreSourceRect(item: TrashItem): DOMRect | null {
  for (const c of document.querySelectorAll<HTMLElement>('.session-card')) {
    if (c.dataset.trash === item.trashFile) return c.getBoundingClientRect()
  }
  const headBtn = document.querySelector<HTMLElement>('.chat-head .chat-restore-btn')
  return headBtn ? headBtn.getBoundingClientRect() : null
}

// 恢复落点：侧边栏里该会话所属项目的行（trashFile 的 projectLabel == 项目 displayPath）；
// 项目此刻尚未出现在侧边栏时退回到整个项目列表容器。
function restoreTarget(item: TrashItem): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.proj-item')) {
    if (el.dataset.path === item.projectLabel) return el
  }
  return document.querySelector<HTMLElement>('.proj-list')
}

function deleteSession(s: SessionMeta) {
  const afterDelete = async () => {
    closeTabBySessionPath(s.path)
    sessions.value = sessions.value.filter((x) => x.path !== s.path)
    sessionTotal.value = Math.max(0, sessionTotal.value - 1)
    if (openSession.value?.path === s.path) openSession.value = null
    if (sessions.value.length === 0 && activeProject.value) {
      const proj = activeProject.value
      closeTabsByProject(proj.dirName)
      if (proj.bookmarked || proj.dirName.startsWith('bookmark:')) {
        await api.removeBookmark(agent.value, proj.displayPath)
      }
      activeDir.value = null
    }
    await loadProjects()
  }
  ask({
    title: t('dialog.delete.title'),
    message: t('dialog.delete.body', { title: s.title }),
    okText: t('dialog.delete.ok'),
    altText: t('dialog.delete.permOk'),
    onAlt: async () => {
      try {
        const fromChat = openSession.value?.path === s.path
        const a = fromChat ? chatAgent.value : agent.value
        const label = activeProject.value?.displayPath ?? s.cwd ?? ''
        closeTabBySessionPath(s.path)
        await api.softDeleteSession(a, s.path, label)
        const trashItems = await api.listTrash()
        const match = trashItems.find(item => item.originalPath === s.path)
        if (match) await api.permanentDeleteTrash(match.trashFile)
        await afterDelete()
        notify(t('toast.permDeleted'))
      } catch (e) {
        notify(t('toast.deleteFail', { e: String(e) }), true)
      }
    },
    onOk: async () => {
      // 在移除该行之前抓取起点，触发飞向回收站的弧线动画
      const srcRect = deleteSourceRect(s)
      // 从聊天页删除时，会话可能来自「导出历史」（跨 agent，且 activeProject 为空）——
      // 此时用会话自身的 agent / cwd，而不是侧栏当前 agent / 项目，否则回收站条目
      // 的归属项目会变成空（显示「—」）甚至 agent 标错。
      const fromChat = openSession.value?.path === s.path
      const a = fromChat ? chatAgent.value : agent.value
      const label = activeProject.value?.displayPath ?? s.cwd ?? ''
      try {
        closeTabBySessionPath(s.path)
        await api.softDeleteSession(a, s.path, label)
        fly({
          from: srcRect,
          to: document.querySelector<HTMLElement>('.topbar-trash-btn'),
          variant: 'trash',
        })
        await afterDelete()
        api.listTrash().then((items) => { trash.value = items }).catch(() => {})
        notify(t('toast.moved'))
      } catch (e) {
        notify(t('toast.deleteFail', { e: String(e) }), true)
      }
    },
  })
}

function restore(item: TrashItem) {
  ask({
    title: t('dialog.restore.title'),
    message: t('dialog.restore.body', { title: item.title }),
    okText: t('dialog.restore.ok'),
    onOk: async () => {
      // 在该行被移除前抓取起点与落点，触发飞回侧边栏项目列表的弧线动画
      const srcRect = restoreSourceRect(item)
      try {
        await api.restoreSession(item.trashFile)
        trash.value = trash.value.filter((x) => x.trashFile !== item.trashFile)
        if (openTrashItem.value?.trashFile === item.trashFile) {
          openSession.value = null
        }
        await loadProjects()
        await nextTick()
        const target = restoreTarget(item)
        fly({ from: srcRect, to: target, variant: 'restore' })
        notify(t('toast.restored'))
      } catch (e) {
        notify(t('toast.restoreFail', { e: String(e) }), true)
      }
    },
  })
}

function permanentDelete(item: TrashItem) {
  ask({
    title: t('dialog.perm.title'),
    message: t('dialog.perm.body', { title: item.title }),
    okText: t('dialog.perm.ok'),
    danger: true,
    onOk: async () => {
      try {
        await api.permanentDeleteTrash(item.trashFile)
        trash.value = trash.value.filter((x) => x.trashFile !== item.trashFile)
        notify(t('toast.permDeleted'))
      } catch (e) {
        notify(t('toast.deleteFail', { e: String(e) }), true)
      }
    },
  })
}

// 批量恢复：恢复 trashToolbar 里勾选的会话。失败项跳过，只从 trash 移除成功项。
function batchRestore() {
  const keys = new Set(selectedTrash.value)
  const items = trash.value.filter((x) => keys.has(x.trashFile))
  if (!items.length) return
  ask({
    title: t('dialog.batchRestore.title'),
    message: t('dialog.batchRestore.body', { n: items.length }),
    okText: t('dialog.batchRestore.ok'),
    onOk: async () => {
      const srcRect = restoreSourceRect(items[0])
      const restored = new Set<string>()
      const errors: string[] = []
      for (const it of items) {
        try {
          await api.restoreSession(it.trashFile)
          restored.add(it.trashFile)
        } catch (e) {
          errors.push(`${it.title}: ${e}`)
        }
      }
      trash.value = trash.value.filter((x) => !restored.has(x.trashFile))
      exitSelectMode()
      await loadProjects()
      if (restored.size) {
        await nextTick()
        const target = restoreTarget(items[0])
        fly({ from: srcRect, to: target, variant: 'restore' })
      }
      if (errors.length) {
        notify(errors.join('; '), true)
      } else {
        notify(t('toast.batchRestored', { n: restored.size }))
      }
    },
  })
}

function batchPermanentDelete() {
  const keys = new Set(selectedTrash.value)
  const items = trash.value.filter((x) => keys.has(x.trashFile))
  if (!items.length) return
  ask({
    title: t('dialog.batchPerm.title'),
    message: t('dialog.batchPerm.body', { n: items.length }),
    okText: t('dialog.batchPerm.ok'),
    danger: true,
    onOk: async () => {
      let count = 0
      for (const it of items) {
        try {
          await api.permanentDeleteTrash(it.trashFile)
          count++
        } catch { /* skip */ }
      }
      trash.value = trash.value.filter((x) => !keys.has(x.trashFile))
      exitSelectMode()
      notify(t('toast.batchPermDeleted', { n: count }))
    },
  })
}

// 批量删除：把会话列表里勾选的会话一并 soft-delete 进回收站。失败项跳过，
// 不重置滚动；单条删除的弧线动画在此处一并跳过（一次性 N 个抛物线太喧闹）。
function batchDeleteSessions() {
  const keys = new Set(selectedSessions.value)
  const items = sessions.value.filter((s) => keys.has(s.path))
  if (!items.length) return
  ask({
    title: t('dialog.batchDelete.title'),
    message: t('dialog.batchDelete.body', { n: items.length }),
    okText: t('dialog.batchDelete.ok'),
    danger: true,
    onOk: async () => {
      const dir = activeProject.value?.displayPath ?? ''
      const srcRect = deleteSourceRect(items[0])
      for (const s of items) closeTabBySessionPath(s.path)
      const deleted = new Set<string>()
      for (const s of items) {
        try {
          await api.softDeleteSession(agent.value, s.path, dir)
          deleted.add(s.path)
        } catch {
          /* 跳过失败项，继续删除其余 */
        }
      }
      if (deleted.size) {
        fly({
          from: srcRect,
          to: document.querySelector<HTMLElement>('.topbar-trash-btn'),
          variant: 'trash',
        })
      }
      sessions.value = sessions.value.filter((x) => !deleted.has(x.path))
      sessionTotal.value = Math.max(0, sessionTotal.value - deleted.size)
      if (openSession.value && deleted.has(openSession.value.path)) {
        openSession.value = null
      }
      if (sessions.value.length === 0 && activeProject.value) {
        const p = activeProject.value
        closeTabsByProject(p.dirName)
        if (p.bookmarked || p.dirName.startsWith('bookmark:')) {
          await api.removeBookmark(agent.value, p.displayPath)
        }
        activeDir.value = null
      }
      exitSessionSelectMode()
      await loadProjects()
      api.listTrash().then((items) => { trash.value = items }).catch(() => {})
      notify(t('toast.batchDeleted', { n: deleted.size }))
    },
  })
}

// 批量导出：让用户挑一个目标目录，把勾选的会话一次性写成 MD / HTML 文件。
// 失败项跳过，结尾给一个汇总 toast。逐个 readSession 是简单可控的做法
// （会话数量本就不会很大），可以接受。
async function batchExportSessions(kind: ExportKind) {
  const keys = new Set(selectedSessions.value)
  const items = sessions.value.filter((s) => keys.has(s.path))
  if (!items.length) return
  let parent: string | null = null
  try {
    parent = await pickExportDir()
  } catch (e) {
    notify(t('toast.batchExportFail', { e: String(e) }), true)
    return
  }
  if (!parent) return
  // 在用户选的目录里按约定再开一个子目录：`export-YYYYMMDD-HHMMSS-<kind>/`。
  // 这样多次批量导出不会互相覆盖，文件夹名一眼就能看出是什么时候、哪种格式的导出。
  // write_file 会自动 create_dir_all 父目录，不需要单独再发一次"建目录"命令。
  const dir = `${parent}/${batchExportFolderName(kind)}`
  let ok = 0
  let lastPath = ''
  for (const s of items) {
    try {
      const msgs = await api.readSession(agent.value, s.path)
      const fn =
        kind === 'md'
          ? exportMarkdownToDir
          : kind === 'json'
            ? exportJsonToDir
            : exportHtmlToDir
      lastPath = await fn(s, msgs, agent.value, dir)
      recordExport({ path: s.path, title: s.title, agent: agent.value, sessionId: s.id, cwd: s.cwd, exportedAt: Date.now() })
      ok++
    } catch {
      /* 跳过失败项，继续导出其余 */
    }
  }
  exitSessionSelectMode()
  if (ok > 0) {
    notify(t('toast.batchExported', { n: ok, dir }))
    if (lastPath) api.revealInFinder(lastPath).catch(() => {})
  } else {
    notify(t('toast.batchExportFail', { e: t('toast.batchExportNone') }), true)
  }
}

function clearTrash() {
  if (!trash.value.length) return
  ask({
    title: t('dialog.empty.title'),
    message: t('dialog.empty.body', { n: trash.value.length }),
    okText: t('dialog.empty.ok'),
    danger: true,
    onOk: async () => {
      try {
        await api.emptyTrash()
        trash.value = []
        exitSelectMode()
        notify(t('toast.trashEmptied'))
      } catch (e) {
        notify(t('toast.emptyFail', { e: String(e) }), true)
      }
    },
  })
}

async function reveal(path: string) {
  try {
    await api.revealInFinder(path)
  } catch (e) {
    notify(`${e}`, true)
  }
}

function exportFn(kind: ExportKind) {
  return kind === 'md' ? exportMarkdown : kind === 'json' ? exportJson : exportHtml
}

function getHiddenKeys(sessionPath: string): string[] {
  try {
    const raw = localStorage.getItem(`hidden:${sessionPath}`)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

async function exportSession(kind: ExportKind) {
  if (!openSession.value) return
  const s = openSession.value
  const a = chatAgent.value
  try {
    const hiddenKeys = kind === 'html' ? getHiddenKeys(s.path) : undefined
    const path = await exportFn(kind)(s, chatMsgs.value, a, hiddenKeys)
    // 用户在 Save As 对话框点了取消时返回 null —— 静默放弃
    if (!path) return
    recordExport({ path: s.path, title: s.title, agent: a, sessionId: s.id, cwd: s.cwd, exportedAt: Date.now() })
    notify(t('toast.exported', { path }))
    api.revealInFinder(path).catch(() => {})
  } catch (e) {
    notify(t('toast.exportFail', { e: String(e) }), true)
  }
}

// 列表里直接导出某个会话：不打开会话，临时把消息读出来即可。
async function exportFromList(s: SessionMeta, kind: ExportKind) {
  try {
    const msgs = await api.readSession(agent.value, s.path)
    const path = await exportFn(kind)(s, msgs, agent.value)
    if (!path) return
    recordExport({ path: s.path, title: s.title, agent: agent.value, sessionId: s.id, cwd: s.cwd, exportedAt: Date.now() })
    notify(t('toast.exported', { path }))
    api.revealInFinder(path).catch(() => {})
  } catch (e) {
    notify(t('toast.exportFail', { e: String(e) }), true)
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notify(t('toast.copied'))
  } catch (e) {
    notify(t('toast.copyFail', { e: String(e) }), true)
  }
}

// （之前还有一个 `resume()` 走外部 Terminal.app 的版本；现在 ChatView / SessionsView
// 的 Resume 全部统一到窗口内 TUI tab，对应的 api.resumeSession + lib.rs::resume_session
// 后端命令仍保留，便于以后真要给"在外部 Terminal 打开"加按钮时直接复用。）

// ---------- TerminalStrip 的 List / View 切换 ----------
// List → 关闭当前会话 + 退出 TUI（落回 SessionsView）
// View → 保留当前会话，仅退出 TUI（落回 ChatView）
async function onTuiListClick() {
  openSession.value = null
  setActiveTui(null)
  if (activeDir.value) {
    await loadProjects()
    await refreshSessions()
  }
}

function startTuiTitleSyncTimer() {
  window.clearInterval(tuiTitleSyncTimer)
  tuiTitleSyncTimer = window.setInterval(() => {
    syncTuiTitlesNow()
  }, TUI_TITLE_SYNC_INTERVAL_MS)
}
function onTuiViewClick() {
  setActiveTui(null)
}

// Tab 被手动关闭（× 按钮）后，如果 TUI 层消失（无更多 tab），刷新数据——
// 和 onTuiListClick 同等效果，确保 CLI 新建的会话出现在列表里。
async function onTuiTabClosed(closedSessionPath: string) {
  if (activeUiId.value !== null) return
  if (openSession.value && (!closedSessionPath || openSession.value.path === closedSessionPath)) {
    openSession.value = null
    clearLive()
  }
  if (!activeDir.value || showTrash.value || showStats.value) return
  await loadProjects()
  await refreshSessions()
}

function closeActiveTab() {
  const tab = currentActiveTab()
  if (tab) {
    const sessionPath = tab.sessionPath ?? ''
    closeTab(tab.uiId)
    onTuiTabClosed(sessionPath)
  } else if (openSession.value) {
    openSession.value = null
    clearLive()
  }
}

function renameActiveTab() {
  const tab = currentActiveTab()
  if (tab) {
    openRenameFromTuiTab(tab)
  }
}

async function openRenameFromTuiTab(tab: TerminalTab) {
  if (tab.isShell) {
    renameModal.value = {
      show: true,
      agent: tab.agent,
      path: '',
      id: '',
      value: tab.title,
      defaultTitle: tab.title,
      shellTabUiId: tab.uiId,
    }
    return
  }
  if (!tab.sessionPath) {
    await syncTuiTitlesNow()
  }
  if (!tab.sessionPath) {
    renameModal.value = {
      show: true,
      agent: tab.agent,
      path: '',
      id: '',
      value: tab.title,
      defaultTitle: tab.title,
      shellTabUiId: tab.uiId,
    }
    return
  }
  openRenameState(tab.agent, tab.sessionPath, tab.sessionId, tab.title)
}

/** Resume 一个会话 —— 根据设置决定走窗口内 TUI 还是外部终端。 */
async function resumeHere(s: SessionMeta) {
  const cwd = s.cwd || activeProject.value?.displayPath || ''
  if (!cwd) {
    notify(t('toast.resumeNoCwd'), true)
    return
  }
  try {
    if (useExternalTerminal.value) {
      await api.resumeSession(chatAgent.value, s.id, cwd, s.path, launchArgs.value[chatAgent.value as keyof typeof launchArgs.value] || '', terminalApp.value)
    } else {
      await openOrFocusTui({
        agent: chatAgent.value,
        projectKey: activeProject.value?.dirName ?? activeDir.value ?? '',
        sessionId: s.id,
        sessionPath: s.path,
        title: s.title,
        cwd,
      })
    }
  } catch (e) {
    notify(`${e}`, true)
  }
}

async function hydrateSavedTab(saved: SavedTab) {
  try {
    if (saved.isShell) {
      await openShellTab({
        agent: saved.agent,
        projectKey: saved.projectKey,
        title: saved.title,
        cwd: saved.cwd,
      })
    } else {
      await openOrFocusTui({
        agent: saved.agent,
        projectKey: saved.projectKey,
        sessionId: saved.sessionId,
        sessionPath: saved.sessionPath,
        title: saved.title,
        cwd: saved.cwd,
        ...(!saved.sessionId ? { knownSessionPaths: sessions.value.map((s) => s.path) } : {}),
        ...(saved.userRenamed ? { userRenamed: true } : {}),
      })
    }
  } catch (e) {
    notify(`${e}`, true)
  }
}

/** 开一个全新会话 —— 根据设置决定走窗口内 TUI 还是外部终端。 */
async function newSession() {
  const cwd = activeProject.value?.displayPath || ''
  if (!cwd) return
  try {
    if (useExternalTerminal.value) {
      await api.newSession(agent.value, cwd, launchArgs.value[agent.value as keyof typeof launchArgs.value] || '', terminalApp.value)
    } else {
      await openOrFocusTui({
        agent: agent.value,
        projectKey: activeProject.value?.dirName ?? activeDir.value ?? '',
        sessionId: '',
        sessionPath: '',
        title: t('chat.tui.newSessionTitle'),
        cwd,
        knownSessionPaths: sessions.value.map((s) => s.path),
      })
    }
  } catch (e) {
    notify(`${e}`, true)
  }
}

/** 开一个纯 shell tab —— 不跑任何 agent CLI，用于执行任意 shell 命令。 */
async function newShellSession() {
  const cwd = activeProject.value?.displayPath || ''
  if (!cwd) return
  try {
    await openShellTab({
      agent: agent.value,
      projectKey: activeProject.value?.dirName ?? activeDir.value ?? '',
      title: t('list.action.newTerminal'),
      cwd,
    })
  } catch (e) {
    notify(`${e}`, true)
  }
}

// 顶栏右上角的仓库入口
const REPO_URL = 'https://github.com/jerrywu001/cc-sessions-viewer'
function openRepo() {
  api.openUrl(REPO_URL).catch((e) => notify(`${e}`, true))
}

function runEditCommand(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') {
  document.execCommand(command)
}

const menuHandlers: MenuHandlers = {
  'open-global-search': () => openGlobalSearch(),
  'find-in-session': () => focusSearchBox(),
  'find-next': () => chatNavigate(1),
  'find-prev': () => chatNavigate(-1),
  'toggle-sidebar': toggleSidebar,
  'new-session': () => newSession(),
  'new-tab': () => newSession(),
  'close-tab': () => closeActiveTab(),
  'rename-tab': () => renameActiveTab(),
  'add-folder': () => addBookmark(),
  'open-settings': () => {
    showSettings.value = true
  },
  'export-session': () => {
    if (!openSession.value) {
      notify(t('toast.exportNoSession'))
      return
    }
    exportSession('md')
  },
  'open-trash': () => loadTrash(),
  'open-stats': openStats,
  'check-update': () => {
    showSettings.value = true
  },
  'theme:light': () => setTheme('light'),
  'theme:dark': () => setTheme('dark'),
  'theme:system': () => setTheme('system'),
  'theme:codex': () => setTheme('codex'),
  'theme:dracula': () => setTheme('dracula'),
  'lang:en': () => setLang('en'),
  'lang:zh': () => setLang('zh'),
  'lang:zh-TW': () => setLang('zh-TW'),
  'lang:ja': () => setLang('ja'),
  'help-docs': () => api.openUrl(`${REPO_URL}#readme`).catch((e) => notify(`${e}`, true)),
  'help-repo': () => openRepo(),
  'help-issue': () => api.openUrl(`${REPO_URL}/issues`).catch((e) => notify(`${e}`, true)),
  'edit:undo': () => runEditCommand('undo'),
  'edit:redo': () => runEditCommand('redo'),
  'edit:cut': () => runEditCommand('cut'),
  'edit:copy': () => runEditCommand('copy'),
  'edit:paste': () => runEditCommand('paste'),
  'edit:select-all': () => runEditCommand('selectAll'),
}

const windowMenus = computed<WindowMenuGroup[]>(() => [
  {
    label: 'File',
    items: [
      { type: 'item', id: 'new-session', label: 'New Session in Current Project', shortcut: 'Ctrl+N', disabled: !activeProject.value },
      { type: 'item', id: 'new-tab', label: 'New Tab', shortcut: 'Ctrl+T', disabled: !activeProject.value },
      { type: 'item', id: 'close-tab', label: 'Close Tab', shortcut: 'Ctrl+W', disabled: !activeUiId.value && !openSession.value },
      { type: 'item', id: 'rename-tab', label: 'Rename Tab', shortcut: 'Ctrl+R', disabled: !activeUiId.value },
      { type: 'item', id: 'add-folder', label: 'Add Folder...', shortcut: 'Ctrl+O' },
      { type: 'separator' },
      { type: 'item', id: 'export-session', label: 'Export Session...', shortcut: 'Ctrl+E', disabled: !openSession.value },
    ],
  },
  {
    label: 'Edit',
    items: [
      { type: 'item', id: 'edit:undo', label: 'Undo', shortcut: 'Ctrl+Z' },
      { type: 'item', id: 'edit:redo', label: 'Redo', shortcut: 'Ctrl+Y' },
      { type: 'separator' },
      { type: 'item', id: 'edit:cut', label: 'Cut', shortcut: 'Ctrl+X' },
      { type: 'item', id: 'edit:copy', label: 'Copy', shortcut: 'Ctrl+C' },
      { type: 'item', id: 'edit:paste', label: 'Paste', shortcut: 'Ctrl+V' },
      { type: 'item', id: 'edit:select-all', label: 'Select All', shortcut: 'Ctrl+A' },
    ],
  },
  {
    label: 'View',
    items: [
      { type: 'item', id: 'toggle-sidebar', label: 'Toggle Sidebar', shortcut: 'Ctrl+B' },
      { type: 'item', id: 'open-stats', label: 'Statistics', shortcut: 'Ctrl+Shift+S' },
      { type: 'separator' },
      {
        type: 'submenu',
        label: 'Theme',
        items: [
          { type: 'item', id: 'theme:light', label: 'Light', checked: theme.value === 'light' },
          { type: 'item', id: 'theme:dark', label: 'Dark', checked: theme.value === 'dark' },
          { type: 'item', id: 'theme:system', label: 'System', checked: theme.value === 'system' },
          { type: 'item', id: 'theme:codex', label: 'Codex', checked: theme.value === 'codex' },
          { type: 'item', id: 'theme:dracula', label: 'Dracula', checked: theme.value === 'dracula' },
        ],
      },
      {
        type: 'submenu',
        label: 'Language',
        items: [
          { type: 'item', id: 'lang:en', label: 'English', checked: lang.value === 'en' },
          { type: 'item', id: 'lang:zh', label: '简体中文', checked: lang.value === 'zh' },
          { type: 'item', id: 'lang:zh-TW', label: '繁體中文', checked: lang.value === 'zh-TW' },
          { type: 'item', id: 'lang:ja', label: '日本語', checked: lang.value === 'ja' },
        ],
      },
    ],
  },
  {
    label: 'Find',
    items: [
      { type: 'item', id: 'find-in-session', label: 'Find in Session...', shortcut: 'Ctrl+F' },
      { type: 'item', id: 'find-next', label: 'Find Next', shortcut: 'Ctrl+G' },
      { type: 'item', id: 'find-prev', label: 'Find Previous', shortcut: 'Ctrl+Shift+G' },
      { type: 'separator' },
      { type: 'item', id: 'open-global-search', label: 'Find in All Sessions...', shortcut: 'Ctrl+Shift+F' },
    ],
  },
  {
    label: 'Window',
    items: [
      { type: 'item', id: 'window:minimize', label: 'Minimize' },
      { type: 'item', id: 'window:maximize', label: 'Maximize' },
      { type: 'separator' },
      { type: 'item', id: 'open-trash', label: 'Trash', shortcut: 'Ctrl+Shift+T' },
      { type: 'item', id: 'window:fullscreen', label: 'Toggle Full Screen' },
    ],
  },
  {
    label: 'Help',
    items: [
      { type: 'item', id: 'help-docs', label: 'Documentation' },
      { type: 'item', id: 'help-repo', label: 'GitHub Repository' },
      { type: 'item', id: 'help-issue', label: 'Report an Issue' },
    ],
  },
])

function onClearCache() {
  ask({
    title: t('dialog.clearCache.title'),
    message: t('dialog.clearCache.body'),
    okText: t('dialog.clearCache.ok'),
    danger: true,
    onOk: () => {
      clearAppCache()
      projPrefs.value = {}
      api.detectTerminals().then(applyTerminalDefault).catch(() => {})
      notify(t('toast.cacheCleared'))
    },
  })
}

function onClearTabs() {
  ask({
    title: t('dialog.clearTabs.title'),
    message: t('dialog.clearTabs.body'),
    okText: t('dialog.clearTabs.ok'),
    danger: true,
    onOk: () => {
      clearAllTabs()
      notify(t('toast.tabsCleared'))
    },
  })
}

// ---------- 窗口聚焦 / 失焦：与 Codex 一致的弱化态 ----------
const windowFocused = ref(document.hasFocus())
function onFocus() {
  windowFocused.value = true
  clearPendingLiveNotification()
}
function onBlur() {
  windowFocused.value = false
}
function appVisible() {
  return windowFocused.value && document.visibilityState === 'visible'
}
function onVisibilityChange() {
  if (document.visibilityState === 'visible') clearPendingLiveNotification()
  if (document.visibilityState === 'hidden') saveTabState()
}

function saveTabState() {
  const cur = currentActiveTab()
  const view: 'list' | 'tui' | 'welcome' = cur
    ? 'tui'
    : activeDir.value
      ? 'list'
      : 'welcome'
  // sessionPath 为空的 tab（shell / 未匹配新会话）用在 live 列表中的索引定位
  const noPathIdx = cur && !cur.sessionPath
    ? tuiTabs.value.filter((t) => !t.sessionPath).indexOf(cur)
    : undefined
  persistTabState({
    agent: agent.value,
    activeDir: activeDir.value,
    activeSessionPath: cur?.sessionPath ?? null,
    view,
    ...(noPathIdx != null && noPathIdx >= 0 ? { activeSavedIndex: noPathIdx } : {}),
  })
}

onMounted(() => {
  // 恢复上次退出时的侧栏导航状态
  const nav = loadSavedNav()
  if (nav) {
    agent.value = nav.agent
    activeDir.value = nav.activeDir
  }

  loadProjects().then(async () => {
    // 退出时在终端 tab 上 → 自动水合那个 tab；同时把侧栏切到 tab 所属的项目
    // （退出时可能在 A 项目看 tab，但 savedNav.activeDir 因旧格式或竞态存了 B）。
    // 兼容旧格式：没有 view 字段时，有 activeSessionPath 就视为 'tui'。
    const shouldHydrate = (nav?.activeSessionPath || nav?.activeSavedIndex != null) &&
      (nav.view === 'tui' || nav.view === undefined)
    if (shouldHydrate) {
      let target: SavedTab | undefined
      if (nav!.activeSavedIndex != null) {
        const noPath = savedTabs.value.filter((s) => !s.sessionPath)
        target = noPath[nav!.activeSavedIndex] ?? noPath[0]
      } else {
        target = savedTabs.value.find(
          (s) => s.sessionPath === nav!.activeSessionPath,
        )
      }
      if (target) {
        activeDir.value = target.projectKey
        await refreshSessions()
        removeSavedTab(target.sessionPath ? target.sessionPath : target)
        await hydrateSavedTab(target)
        return
      }
    }
    if (activeDir.value) await refreshSessions()
  })
  // 启动时拉一次回收站，让顶栏红点从一开始就准确（不必先打开回收站视图）
  api.listTrash().then((items) => { trash.value = items }).catch(() => {})
  // 检测可用终端，首次启动时自动选默认（有 cmux 就默认 cmux）
  api.detectTerminals().then(applyTerminalDefault).catch(() => {})

  // 关窗 / 隐藏 / 退出时保存 tab 状态
  window.addEventListener('beforeunload', saveTabState)

  // 实时防抖存：状态变化时 500ms 后自动持久化，进程被 kill 也不丢状态。
  // 只 watch 影响恢复的信号（agent / 项目 / 激活的 tab / tab 数量），
  // 不 deep watch tuiTabs 内部高频字段（lastOutputAt / turnState 等）。
  let saveTimer: number | null = null
  const debouncedSave = () => {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(saveTabState, 500)
  }
  const tabCount = computed(() => tuiTabs.value.length)
  const savedCount = computed(() => savedTabs.value.length)
  watch([agent, activeDir, activeUiId, tabCount, savedCount], debouncedSave)
  // 后台检查 GitHub release —— 缓存 24h，失败完全静默；结果驱动侧边栏 Settings
  // 按钮上的"有新版本"小红点。
  runBackgroundCheck()
  startTuiTitleSyncTimer()
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  window.addEventListener('resize', onWindowResize)
  document.addEventListener('visibilitychange', onVisibilityChange)
  // 右键菜单的全局关闭：任意点击 / 滚轮 / ESC
  document.addEventListener('mousedown', (e) => {
    if (!ctxMenu.value) return
    const target = e.target as HTMLElement | null
    if (target && target.closest('.ctx-menu')) return
    closeCtxMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxMenu.value) closeCtxMenu()
  })
  window.addEventListener('blur', closeCtxMenu)
  document.addEventListener('wheel', closeCtxMenu, { passive: true })

  // JS-side keyboard shortcuts — fallback for when native menu accelerators
  // don't fire (Windows WebView2 swallows some Ctrl combos, Linux varies).
  // Capture phase so child stopPropagation can't block us.
  const _isMac = /Mac/i.test(navigator.platform)
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = _isMac ? e.metaKey : e.ctrlKey
      const otherMod = _isMac ? e.ctrlKey : e.metaKey
      if (!mod || otherMod || e.altKey) return

      const key = e.key.toLowerCase()
      if (key === 'w' && !e.shiftKey) {
        e.preventDefault(); closeActiveTab()
      } else if (key === 't' && !e.shiftKey) {
        e.preventDefault(); newSession()
      } else if (key === 'r' && !e.shiftKey) {
        e.preventDefault(); renameActiveTab()
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault(); openGlobalSearch()
      } else if (key === 'f' && !e.shiftKey) {
        e.preventDefault(); focusSearchBox()
      } else if (key === 'g' && !e.shiftKey) {
        e.preventDefault(); chatNavigate(1)
      } else if (key === 'g' && e.shiftKey) {
        e.preventDefault(); chatNavigate(-1)
      } else if (key === 'n' && !e.shiftKey) {
        e.preventDefault(); newSession()
      } else if (key === 'o' && !e.shiftKey) {
        e.preventDefault(); addBookmark()
      } else if (key === 'e' && !e.shiftKey) {
        e.preventDefault()
        if (openSession.value) exportSession('md')
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault(); toggleSidebar()
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault(); openStats()
      } else if (key === ',' && !e.shiftKey) {
        e.preventDefault(); settingsTab.value = 'general'; showSettings.value = true
      } else if (key === 't' && e.shiftKey) {
        e.preventDefault(); loadTrash()
      } else if ((key === '/' || key === '?') && !e.shiftKey) {
        e.preventDefault()
        showSettings.value = true
        settingsTab.value = 'shortcuts'
      }
    },
    true,
  )

  // 原生菜单 → 前端动作路由。菜单项的 id 在 src-tauri/src/menu.rs 里定义。
  installMenuRouter(menuHandlers).then((fn) => {
    menuUnlisten = fn
  })

  // 启动时把当前 theme / lang 同步给菜单的 CheckMenuItem 勾选态。
  emitMenuSync('theme', theme.value)
  emitMenuSync('lang', lang.value)
})

// 主题 / 语言变化 → 同步菜单勾选态。
watch(theme, (v) => emitMenuSync('theme', v))
watch(lang, (v) => emitMenuSync('lang', v))

// (agent, activeDir) 切换后，如果当前 active 的 TUI tab 不在新范围里 → 自动让位回 view。
// 现存的导航函数（switchAgent / selectProject 等）已经显式 setActiveTui(null)，但有些
// 路径（直接改 activeDir / 关闭项目）走不到那里，这条 watch 兜底。tabs 本身不动 ——
// PTY 仍活着，切回原项目时 strip 会再次显示。
watch([agent, activeDir], () => {
  const cur = currentActiveTab()
  if (!cur) return
  if (cur.agent !== agent.value || cur.projectKey !== (activeDir.value ?? '')) {
    setActiveTui(null)
  }
})

watch([codexShowInternalSessions, codexShowArchivedSessions], () => {
  if (agent.value !== 'codex') return
  loadProjects()
  if (activeDir.value && !showTrash.value && !showStats.value) {
    refreshSessions()
  }
})

let menuUnlisten: UnlistenFn | null = null

// Live tail：监听 watch.rs emit 的 3 个事件。安装一次，整个应用生命周期共用。
//   session:append → 后端把新增的尾段 Msg 推过来；前端 push 进 chatMsgs，
//                    再调 ChatView.onLiveAppend(n) 让它做 smart-scroll。
//   session:reset  → 文件被截断 / 替换 → 整段重拉。
//   session:gone   → 文件不在了 → 关闭当前会话，toast 一下。
// path 兜底校验：用户在 emit 飞过来的极短窗口里切换了会话 / 关掉了详情页，
// 我们只接当前 openSession.path 一致的事件，避免把 A 会话的尾段塞到 B 里。
let liveUnlisteners: UnlistenFn[] = []

type TerminalTurnEvent = {
  agent: Agent
  path: string
  state: 'started' | 'completed' | 'blocked' | 'failed'
}

async function installLiveTailListeners() {
  const appendUnlisten = await listen<{ path: string; messages: Msg[] }>(
    'session:append',
    (e) => {
      const cur = openSession.value
      if (!cur || cur.path !== e.payload.path) return
      const added = e.payload.messages
      if (!added.length) return
      markTabSessionActivity(chatAgent.value, cur.path)
      chatMsgs.value = chatMsgs.value.concat(added)
      // 真的有新增 → 标"Live"，并续命 fade 定时器。
      markLive()
      enqueueLiveNotification({
        agent: chatAgent.value,
        sessionTitle: cur.title || shortName(cur.path),
        sessionPath: cur.path,
        messages: added,
        appVisible: appVisible(),
      })
      // 等 v-for 把新行挂上 DOM，再交给 ChatView 决定是否自动滚到底。
      nextTick(() => chatViewRef.value?.onLiveAppend?.(added.length))
    },
  )
  const resetUnlisten = await listen<{ path: string }>('session:reset', async (e) => {
    const cur = openSession.value
    if (!cur || cur.path !== e.payload.path) return
    // 整段重读 —— 不动 openSession 自身，避免 watch 重置 chat-toolbar 状态。
    try {
      markTabSessionActivity(chatAgent.value, cur.path)
      chatMsgs.value = await api.readSession(chatAgent.value, cur.path)
    } catch {
      // 读不出来通常是文件刚被换掉；下一次 emit 会再来一次。
    }
  })
  const goneUnlisten = await listen<{ path: string }>('session:gone', (e) => {
    const cur = openSession.value
    if (!cur || cur.path !== e.payload.path) return
    notify(t('toast.sessionGone'))
    openSession.value = null
  })
  liveUnlisteners.push(appendUnlisten, resetUnlisten, goneUnlisten)
}

async function installTerminalTurnListeners() {
  const turnUnlisten = await listen<TerminalTurnEvent>('terminal-turn://state', (e) => {
    const { agent: eventAgent, path, state } = e.payload
    if (!path) return
    if (state === 'started') markTabTurnStarted(eventAgent, path)
    else if (state === 'completed') markTabTurnCompleted(eventAgent, path)
    else if (state === 'blocked') markTabTurnBlocked(eventAgent, path)
    else if (state === 'failed') markTabTurnFailed(eventAgent, path)
  })
  liveUnlisteners.push(turnUnlisten)
}

onMounted(() => {
  installLiveTailListeners()
  installTerminalTurnListeners()
})

onUnmounted(() => {
  menuUnlisten?.()
  menuUnlisten = null
  window.clearInterval(tuiTitleSyncTimer)
  tuiTitleSyncTimer = 0
  liveUnlisteners.forEach((u) => u())
  liveUnlisteners = []
  clearLive()
  document.body.classList.remove('is-sidebar-resizing')
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('pointermove', onSidebarResizePointerMove)
  window.removeEventListener('pointerup', onSidebarResizePointerUp)
  window.removeEventListener('pointercancel', onSidebarResizePointerUp)
  clearPendingLiveNotification()
  api.unwatchSession().catch(() => {})
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('blur', onBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// 全局搜索命中：跳到对应项目并打开会话；正文命中再滚到目标消息并触发闪烁动画。
// 如果命中所在项目不在已加载列表里（极少见 —— list_projects 通常涵盖全部），
// 先刷一次项目列表再跳。
async function onGlobalSearchOpen(hit: SearchHit) {
  setActiveTui(null)
  showStats.value = false
  showTrash.value = false
  showExportHistory.value = false
  showPricing.value = false
  sessionStatsTarget.value = null
  if (activeDir.value !== hit.projectKey) {
    if (!projects.value.some((p) => p.dirName === hit.projectKey)) {
      await loadProjects()
    }
    await selectProject(hit.projectKey)
  }
  await openChat(hit.session)
  if (hit.matchedField === 'text' && typeof hit.matchMsgIndex === 'number') {
    for (let i = 0; i < 10; i++) {
      await nextTick()
      if (chatViewRef.value) break
    }
    chatViewRef.value?.flashMessage(hit.matchMsgIndex, hit.matchMsgUuid ?? undefined)
  }
}
</script>

<template>
  <div
    class="app"
    :style="appStyle"
    :class="[
      `agent-${agent}`,
      sidebarOpen ? 'sidebar-open' : 'sidebar-closed',
      { 'sidebar-resizing': sidebarResizing },
      { 'is-blurred': !windowFocused },
    ]"
  >
    <WindowsTitlebar
      v-if="isWindows"
      :menus="windowMenus"
      :handlers="menuHandlers"
    />
    <!-- 顶栏：normal flow，整条都是 macOS 拖动区。
         data-tauri-drag-region="deep" 让整个子树（除按钮等可点击元素外）
         都触发原生 startDragging；button/A/INPUT 等会自动 block 拖动，
         不需要手动 no-drag。同时保留 -webkit-app-region: drag 做 OS 层兜底。 -->
    <div class="app-topbar" :data-tauri-drag-region="isWindows ? undefined : 'deep'">
      <SidebarTopbar
        :show-trash="showTrash"
        :show-stats="showStats"
        :show-history="showExportHistory"
        :show-pricing="showPricing"
        :has-trash="trash.length > 0"
        @toggle-sidebar="toggleSidebar"
        @open-trash="loadTrash"
        @open-stats="openStats"
        @open-history="openExportHistory"
        @open-pricing="openPricing"
      />
      <!-- 顶栏右侧分发：每个页面把自己的工具栏组件挂这里。
           本身仍是 macOS 拖动区域，组件内部的可交互元素由 CSS 单独标 no-drag。 -->
      <div class="topbar-drag">
        <div class="topbar-context">
          <span class="topbar-agent-mark" aria-hidden="true">{{ activeAgentLabel.charAt(0) }}</span>
          <span class="topbar-context-text">
            <span class="topbar-context-title">{{ topbarContextTitle }}</span>
            <span v-if="topbarContextMeta" class="topbar-context-meta">
              / {{ topbarContextMeta }}
            </span>
          </span>
        </div>
        <!-- StatsView 自带顶部控制条，这里就让出空间（保持拖动区域）。
             showStats 优先级要高于 openSession，否则进入会话统计模式时
             还会渲染 ChatTopbar 的「会话统计」按钮，造成视觉重复。 -->
        <div v-if="showStats" />
        <ChatTopbar v-else-if="openSession" />
        <TrashTopbar
          v-else-if="showTrash"
          :items="trash"
        />
        <SessionsTopbar
          v-else-if="activeProject"
          :sessions="sessions"
        />
        <div v-else class="chat-topbar">
          <button
            type="button"
            class="ct-search topbar-global-search"
            v-tooltip="t('search.global.placeholder')"
            @click="openGlobalSearch"
          >
            <IconSearch class="ct-search-ic" />
            <span>{{ t('search.global.placeholder') }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="app-body">
    <!-- 侧栏 -->
    <Sidebar
      v-show="sidebarOpen"
      :agent="agent"
      :projects="projects"
      :active-dir="activeDir"
      :show-trash="showTrash"
      :proj-prefs="projPrefs"
      :refreshing="refreshing"
      @switch-agent="switchAgent"
      @select-project="selectProject"
      @context-menu="openCtxMenu"
      @open-settings="showSettings = true"
      @refresh="refreshAll"
      @add-bookmark="addBookmark"
      @batch-delete="batchDeleteProjects"
      ref="sidebarRef"
    />
    <div
      v-show="sidebarOpen"
      class="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="onSidebarResizePointerDown"
    />

    <!-- 主区 -->
    <main class="main">
      <!-- TUI tab 条：左边 List/View meta tab + 当前项目的 PTY tab。
           inProjectBrowse 决定 List/View 是否显示；hasOpenSession 决定 View 是否显示。 -->
      <TerminalStrip
        :agent="agent"
        :project-key="activeDir"
        :in-project-browse="!!activeDir && !showTrash && !showStats"
        :has-open-session="!!openSession"
        @list-click="onTuiListClick"
        @view-click="onTuiViewClick"
        @tab-closed="onTuiTabClosed"
        @tab-rename="openRenameFromTuiTab"
        @new-session="newSession"
        @new-shell="newShellSession"
        @hydrate-saved="hydrateSavedTab"
      />

      <!-- view 层 / TUI 层 同时存在；activeUiId === null 时只显示 view，
           否则 view 隐去、TerminalPaneSlot 顶到面前。两层都是 main-body 的子，
           position 由 CSS 控制。 -->
      <div class="main-body">
        <!-- 标准视图（聊天 / 列表 / 统计 / 回收站 / 欢迎页） -->
        <div class="view-layer" v-show="activeUiId === null">
          <StatsView
            v-if="showStats"
            :session="sessionStatsTarget"
            @close="closeStats"
            @open-project="(dir) => selectProject(dir)"
            @open-session="openSessionStatsFromGlobal"
          />

          <template v-else-if="openSession">
            <div v-if="loadingChat" class="loading">{{ t('common.loading') }}</div>
            <ChatView
              v-else
              ref="chatViewRef"
              :agent="chatAgent"
              :session="openSession"
              :messages="chatMsgs"
              :trashed="!!openTrashItem"
              :live="liveTailing"
              :cwd="chatCwd"
              @back="openSession = null"
              @refresh="openChat(openSession)"
              @delete="deleteSession(openSession)"
              @resume-here="resumeHere(openSession)"
              @rename="openRename(openSession)"
              @reveal="reveal(openSession.path)"
              @copy-id="copyText(openSession.id)"
              @export-md="exportSession('md')"
              @export-html="exportSession('html')"
              @export-json="exportSession('json')"
              @restore="openTrashItem && restore(openTrashItem)"
              @open-session-stats="openSessionStats"
            />
          </template>

          <TrashView
            v-else-if="showTrash"
            :trash="trash"
            :loading="loadingList"
            @clear="clearTrash"
            @open="openTrashSession"
            @restore="restore"
            @permanent-delete="permanentDelete"
            @batch-restore="batchRestore"
            @batch-permanent-delete="batchPermanentDelete"
          />

          <ExportHistoryView
            v-else-if="showExportHistory"
            @open="openHistorySession"
          />

          <PricingView v-else-if="showPricing" />

          <SessionsView
            v-else-if="activeProject"
            ref="sessionsViewRef"
            :agent="agent"
            :project="activeProject"
            :sessions="sessions"
            :session-total="sessionTotal"
            :loading="loadingList"
            :loading-more="loadingMore"
            @open="openChat"
            @rename="openRename"
            @resume="resumeHere"
            @reveal="reveal"
            @delete="deleteSession"
            @copy="copyText"
            @export="exportFromList"
            @refresh="refreshSessions"
            @new-session="newSession"
            @new-shell="newShellSession"
            @delete-project="deleteActiveProject"
            @load-more="loadMore"
            @scroll="onListScroll"
            @batch-delete="batchDeleteSessions"
            @batch-export="batchExportSessions"
          />

          <WelcomeView
            v-else
            :agent="agent"
            :projects="projects"
            @select-project="selectProject"
            @switch-agent="switchAgent"
            @open-repo="openRepo"
          />
        </div>

        <!-- TUI 层 —— TerminalPaneSlot 自己用 v-show 控制 attach；这里 wrap 一层
             tui-layer 给 CSS 用于绝对定位填满 main-body。 -->
        <TerminalPaneSlot
          v-show="activeUiId !== null"
          class="tui-layer"
        />
      </div>
    </main>
    </div>

    <!-- 确认弹窗 -->
    <ConfirmModal
      :show="confirm.show"
      :title="confirm.title"
      :message="confirm.message"
      :ok-text="confirm.okText"
      :danger="confirm.danger"
      :alt-text="confirm.altText"
      @confirm="runConfirm"
      @cancel="confirm.show = false"
      @alt="runAlt"
    />

    <!-- 设置弹窗 -->
    <Transition name="fade">
      <SettingsModal
        v-if="showSettings"
        :cache-bytes="cacheBytes"
        :initial-tab="settingsTab"
        @close="showSettings = false; settingsTab = 'general'"
        @clear-cache="onClearCache"
        @clear-tabs="onClearTabs"
      />
    </Transition>

    <!-- 重命名会话 -->
    <RenameModal
      v-model="renameModal.value"
      :show="renameModal.show"
      :default-title="renameModal.defaultTitle"
      @confirm="confirmRename"
      @cancel="renameModal.show = false"
    />

    <!-- 全局搜索（⌘⇧F / Ctrl⇧F） -->
    <GlobalSearchModal
      :show="globalSearchOpen"
      :agent="agent"
      @update:show="globalSearchOpen = $event"
      @open="onGlobalSearchOpen"
    />

    <!-- 项目右键菜单 -->
    <ProjectContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :project="ctxMenu.project"
      :proj-state="projStateOf(ctxMenu.project)"
      @toggle-state="ctxToggleState"
      @refresh="ctxRefresh"
      @delete="ctxDeleteProject"
      @remove-bookmark="ctxRemoveBookmark"
    />

    <!-- toast -->
    <Transition name="fade">
      <div v-if="toast.show" class="toast" :class="{ error: toast.error }">
        {{ toast.msg }}
      </div>
    </Transition>
  </div>
</template>
