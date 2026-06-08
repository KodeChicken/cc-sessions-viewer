// 全局 TUI tabs 管理 —— 把"嵌入终端"提到 App 顶层，让多个 PTY 同时存活、互不打扰。
//
// 设计：
//   - 一个模块级的 reactive `tabs` 列表 + `activeUiId`，全应用唯一来源。
//   - 每个 tab 持有自己的 `Terminal` 实例 + 一个 detached <div> 容器；切 tab 只是
//     把 container 再 attach 到可见的 slot，xterm 内部 scrollback / 光标位置全程不丢。
//   - PTY 字节流通过 Tauri 全局事件 `pty://data` 广播，每个 tab 自己装一个 listener
//     按 `payload.id === ptyId` 过滤；listen 是 N 路独立订阅，互不抢消息。
//   - Terminal / FitAddon / HTMLDivElement 都用 `markRaw()` 包一层，避免 Vue 反应
//     式代理穿透到 xterm 内部 —— xterm 自己管 DOM mutation，不希望被劫持。
//
// 生命周期：
//   - openOrFocusTui  → 同会话已开则 focus；否则 new Terminal + new container +
//                       ptySpawn，把 tab push 进 tabs，set active。
//   - closeTab        → 卸 listener、dispose Terminal、kill PTY、splice。
//   - PTY 自身 exit   → 标记 status='exited'，不立刻移除（用户可以看到完整收尾再手动关）。
//
// 不持久化：刷新 webview = 全部 tabs 没了（PTY 进程被 kill）。这是预期 —— 应用
// 重启相当于关掉所有"窗口"，跟系统终端语义一致。

import { markRaw, nextTick, reactive, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Agent } from './types'
import { theme, launchArgs } from './settings'
import * as api from './api'

export type TerminalProcessState = 'spawning' | 'alive' | 'exited' | 'error'
export type TerminalTurnState = 'idle' | 'working' | 'blocked' | 'review' | 'error' | 'unknown'
export type TerminalTurnSignalSource = 'pty' | 'session' | 'agent'

export interface TerminalTab {
  /** 本地稳定 id，供 v-for 用；和后端 pty id 是两套号 */
  uiId: number
  /** 后端 PTY id —— spawn 完成前是 null */
  ptyId: number | null
  agent: Agent
  /** 所属侧栏项目的 key（= ProjectInfo.dirName）。tab 只在 (agent, projectKey)
   *  匹配当前侧栏选中项时显示在 strip 里；切别的项目 PTY 不杀，只是临时隐藏。 */
  projectKey: string
  sessionId: string
  sessionPath: string
  title: string
  cwd: string
  createdAt: number
  /* xterm 实例 —— 用 markRaw() 防 Vue 代理 */
  term: Terminal
  fitAddon: FitAddon
  /** xterm 真正渲染所在的 <div>；切 tab 时把它从 slot 里挪走 / 挪回，不 dispose Terminal */
  container: HTMLDivElement
  unlistenData: UnlistenFn | null
  unlistenExit: UnlistenFn | null
  onDataDisp: { dispose: () => void } | null
  lastSyncedCols: number
  lastSyncedRows: number
  quietCursor: boolean
  quietCursorTimer: number | null
  lastUserInputAt: number
  /** 进程生命周期：只描述 PTY/CLI 进程本身，不代表本轮回答是否完成。 */
  processState: TerminalProcessState
  /** 本轮问答状态：完成/阻塞/错误只能由 agent/session 的明确信号推进。 */
  turnState: TerminalTurnState
  turnStateSource: TerminalTurnSignalSource | null
  turnStateUpdatedAt: number
  lastOutputAt: number
  lastSessionActivityAt: number
  turnWatchPath: string | null
  /** 兼容旧调用点；语义等同于 processState 的旧命名。 */
  status: 'spawning' | 'running' | 'exited' | 'error'
  errorMessage?: string
  exitCode?: number
}

export const tabs = ref<TerminalTab[]>([])
export const activeUiId = ref<number | null>(null)
let nextUiId = 1
const pendingTurnStates = new Map<
  string,
  { state: TerminalTurnState; source: TerminalTurnSignalSource; updatedAt: number }
