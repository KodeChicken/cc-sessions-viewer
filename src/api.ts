import { invoke } from '@tauri-apps/api/core'
import type {
  AccountUsage,
  Agent,
  AgentStats,
  ChatImageInput,
  ClaudeRuntimeInfo,
  ChatStartInfo,
  SlashCommand,
  ProjectInfo,
  SessionPage,
  Msg,
  StatsRange,
  StatsScope,
  TrashItem,
  TrayStats,
  SearchHit,
  UsageSummary,
} from './types'

export interface CodexVisibilityOptions {
  includeCodexInternal?: boolean
  includeCodexArchived?: boolean
}

export const listProjects = (
  agent: Agent,
  options: CodexVisibilityOptions = {},
) =>
  invoke<ProjectInfo[]>('list_projects', {
    agent,
    includeCodexInternal: options.includeCodexInternal ?? false,
    includeCodexArchived: options.includeCodexArchived ?? false,
  })

/** 把原生窗口外观（标题栏 / 失焦红绿灯灰圈）钉到 App 主题。null = 跟随系统。 */
export const setTitlebarTheme = (theme: 'dark' | 'light' | null) =>
  invoke<void>('set_titlebar_theme', { theme })

export const addBookmark = (agent: Agent, path: string) =>
  invoke<void>('add_bookmark', { agent, path })

export const removeBookmark = (agent: Agent, path: string) =>
  invoke<void>('remove_bookmark', { agent, path })

export const listSessions = (
  agent: Agent,
  projectKey: string,
  offset: number,
  limit: number,
  options: CodexVisibilityOptions = {},
) =>
  invoke<SessionPage>('list_sessions', {
    agent,
    projectKey,
    offset,
    limit,
    includeCodexInternal: options.includeCodexInternal ?? false,
    includeCodexArchived: options.includeCodexArchived ?? false,
  })

export const readSession = (agent: Agent, path: string) =>
  invoke<Msg[]>('read_session', { agent, path })

/** 单个会话的 token 用量。Gemini 当前返回零值占位（agent JSONL 还没稳定写）。
 *  后端按 (path, mtime) 缓存，重复调用不会重复扫描文件。 */
export const sessionUsage = (agent: Agent, path: string) =>
  invoke<UsageSummary>('session_usage', { agent, path })

/** 续聊种子：会话最后一条 usage（≈当前上下文规模），区别于 sessionUsage 的累加。 */
export const sessionContextUsage = (agent: Agent, path: string) =>
  invoke<UsageSummary>('session_context_usage', { agent, path })

/** 当前 agent 的统计概览。**兼容入口**，前端 stats 页面默认走 `startAgentStats` 流式
 *  接口；这里保留仅作老回退。 */
export const agentStats = (agent: Agent) =>
  invoke<AgentStats>('agent_stats', { agent })

/** 流式启动一次统计扫描；函数立刻返回。Worker 通过 `stats://progress` / `stats://done` /
 *  `stats://error` 事件 emit 结果，前端用 `useStatsStream` 监听。
 *  `scope`：'all' | 'claude' | 'codex' | 'gemini' | `session:<agent>:<absolutePath>`。
 *  `range`：'today' | 'days7' | 'days30' | 'month' | 'months6'（session-scope 时被忽略）。 */
export const startAgentStats = (
  scope: StatsScope | string,
  range: StatsRange,
  requestId: number,
) => invoke<void>('start_agent_stats', { scope, range, requestId })

/** 立刻取消任何在跑的统计 worker。bump 后端代际计数器 —— 老的 worker 自己 bail。 */
export const cancelStats = () => invoke<void>('cancel_stats')

/** 单调递增的 stats 请求 id 工厂。每次 startAgentStats 前取一个。 */
let _nextStatsId = 0
export function nextStatsRequestId(): number {
  _nextStatsId += 1
  return _nextStatsId
}

/** 跨当前 agent 的项目 / 会话搜索；空字符串返回空数组。
 *  `requestId` 单调递增；后端在循环中比对，更新换代时立刻 bail —— 真正可中断的搜索。
 *  `projectKey` 可选 —— 给会话列表搜索用：只搜当前项目，省掉全局扫描。
 *  实际写：每次新调用前先 `cancelSearch()`，让 CPU 让位给打字。 */
export const searchSessions = (
  agent: Agent,
  query: string,
  requestId: number,
  projectKey?: string,
) =>
  invoke<SearchHit[]>('search_sessions', { agent, query, requestId, projectKey })

/** 立刻取消任何正在跑的全局搜索 —— 仅 bump 后端的代际计数器。 */
export const cancelSearch = () => invoke<void>('cancel_search')

