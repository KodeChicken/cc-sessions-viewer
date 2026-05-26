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
import { theme } from './settings'
import * as api from './api'

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
  /* xterm 实例 —— 用 markRaw() 防 Vue 代理 */
  term: Terminal
  fitAddon: FitAddon
  /** xterm 真正渲染所在的 <div>；切 tab 时把它从 slot 里挪走 / 挪回，不 dispose Terminal */
  container: HTMLDivElement
  unlistenData: UnlistenFn | null
  unlistenExit: UnlistenFn | null
  onDataDisp: { dispose: () => void } | null
  /** 'spawning' 期间不响应键盘，避免空指针；'exited' 后保留 scrollback 直到用户关 */
  status: 'spawning' | 'running' | 'exited' | 'error'
  errorMessage?: string
  exitCode?: number
}

export const tabs = ref<TerminalTab[]>([])
export const activeUiId = ref<number | null>(null)
let nextUiId = 1

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

// 主题切换：把所有活跃 Terminal 的 theme 选项替换；xterm 自己会重绘。
watch(theme, () => {
  const t = xtermTheme(isDarkActive())
  for (const tab of tabs.value) {
    tab.term.options.theme = t
  }
})

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
const findTabBySession = (path: string) =>
  tabs.value.find((t) => t.sessionPath === path && t.status !== 'exited' && t.status !== 'error')

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
      cursorBlink: true,
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
    term,
    fitAddon,
    container,
    unlistenData: null,
    unlistenExit: null,
    onDataDisp: null,
    status: 'spawning',
  }) as TerminalTab
  tabs.value.push(tab)
  activeUiId.value = uiId

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

  let ptyId: number
  try {
    ptyId = isNew
      ? await api.ptySpawnNew(opts.agent, opts.cwd, cols, rows)
      : await api.ptySpawn(
          opts.agent,
          opts.sessionId,
          opts.cwd,
          opts.sessionPath,
          cols,
          rows,
        )
  } catch (e) {
    tab.status = 'error'
    tab.errorMessage = String(e)
    term.write(`\r\n\x1b[31m[error] ${e}\x1b[0m\r\n`)
    return
  }
  tab.ptyId = ptyId
  tab.status = 'running'

  // 后端 → xterm（按 id 过滤多 tab）
  tab.unlistenData = await listen<{ id: number; base64: string }>('pty://data', (e) => {
    if (e.payload.id !== ptyId) return
    term.write(base64ToBytes(e.payload.base64))
  })
  tab.unlistenExit = await listen<{ id: number; code: number }>('pty://exit', (e) => {
    if (e.payload.id !== ptyId) return
    tab.status = 'exited'
    tab.exitCode = e.payload.code
    term.write(`\r\n\x1b[2m[process exited: ${e.payload.code}]\x1b[0m\r\n`)
  })

  // xterm → 后端（注：spawning / exited 时屏蔽，避免空 ptyId 或写已死管道）
  tab.onDataDisp = term.onData((data) => {
    if (tab.ptyId === null || tab.status !== 'running') return
    const bytes = new TextEncoder().encode(data)
    api.ptyWrite(tab.ptyId, bytesToBase64(bytes)).catch(() => {})
  })

  term.focus()
}

/** 切换激活 tab。`null` = 隐藏 TUI 层，露出 view（聊天/列表/统计/...）。 */
export function setActive(uiId: number | null) {
  activeUiId.value = uiId
}

/** 完全关闭一个 tab：kill PTY、dispose Terminal、移出列表。如果是当前 active 会自动落到邻居。 */
export function closeTab(uiId: number) {
  const idx = tabs.value.findIndex((t) => t.uiId === uiId)
  if (idx < 0) return
  const tab = tabs.value[idx]
  tab.onDataDisp?.dispose()
  tab.unlistenData?.()
  tab.unlistenExit?.()
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
  if (target.ptyId !== null && cols > 0 && rows > 0) {
    api.ptyResize(target.ptyId, cols, rows).catch(() => {})
  }
}