>()

// ============================ 主题 ============================

function xtermTheme(isDark: boolean) {
  return isDark
    ? {
        background: '#0a0a0a',
        foreground: '#ededed',
        cursor: '#ededed',
        cursorAccent: '#0a0a0a',
        selectionBackground: 'rgba(255,255,255,0.18)',
        black: '#1f1f1f',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#eab308',
        blue: '#4d8bf8',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e5e5e5',
        brightBlack: '#525252',
        brightRed: '#f87171',
        brightGreen: '#34d399',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fafafa',
      }
    : {
        background: '#ffffff',
        foreground: '#171717',
        cursor: '#171717',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(0,0,0,0.12)',
        black: '#171717',
        red: '#b91c1c',
        green: '#047857',
        yellow: '#a16207',
        blue: '#1d4ed8',
        magenta: '#7c3aed',
        cyan: '#0e7490',
        white: '#404040',
        brightBlack: '#525252',
        brightRed: '#dc2626',
        brightGreen: '#059669',
        brightYellow: '#ca8a04',
        brightBlue: '#2563eb',
        brightMagenta: '#9333ea',
        brightCyan: '#0891b2',
        brightWhite: '#111111',
      }
}

function isDarkActive(): boolean {
  return document.documentElement.classList.contains('theme-dark')
}

function terminalTheme(tab: TerminalTab) {
  const base = xtermTheme(isDarkActive())
  if (!tab.quietCursor) return base
  return {
    ...base,
    cursor: 'rgba(0,0,0,0)',
    cursorAccent: 'rgba(0,0,0,0)',
  }
}

function applyTerminalTheme(tab: TerminalTab) {
  tab.term.options.theme = terminalTheme(tab)
}

// 主题切换：把所有活跃 Terminal 的 theme 选项替换；xterm 自己会重绘。
watch(theme, () => {
  for (const tab of tabs.value) {
    applyTerminalTheme(tab)
  }
})

function setQuietCursor(tab: TerminalTab, quiet: boolean) {
  if (tab.quietCursor === quiet) return
  tab.quietCursor = quiet
  applyTerminalTheme(tab)
}

function markTerminalOutputBusy(tab: TerminalTab) {
  if (Date.now() - tab.lastUserInputAt < 250) return
  if (tab.quietCursorTimer !== null) {
    window.clearTimeout(tab.quietCursorTimer)
  }
  setQuietCursor(tab, true)
  tab.quietCursorTimer = window.setTimeout(() => {
    tab.quietCursorTimer = null
    setQuietCursor(tab, false)
  }, 700)
}

// ============================ base64 双向 ============================
// btoa / atob 对多字节字符不友好，统一走 Uint8Array 转换 + 分块避免栈溢出。

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK)
    bin += String.fromCharCode.apply(null, sub as unknown as number[])
  }
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ============================ 查询 ============================

const findTab = (uiId: number) => tabs.value.find((t) => t.uiId === uiId)
export const isTabProcessAlive = (tab: TerminalTab) =>
  tab.processState === 'spawning' || tab.processState === 'alive'
const findTabBySession = (path: string) =>
  tabs.value.find((t) => t.sessionPath === path && isTabProcessAlive(t))

type SessionForTabSync = {
  path: string
  id: string
  modified: number
  title?: string
}

function applySessionToTab(tab: TerminalTab, session: SessionForTabSync) {
  tab.sessionPath = session.path
  tab.sessionId = session.id
  if (session.title?.trim()) {
    tab.title = session.title
  }
  ensureSessionTurnWatch(tab, true)
  applyPendingTurnState(tab)
}

/**
 * 新会话 tab 的 sessionPath/sessionId 在创建时都是空的（CLI 自己生成 id），
 * 等用户从 TUI 回到列表后，刷新出的 sessions 里会包含刚才创建的会话。
 * 此函数把空路径的 tab 与最新出现的 session 匹配上，后续 closeTabBySessionPath
 * 才能正确找到 tab 并关闭。
 */