/** 单调自增的搜索 request id 工厂。每次 `searchSessions` 调用前取一个。 */
let _nextSearchId = 0
export function nextSearchRequestId(): number {
  _nextSearchId += 1
  return _nextSearchId
}

export const renameSession = (agent: Agent, path: string, name: string) =>
  invoke<void>('rename_session', { agent, path, name })

export const softDeleteSession = (
  agent: Agent,
  path: string,
  projectLabel: string,
) => invoke<void>('soft_delete_session', { agent, path, projectLabel })

export const listTrash = () => invoke<TrashItem[]>('list_trash')

export const restoreSession = (trashFile: string) =>
  invoke<void>('restore_session', { trashFile })

export const permanentDeleteTrash = (trashFile: string) =>
  invoke<void>('permanent_delete_trash', { trashFile })

export const emptyTrash = () => invoke<void>('empty_trash')

export const revealInFinder = (path: string) =>
  invoke<void>('reveal_in_finder', { path })

/** 打开本地文件；若 path 带 `:line[:column]`，后端会尽量跳到对应位置。 */
export const openLocalPath = (path: string) =>
  invoke<void>('open_local_path', { path })

/** 在系统默认浏览器中打开一个外部链接（仅 http/https）。 */
export const openUrl = (url: string) => invoke<void>('open_url', { url })

/** 写入用户指定的绝对路径（覆盖同名）。返回最终路径以便后续 reveal。 */
export const writeFile = (path: string, content: string) =>
  invoke<string>('write_file', { path, content })

/** Live tail：让后端开始监听一个 JSONL 文件，新增片段会通过 `session:append` 事件
 *  推送过来。同一时刻只有一个 watcher —— 再调一次会自动替换前一个。 */
export const watchSession = (agent: Agent, path: string) =>
  invoke<void>('watch_session', { agent, path })

/** 关闭 Live tail。可重入 —— 没有活跃 watcher 也不会抛错。 */
export const unwatchSession = () => invoke<void>('unwatch_session')

export const terminalTurnSignal = (
  agent: Agent,
  path: string,
  state: 'started' | 'completed' | 'blocked' | 'failed',
) => invoke<void>('terminal_turn_signal', { agent, path, state })

export const installClaudeTurnHooks = () => invoke<string>('install_claude_turn_hooks')
export const claudeRuntimeInfo = () => invoke<ClaudeRuntimeInfo>('claude_runtime_info')

export const watchSessionTurn = (agent: Agent, path: string, catchUp = false) =>
  invoke<void>('watch_session_turn', { agent, path, catchUp })

export const unwatchSessionTurn = (path: string) =>
  invoke<void>('unwatch_session_turn', { path })

export const resumeSession = (
  agent: Agent,
  sessionId: string,
  cwd: string,
  path: string,
  extraArgs?: string,
  terminalApp?: string,
) => invoke<void>('resume_session', { agent, sessionId, cwd, path, extraArgs: extraArgs || '', terminalApp: terminalApp || 'terminal' })

/** 在终端里为某个项目目录开一个全新会话（不带 --resume）。 */
export const newSession = (agent: Agent, cwd: string, extraArgs?: string, terminalApp?: string) =>
  invoke<void>('new_session', { agent, cwd, extraArgs: extraArgs || '', terminalApp: terminalApp || 'terminal' })

/** 检测 macOS 上已安装的外部终端应用（iTerm2 / Ghostty / cmux）。 */
export const detectTerminals = () => invoke<string[]>('detect_terminals')

// ---------- 内嵌 TUI（在窗口里直接跑 resume CLI，配合 xterm.js）----------

/** 拉起一个 PTY 跑 `<shell> -l -c "cd <cwd> && <agent resume CLI>"`，返回 PTY id。
 *  后续通过 `pty://data` 事件接收输出，`ptyWrite` 喂键盘输入，`ptyResize` 跟窗口大小。 */
export const ptySpawn = (
  agent: Agent,
  sessionId: string,
  cwd: string,
  path: string,
  cols: number,
  rows: number,
  extraArgs?: string,
  colorScheme?: 'light' | 'dark',
) => invoke<number>('pty_spawn', {
  agent,
  sessionId,
  cwd,
  path,
  cols,
  rows,
  extraArgs: extraArgs || '',
  colorScheme: colorScheme || 'light',
})

/** 启动一个新会话的 PTY（不带 --resume）。 */
export const ptySpawnNew = (
  agent: Agent,
  cwd: string,
  cols: number,
  rows: number,
  extraArgs?: string,
  colorScheme?: 'light' | 'dark',
) =>
  invoke<number>('pty_spawn_new', {
    agent,
    cwd,
    cols,
    rows,
    extraArgs: extraArgs || '',
    colorScheme: colorScheme || 'light',
  })