export function reconcileNewTabs(
  projectKey: string,
  sessions: SessionForTabSync[],
  agent?: Agent,
) {
  const unmatched = tabs.value.filter(
    (t) =>
      t.sessionPath === '' &&
      t.projectKey === projectKey &&
      (!agent || t.agent === agent) &&
      isTabProcessAlive(t),
  )
  if (!unmatched.length) return

  const takenPaths = new Set(
    tabs.value.filter((t) => t.sessionPath !== '').map((t) => t.sessionPath),
  )
  const available = sessions
    .filter((s) => !takenPaths.has(s.path))
    .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))

  for (const tab of unmatched) {
    const matchIdx = available.findIndex((s) => (s.modified ?? 0) >= tab.createdAt - 5000)
    const match = matchIdx >= 0 ? available.splice(matchIdx, 1)[0] : undefined
    if (match) {
      applySessionToTab(tab, match)
    }
  }
}

export function syncTabTitlesFromSessions(
  agent: Agent,
  projectKey: string,
  sessions: SessionForTabSync[],
) {
  const byPath = new Map(sessions.map((s) => [s.path, s]))
  for (const tab of tabs.value) {
    if (tab.agent !== agent || tab.projectKey !== projectKey || !tab.sessionPath) continue
    const session = byPath.get(tab.sessionPath)
    if (session?.title?.trim() && tab.title !== session.title) {
      tab.title = session.title
    }
  }
}

export function syncTabTitleBySessionPath(agent: Agent, sessionPath: string, title: string) {
  const trimmed = title.trim()
  if (!trimmed) return
  for (const tab of tabs.value) {
    if (tab.agent === agent && tab.sessionPath === sessionPath) {
      tab.title = trimmed
    }
  }
}

function setProcessState(tab: TerminalTab, state: TerminalProcessState) {
  tab.processState = state
  tab.status = state === 'alive' ? 'running' : state
}

function setTurnState(
  tab: TerminalTab,
  state: TerminalTurnState,
  source: TerminalTurnSignalSource,
) {
  tab.turnState = state
  tab.turnStateSource = source
  tab.turnStateUpdatedAt = Date.now()
}

function tabsBySession(agent: Agent, sessionPath: string) {
  if (!sessionPath) return []
  return tabs.value.filter(
    (tab) => tab.agent === agent && tab.sessionPath === sessionPath && isTabProcessAlive(tab),
  )
}

function turnStateKey(agent: Agent, sessionPath: string) {
  return `${agent}\0${sessionPath}`
}

function rememberTurnState(agent: Agent, sessionPath: string, state: TerminalTurnState) {
  if (!sessionPath) return
  pendingTurnStates.set(turnStateKey(agent, sessionPath), {
    state,
    source: 'agent',
    updatedAt: Date.now(),
  })
  if (pendingTurnStates.size > 200) {
    const first = pendingTurnStates.keys().next().value
    if (first) pendingTurnStates.delete(first)
  }
}

function applyPendingTurnState(tab: TerminalTab) {
  if (!tab.sessionPath) return
  const key = turnStateKey(tab.agent, tab.sessionPath)
  const pending = pendingTurnStates.get(key)
  if (!pending) return
  const state =
    pending.state === 'idle' || pending.state === 'review'
      ? activeUiId.value === tab.uiId
        ? 'idle'
        : 'review'
      : pending.state
  setTurnState(tab, state, pending.source)
  tab.turnStateUpdatedAt = pending.updatedAt
  pendingTurnStates.delete(key)
}

export function markTabSessionActivity(agent: Agent, sessionPath: string) {
  const now = Date.now()
  for (const tab of tabsBySession(agent, sessionPath)) {
    tab.lastSessionActivityAt = now
    if (tab.turnState !== 'blocked' && tab.turnState !== 'error') {
      setTurnState(tab, 'working', 'session')
    }
  }
}

export function markTabTurnStarted(agent: Agent, sessionPath: string) {
  const targets = tabsBySession(agent, sessionPath)
  if (!targets.length) rememberTurnState(agent, sessionPath, 'working')
  for (const tab of targets) {
    if (tab.turnState !== 'blocked' && tab.turnState !== 'error') {
      setTurnState(tab, 'working', 'agent')
    }
  }
}

export function markTabTurnCompleted(agent: Agent, sessionPath: string) {
  const targets = tabsBySession(agent, sessionPath)
  if (!targets.length) rememberTurnState(agent, sessionPath, 'review')
  for (const tab of targets) {
    setTurnState(tab, activeUiId.value === tab.uiId ? 'idle' : 'review', 'agent')
  }
}

export function markTabTurnBlocked(agent: Agent, sessionPath: string) {
  const targets = tabsBySession(agent, sessionPath)
  if (!targets.length) rememberTurnState(agent, sessionPath, 'blocked')
  for (const tab of targets) {
    setTurnState(tab, 'blocked', 'agent')
  }
}

export function markTabTurnFailed(agent: Agent, sessionPath: string) {
  const targets = tabsBySession(agent, sessionPath)
  if (!targets.length) rememberTurnState(agent, sessionPath, 'error')
  for (const tab of targets) {
    setTurnState(tab, 'error', 'agent')
  }
}

function shouldWatchSessionTurns(tab: TerminalTab) {
  return (tab.agent === 'codex' || tab.agent === 'gemini') && !!tab.sessionPath
}

function ensureSessionTurnWatch(tab: TerminalTab, catchUp: boolean) {
  if (!shouldWatchSessionTurns(tab)) return
  if (tab.turnWatchPath === tab.sessionPath) return
  if (tab.turnWatchPath) {
    api.unwatchSessionTurn(tab.turnWatchPath).catch(() => {})
  }
  tab.turnWatchPath = tab.sessionPath
  api.watchSessionTurn(tab.agent, tab.sessionPath, catchUp).catch(() => {
    if (tab.turnWatchPath === tab.sessionPath) {
      tab.turnWatchPath = null
    }
  })
}

export function activeTab(): TerminalTab | null {
  if (activeUiId.value === null) return null
  return findTab(activeUiId.value) ?? null
}

// ============================ 开 / 关 / 切 ============================

export interface OpenTuiOptions {
  agent: Agent
  projectKey: string
  /** resume 模式必填；new-session 模式为空 —— 由 CLI 自己生成。 */
  sessionId: string
  /** resume 模式必填；new-session 模式为空 —— JSONL 还没存在。 */
  sessionPath: string
  title: string
  cwd: string
}

/**
 * resume：同会话已有 tab 就 focus；否则新开一个 PTY + xterm 跑 `<cli> --resume <id>`。
 * new：每次都开新 tab，跑 `<cli>` (无 --resume)，CLI 自己生成新 session id；不挂 watcher
 * （没有 sessionPath 可监听）。失败时 tab.status = 'error' 但仍留在列表里。
 */