/** 启动一个纯 shell PTY（不跑任何 agent CLI）。 */
export const ptySpawnShell = (
  cwd: string,
  cols: number,
  rows: number,
  colorScheme?: 'light' | 'dark',
) =>
  invoke<number>('pty_spawn_shell', {
    cwd,
    cols,
    rows,
    colorScheme: colorScheme || 'light',
  })

/** 把用户的按键 base64 后写进 PTY stdin。 */
export const ptyWrite = (id: number, base64: string) =>
  invoke<void>('pty_write', { id, data: base64 })

/** 容器尺寸变了同步给 PTY，子进程会收到 SIGWINCH 重新布局。 */
export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<void>('pty_resize', { id, cols, rows })

/** 强杀子进程并清理 PTY；幂等，已死的 id 也安全。 */
export const ptyKill = (id: number) => invoke<void>('pty_kill', { id })

// ---------- GUI chat（程序化聊天：管道子进程跑 stream-json）----------

/** 启动一个 GUI chat 子进程，返回 { chatId, processModel }。`sessionId` 给出时续聊既有
 *  会话；`permissionMode` 走后端允许列表（default | acceptEdits | plan | bypassPermissions），
 *  缺省 acceptEdits。`model` / `effort` 缺省走 CLI 自身默认。`processModel` 让前端决定切
 *  设置走 restart-with-resume（长驻）还是下轮 flag（one-shot）。后续通过
 *  `agent-chat://event|init|result|delta|exit|stderr` 事件接收。 */
export const agentChatStart = (
  agent: Agent,
  cwd: string,
  sessionId?: string,
  permissionMode?: string,
  model?: string,
  effort?: string,
) =>
  invoke<ChatStartInfo>('agent_chat_start', {
    agent,
    cwd,
    sessionId,
    permissionMode,
    model,
    effort,
  })

/** 向某个 chat 子进程发送一条用户消息（含可选图片附件 + 本轮 model/effort/权限）。
 *  one-shot agent（Codex）据此每轮切换；长驻 agent（Claude）后端忽略这三者（在 start
 *  已定型，切换走 restart）。 */
export const agentChatSend = (
  id: number,
  text: string,
  images?: ChatImageInput[],
  model?: string,
  effort?: string,
  permissionMode?: string,
) =>
  invoke<void>('agent_chat_send', {
    id,
    text,
    images: images ?? [],
    model,
    effort,
    permissionMode,
  })

/** 结束一个 chat 子进程（kill + 回收）。幂等。 */
export const agentChatStop = (id: number) => invoke<void>('agent_chat_stop', { id })
/** 仅中断当前一轮生成；Claude 长驻 chat 会话继续保活。 */
export const agentChatInterrupt = (id: number) => invoke<void>('agent_chat_interrupt', { id })

/** 拉 GUI chat `/` 浮层的动态指令（磁盘上的自定义命令 / user-invocable skills）。 */
export const agentChatSlashCommands = (agent: Agent, cwd: string) =>
  invoke<SlashCommand[]>('agent_chat_slash_commands', { agent, cwd })

export const trayQuickStats = () => invoke<TrayStats>('tray_quick_stats')

/** 账号额度（5 小时 / 周 / 各模型分项）—— 走 OAuth 用量接口，每窗口含精确利用率 + 重置时间。 */
export const accountUsage = (force = false) => invoke<AccountUsage>('account_usage', { force })

export interface UpdateInfo {
  current: string
  latest: string
  hasUpdate: boolean
  /** GitHub release page URL — present when a remote release was found. */
  htmlUrl?: string
}
export const appVersion = () => invoke<string>('app_version')

// 仓库地址直接写死 —— 与 src/App.vue 里 REPO_URL 同源。GitHub /releases/latest 已经
// 过滤掉 draft / prerelease，所以拿到的就是当前稳定版。Tauri WKWebView 自带 fetch，
// 没有 CSP 限制（tauri.conf.json csp=null），不需要在 Rust 侧加 HTTP client 依赖。
const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/jerrywu001/cc-sessions-viewer/releases/latest'
const RELEASE_PAGE_URL =
  'https://github.com/jerrywu001/cc-sessions-viewer/releases/latest'

interface GitHubRelease {
  tag_name?: string
  html_url?: string
}

function compareVer(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

export async function checkUpdate(): Promise<UpdateInfo> {
  const current = await appVersion()
  const res = await fetch(GITHUB_LATEST_RELEASE_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const release = await res.json() as GitHubRelease
  const latest = release.tag_name?.replace(/^v/i, '')
  if (!latest) return { current, latest: current, hasUpdate: false }
  return {
    current,
    latest,
    hasUpdate: compareVer(latest, current) > 0,
    htmlUrl: release.html_url ?? RELEASE_PAGE_URL,
  }
}