export async function openOrFocusTui(opts: OpenTuiOptions): Promise<void> {
  if (!opts.cwd) return
  const isNew = !opts.sessionId

  if (!isNew) {
    const existing = findTabBySession(opts.sessionPath)
    if (existing) {
      activeUiId.value = existing.uiId
      return
    }
  }

  const term = markRaw(
    new Terminal({
      fontSize: 13,
      fontFamily:
        '"SF Mono", "Menlo", "Consolas", "Liberation Mono", "Courier New", monospace',
      cursorBlink: false,
      convertEol: false,
      allowProposedApi: true,
      scrollback: 5000,
      theme: xtermTheme(isDarkActive()),
    }),
  )
  const fitAddon = markRaw(new FitAddon())
  term.loadAddon(fitAddon)

  const container = markRaw(document.createElement('div'))
  container.className = 'terminal-host'
  // 提示 xterm 即将 attach；真正的 open(container) 推迟到 slot 把 container 放入
  // 可见 DOM 树之后，否则在 detached 节点上 open 会拿不到尺寸。
  term.open(container)

  const uiId = nextUiId++
  // ⚠️ 必须用 reactive() 包一层 —— 否则后面 `tab.status = 'running'` 改的是
  // raw 对象，Vue Proxy 收不到 set 通知，TerminalStrip 里 v-if="tab.status === 'spawning'"
  // 永远卡在转圈。markRaw 过的 term/fitAddon/container 会被 reactive() 跳过，不会被代理。
  const tab = reactive<TerminalTab>({
    uiId,
    ptyId: null,
    agent: opts.agent,
    projectKey: opts.projectKey,
    sessionId: opts.sessionId,
    sessionPath: opts.sessionPath,
    title: opts.title,
    cwd: opts.cwd,
    createdAt: Date.now(),
    term,
    fitAddon,
    container,
    unlistenData: null,
    unlistenExit: null,
    onDataDisp: null,
    lastSyncedCols: 0,
    lastSyncedRows: 0,
    quietCursor: false,
    quietCursorTimer: null,
    lastUserInputAt: 0,
    processState: 'spawning',
    turnState: 'unknown',
    turnStateSource: null,
    turnStateUpdatedAt: Date.now(),
    lastOutputAt: 0,
    lastSessionActivityAt: 0,
    turnWatchPath: null,
    status: 'spawning',
  }) as TerminalTab
  tabs.value.push(tab)
  activeUiId.value = uiId
  term.attachCustomKeyEventHandler((ev) => {
    const isCtrl =
      ev.type === 'keydown' &&
      ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey
    if (!isCtrl) return true

    const key = ev.key.toLowerCase()
    const isCtrlC = key === 'c'
    const isCtrlV = key === 'v'

    if (isCtrlC && term.hasSelection()) {
      ev.preventDefault()
      void navigator.clipboard.writeText(term.getSelection()).catch(() => {})
      return false
    }

    if (isCtrlV) {
      ev.preventDefault()
      void navigator.clipboard.readText().then((text) => {
        if (text) term.paste(text)
      }).catch(() => {})
      return false
    }

    return true
  })

  // 等 slot 把 container append 到可见 DOM 后再 fit + spawn —— 否则尺寸 = 0。
  // 两轮 rAF：一轮让 Vue 把 v-show 切完，一轮等浏览器布局稳定。
  await nextTick()
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  await new Promise((r) => requestAnimationFrame(() => r(null)))

  try {
    fitAddon.fit()
  } catch {
    /* 容器仍可能没尺寸（用户极速切走），退到默认 80x24 由后端决定 */
  }
  const cols = term.cols || 80
  const rows = term.rows || 24
  tab.lastSyncedCols = cols
  tab.lastSyncedRows = rows

  let ptyId: number
  try {
    const extra = launchArgs.value[opts.agent as keyof typeof launchArgs.value] || ''
    ptyId = isNew
      ? await api.ptySpawnNew(opts.agent, opts.cwd, cols, rows, extra)
      : await api.ptySpawn(
          opts.agent,
          opts.sessionId,
          opts.cwd,
          opts.sessionPath,
          cols,
          rows,
          extra,
        )
  } catch (e) {
    setProcessState(tab, 'error')
    setTurnState(tab, 'error', 'pty')
    tab.errorMessage = String(e)
    term.write(`\r\n\x1b[31m[error] ${e}\x1b[0m\r\n`)
    return
  }
  tab.ptyId = ptyId
  setProcessState(tab, 'alive')
  ensureSessionTurnWatch(tab, false)

  // 后端 → xterm（按 id 过滤多 tab）
  tab.unlistenData = await listen<{ id: number; base64: string }>('pty://data', (e) => {
    if (e.payload.id !== ptyId) return
    tab.lastOutputAt = Date.now()
    markTerminalOutputBusy(tab)
    term.write(base64ToBytes(e.payload.base64))
  })
  tab.unlistenExit = await listen<{ id: number; code: number }>('pty://exit', (e) => {
    if (e.payload.id !== ptyId) return
    setProcessState(tab, 'exited')
    if (tab.turnState === 'working') {
      setTurnState(tab, e.payload.code === 0 ? 'unknown' : 'error', 'pty')
    }
    tab.exitCode = e.payload.code
    term.write(`\r\n\x1b[2m[process exited: ${e.payload.code}]\x1b[0m\r\n`)
  })

  // xterm → 后端（注：spawning / exited 时屏蔽，避免空 ptyId 或写已死管道）
  tab.onDataDisp = term.onData((data) => {
    if (tab.ptyId === null || tab.processState !== 'alive') return
    tab.lastUserInputAt = Date.now()
    if ((data.includes('\r') || data.includes('\n')) && tab.turnState !== 'blocked') {
      setTurnState(tab, 'working', 'pty')
    }
    setQuietCursor(tab, false)
    const bytes = new TextEncoder().encode(data)
    api.ptyWrite(tab.ptyId, bytesToBase64(bytes)).catch(() => {})
  })

  term.focus()
}

/** 切换激活 tab。`null` = 隐藏 TUI 层，露出 view（聊天/列表/统计/...）。 */
export function setActive(uiId: number | null) {
  activeUiId.value = uiId
}

/** 书签合并到真实项目时，把旧 projectKey 的 tab 迁移到新 key，避免 strip 过滤丢失。 */
export function migrateTabsProjectKey(oldKey: string, newKey: string) {
  for (const tab of tabs.value) {
    if (tab.projectKey === oldKey) {
      tab.projectKey = newKey
    }
  }
}

/** 完全关闭一个 tab：kill PTY、dispose Terminal、移出列表。如果是当前 active 会自动落到邻居。 */
export function closeTabsByProject(projectKey: string) {
  const toClose = tabs.value.filter(t => t.projectKey === projectKey).map(t => t.uiId)
  for (const id of toClose) closeTab(id)
}

export function closeTabBySessionPath(sessionPath: string) {
  const tab = tabs.value.find(t => t.sessionPath === sessionPath)
  if (tab) closeTab(tab.uiId)
}

export function closeTab(uiId: number) {
  const idx = tabs.value.findIndex((t) => t.uiId === uiId)
  if (idx < 0) return
  const tab = tabs.value[idx]
  if (tab.quietCursorTimer !== null) {
    window.clearTimeout(tab.quietCursorTimer)
    tab.quietCursorTimer = null
  }
  tab.onDataDisp?.dispose()
  tab.unlistenData?.()
  tab.unlistenExit?.()
  if (tab.turnWatchPath) {
    api.unwatchSessionTurn(tab.turnWatchPath).catch(() => {})
    tab.turnWatchPath = null
  }
  if (tab.ptyId !== null) {
    api.ptyKill(tab.ptyId).catch(() => {})
  }
  try {
    tab.term.dispose()
  } catch {
    /* 已经 dispose 过 */
  }
  // 从父节点摘掉 container（如果 slot 还挂着它）
  if (tab.container.parentElement) {
    tab.container.parentElement.removeChild(tab.container)
  }

  tabs.value.splice(idx, 1)

  // active fallback：尽量保持视觉连续性 —— 右邻居优先，没有就左邻居，再没有就退到 view。
  if (activeUiId.value === uiId) {
    const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null
    activeUiId.value = next?.uiId ?? null
  }
}

/**
 * 刷新指定 tab（默认当前 active）的尺寸：fit() 之后把新的 cols/rows 推给后端 PTY。
 * 外面用 ResizeObserver / 主题/侧栏切换后调用。失败时静默退出 —— 多数情况下是
 * tab 已经被关掉了，由后续的 close 流程负责清场。
 */
export function refit(uiId?: number) {
  const target = uiId !== undefined ? findTab(uiId) : activeTab()
  if (!target) return
  try {
    target.fitAddon.fit()
  } catch {
    return
  }
  const cols = target.term.cols
  const rows = target.term.rows
  if (
    target.ptyId !== null &&
    cols > 0 &&
    rows > 0 &&
    (cols !== target.lastSyncedCols || rows !== target.lastSyncedRows)
  ) {
    target.lastSyncedCols = cols
    target.lastSyncedRows = rows
    api.ptyResize(target.ptyId, cols, rows).catch(() => {})
  }
}
