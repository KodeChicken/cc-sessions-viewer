// 全局 GUI chat 会话管理 —— 程序化聊天（stream-json 管道子进程）的前端状态层。
//
// 类比 `terminals.ts`（TUI tabs），但简单得多：没有 xterm，只有一份 reactive `Msg[]`
// 由 `agent-chat://event` 事件累积；`agent-chat://result` 推进 turn 门控；`sendPrompt`
// 把用户消息写进子进程 stdin。渲染完全复用 ChatView 的 `Block` 气泡。
//
// 事件路由：后端事件是全局广播且带 `chatId`，这里在模块加载时**一次性**装好 5 个
// listener，按 chatId 分派到对应会话。由于 `agentChatStart` 解析出 chatId 之前子进程
// 可能已经吐出 system/init —— listener 在 start 之前就已 attach（Tauri 不丢已 attach 的
// 事件），并用 `pendingByChatId` 缓冲「mapping 注册前」到达的事件，注册后回放。
//
// 不持久化：webview 刷新 = 所有 chat 子进程被后端回收。

import { reactive, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import * as api from './api'
import { defaultModel, defaultEffort, effectiveEffort } from './chatComposerOptions'
import { bumpUsage } from './usage'
import type {
  Agent,
  Block,
  ChatDelta,
  ChatDeltaPayload,
  ChatEventPayload,
  ChatExitPayload,
  ChatImageAttachment,
  ChatInitPayload,
  ChatProcessModel,
  ChatResultPayload,
  ChatStderrPayload,
  ChatTurnState,
  Msg,
  UsageSummary,
} from './types'

export interface ChatSession {
  /** 本地稳定 id（v-for / 选中用），与后端 chatId 是两套号。 */
  uiId: number
  /** 后端 chat 子进程 id —— start 解析完成前为 null。 */
  chatId: number | null
  agent: Agent
  /** 所属侧栏项目 key（= ProjectInfo.dirName）。 */
  projectKey: string
  cwd: string
  /** 续聊的源 session id；新开会话在 init 事件里回填。 */
  sessionId: string
  title: string
  /** 会话创建时间（续聊=原会话 created；新开=起聊时刻）。供 ChatView 头部「created」显示。 */
  createdAt?: string
  /** 由事件累积的对话消息，直接喂给 ChatView。 */
  msgs: Msg[]
  /** 本轮问答状态。 */
  turnState: ChatTurnState
  /** 本轮开始时间戳（ms）；turnState='running' 时配合 `now` 算耗时。 */
  turnStartedAt: number
  /** 上一轮耗时（ms），结束后固定显示。 */
  lastTurnMs: number
  /** 进程生命周期。 */
  status: 'spawning' | 'running' | 'exited' | 'error'
  /** 最近一次 result 的 token 用量。 */
  usage?: UsageSummary
  /** 最近一条 assistant 记录的模型全名（如 "claude-opus-4-8"）—— §10.5 上下文窗口换算用。 */
  lastModel?: string
  /** Claude init 的 apiKeySource：'none' = 订阅/OAuth 登录（5h/周限额生效）；其它值
   *  = API key 计费（不受 5h/周窗口约束）→ 前端隐藏限额角标。undefined = 还没拿到 init。 */
  apiKeySource?: string
  errorMessage?: string
  /** stderr 诊断行（封顶，排障用）。 */
  stderrTail: string[]
  /**
   * 正在流式生成的「进行中」文本块（仅 Claude --include-partial-messages）。
   * 与 `msgs` 解耦：每 token 只动这个小对象 → 只重渲染流式气泡，不触发整列表
   * mermaid/高亮重算（见 §10.6 perf 注）。权威 assistant 记录到达即清空（onMsg）。
   */
  live?: { kind: string; text: string } | null
  // ---- §10.2/10.3/10.4 切换器：当前选择（底栏 picker 改它，懒生效）----
  /** 权限模式：plan | acceptEdits | bypassPermissions。默认 acceptEdits。 */
  permissionMode: string
  /** 模型（别名 / 全名）；undefined = 用 CLI/配置默认。 */
  model?: string
  /** reasoning effort 档；undefined = 默认。 */
  effort?: string
  /** 该 agent 的进程模型（start 回填）：决定切设置走 restart 还是下轮 flag。 */
  processModel?: ChatProcessModel
  /** 当前**运行中的长驻进程**实际生效的设置（restart 检测用）。one-shot 不看它。 */
  applied?: { permissionMode: string; model?: string; effort?: string }
  /** 前端主动 stop/restart 旧进程时暂时屏蔽那次 exit，避免把新进程会话误标为 ended。 */
  suppressNextExit?: boolean
}

function claudeApiKeyDisablesEffort(s: Pick<ChatSession, 'agent' | 'apiKeySource'>): boolean {
  return s.agent === 'claude' && typeof s.apiKeySource === 'string' && s.apiKeySource !== '' && s.apiKeySource !== 'none'
}

function sessionEffectiveEffort(s: Pick<ChatSession, 'agent' | 'model' | 'effort' | 'apiKeySource'>): string | undefined {
  if (claudeApiKeyDisablesEffort(s)) return undefined
  return effectiveEffort(s.agent, s.model, s.effort)
}

export function chatEffectiveEffortForTest(
  s: Pick<ChatSession, 'agent' | 'model' | 'effort' | 'apiKeySource'>,
): string | undefined {
  return sessionEffectiveEffort(s)
}

export const chatSessions = ref<ChatSession[]>([])
export const activeChatUiId = ref<number | null>(null)
/** 模块级时钟 —— 任一会话 running 时每 250ms 跳一次，驱动「✳ 4s」计时显示。 */
export const now = ref<number>(0)
let nextUiId = 1

// ============================ 事件路由 ============================

const sessionsByChatId = new Map<number, ChatSession>()
const pendingByChatId = new Map<number, Array<(s: ChatSession) => void>>()

function routeOrBuffer(chatId: number, apply: (s: ChatSession) => void) {
  const s = sessionsByChatId.get(chatId)
  if (s) {
    apply(s)
    return
  }
  const buf = pendingByChatId.get(chatId) ?? []
  buf.push(apply)
  pendingByChatId.set(chatId, buf)
}

function registerChat(chatId: number, s: ChatSession) {
  sessionsByChatId.set(chatId, s)
  const buf = pendingByChatId.get(chatId)
  if (buf) {
    for (const fn of buf) fn(s)
    pendingByChatId.delete(chatId)
  }
}

const STDERR_TAIL_MAX = 50

let listenersInstalled = false
const unlistens: UnlistenFn[] = []

async function ensureListeners(): Promise<void> {
  if (listenersInstalled) return
  listenersInstalled = true
  unlistens.push(
    await listen<ChatEventPayload>('agent-chat://event', (e) =>
      routeOrBuffer(e.payload.chatId, (s) => onMsg(s, e.payload.msg)),
    ),
    await listen<ChatInitPayload>('agent-chat://init', (e) =>
      routeOrBuffer(e.payload.chatId, (s) => onInit(s, e.payload)),
    ),
    await listen<ChatResultPayload>('agent-chat://result', (e) =>
      routeOrBuffer(e.payload.chatId, (s) => onResult(s, e.payload)),
    ),
    await listen<ChatDeltaPayload>('agent-chat://delta', (e) =>
      routeOrBuffer(e.payload.chatId, (s) => onDelta(s, e.payload.delta)),
    ),
    await listen<ChatExitPayload>('agent-chat://exit', (e) =>
      routeOrBuffer(e.payload.chatId, (s) => onExit(s, e.payload)),
    ),
    await listen<ChatStderrPayload>('agent-chat://stderr', (e) =>
      routeOrBuffer(e.payload.chatId, (s) => onStderr(s, e.payload)),
    ),
  )
}

function onMsg(s: ChatSession, msg: Msg) {
  // stream-json 事件没有 JSONL 那样的顶层 timestamp，后端 record_to_msg 给出的是
  // null/undefined → 前端 formatTime(null) 会渲染成「1970-01-01 08:00」。这里补上
  // 「此刻」（消息刚到达的时间），让 live 气泡显示真实时间。
  if (!msg.timestamp) msg.timestamp = new Date().toISOString()
  // 记下模型全名（assistant 记录带 model）→ §10.5 上下文窗口换算。
  if (msg.model) s.lastModel = msg.model
  // 权威记录到达 → 当前块定稿，清掉流式预览（避免预览与真气泡并存）。
  s.live = null
  // stream-json 的每个 assistant / tool_result(user) 事件就是一条完整气泡。
  // **重建数组**（而非 push）：ChatView 的 mermaid / 代码高亮 watcher 按引用比较
  // `props.messages`，只有引用变化才会重跑 —— 与只读模式 reassign chatMsgs 一致。
  s.msgs = [...s.msgs, msg]
}

/**
 * token 级流式增量（仅 Claude）。只对 `text` 块做打字机预览（thinking / tool_use 块
 * 不预览 —— 交给随后的权威 assistant 记录定稿）。只动 `s.live` 这个小对象，不碰 `s.msgs`，
 * 故每 token 不触发整列表重渲染。
 */
function onDelta(s: ChatSession, d: ChatDelta) {
  if (d.phase === 'start') {
    // 仅文本块起预览；thinking / tool_use 不预览（authoritative 记录会补）。
    s.live = d.kind === 'text' ? { kind: 'text', text: '' } : null
  } else if (d.phase === 'delta') {
    if (d.kind === 'text' && d.text) {
      const prev = s.live ?? { kind: 'text', text: '' }
      // 重建对象触发响应式（ChatView 读 liveSession.live.text）。
      s.live = { kind: 'text', text: prev.text + d.text }
    }
  }
  // phase 'stop'：不处理 —— 权威 assistant 记录（onMsg）负责清空 + 定稿。
}

function onInit(s: ChatSession, p: ChatInitPayload) {
  if (p.sessionId && !s.sessionId) s.sessionId = p.sessionId
  // 只认权威 init 给的字符串 apiKeySource（'none' / 'ANTHROPIC_API_KEY' / …）。Claude 的
  // 同 `system` 类型还会发 hook_started / thinking_tokens 等事件，它们没有 apiKeySource
  // （→ null）；若用 `!== undefined` 判断会被这些 null 覆盖回去，导致订阅模式被误判成 API
  // key 而隐藏限额角标。故只在拿到真实字符串时才写入，null/undefined 一律忽略。
  if (typeof p.apiKeySource === 'string' && p.apiKeySource) {
    s.apiKeySource = p.apiKeySource
    if (claudeApiKeyDisablesEffort(s) && s.effort !== undefined) {
      s.effort = undefined
    }
  }
  if (s.status === 'spawning') s.status = 'running'
}

function onResult(s: ChatSession, p: ChatResultPayload) {
  if (p.usage) s.usage = p.usage
  s.live = null // 一轮结束，兜底清掉残留预览。
  endTurn(s)
  // 一轮结束 → 账号 5h/周额度刚被这次对话消耗、值会变 → 事件驱动强制刷新（慢轮询之外的实时补位）。
  bumpUsage()
}

function onExit(s: ChatSession, p: ChatExitPayload) {
  if (s.suppressNextExit) {
    s.suppressNextExit = false
    return
  }
  s.live = null
  endTurn(s)
  if (s.status !== 'error') s.status = 'exited'
  if (p.code !== 0 && !s.errorMessage) {
    s.errorMessage = s.stderrTail.slice(-3).join('\n') || `exited (${p.code})`
  }
}

function onStderr(s: ChatSession, p: ChatStderrPayload) {
  s.stderrTail.push(p.line)
  if (s.stderrTail.length > STDERR_TAIL_MAX) {
    s.stderrTail.splice(0, s.stderrTail.length - STDERR_TAIL_MAX)
  }
}

function appendInterruptedMarker(s: ChatSession) {
  s.msgs = [
    ...s.msgs,
    {
      role: 'user',
      sidechain: false,
      timestamp: new Date().toISOString(),
      blocks: [{ kind: 'text', text: '[Request interrupted by user]', isError: false }],
    },
  ]
}

// ============================ 计时器 ============================

let tick: number | null = null
function ensureTicking() {
  if (tick !== null) return
  now.value = Date.now()
  tick = window.setInterval(() => {
    now.value = Date.now()
    // 没有任何 running 会话时自动停表，省得空转。
    if (!chatSessions.value.some((c) => c.turnState === 'running')) {
      if (tick !== null) {
        clearInterval(tick)
        tick = null
      }
    }
  }, 250)
}

function startTurn(s: ChatSession) {
  s.turnState = 'running'
  s.turnStartedAt = Date.now()
  now.value = Date.now()
  ensureTicking()
}

function endTurn(s: ChatSession) {
  if (s.turnState === 'running') {
    s.lastTurnMs = Date.now() - s.turnStartedAt
  }
  s.turnState = 'idle'
}

// ============================ 查找 ============================

export function findChatByUiId(uiId: number): ChatSession | null {
  return chatSessions.value.find((c) => c.uiId === uiId) ?? null
}

export function activeChat(): ChatSession | null {
  return activeChatUiId.value === null ? null : findChatByUiId(activeChatUiId.value)
}

/** 已为某 sessionPath（续聊源）开过的 live chat —— 入口 2/3 复用，避免重复开。 */
export function findChatBySourceSession(agent: Agent, sessionId: string): ChatSession | null {
  if (!sessionId) return null
  return (
    chatSessions.value.find((c) => c.agent === agent && c.sessionId === sessionId) ?? null
  )
}

// ============================ 开 / 发 / 停 ============================

export interface StartChatOptions {
  agent: Agent
  projectKey: string
  cwd: string
  /** 续聊既有会话时给出；新开会话留空（init 事件回填）。 */
  sessionId?: string
  title: string
  /** 续聊既有会话时传原会话的 created；新开留空（startChat 用当前时刻）。 */
  created?: string
  permissionMode?: string
  /** 初始模型 / effort（可选）；缺省走 CLI 默认。 */
  model?: string
  effort?: string
  /** 续聊种子：原会话末尾的上下文用量，给上下文进度角标兜底，避免刚切过去显示 0%。
   *  首个 result 事件到达后会被真实 usage 覆盖。 */
  initialUsage?: UsageSummary
  /** 续聊既有会话时，预载该会话已有的消息当作历史 transcript 显示。
   *  `--resume` 只在后端续上下文、不会把历史作为事件重放，所以前端必须自己预载，
   *  否则切到 chat 后会是一片空白。新开会话留空。 */
  preloadMsgs?: Msg[]
  /** 开起来立刻发的第一句（可选）。 */
  initialPrompt?: string
  initialImages?: ChatImageAttachment[]
}

/**
 * 起一个 GUI chat 会话：建 reactive session → 装 listener（若未装）→ `agentChatStart`
 * 拿 chatId → 注册路由 → 可选发首条消息。失败时 status='error'，会话仍留在列表里。
 */
export async function startChat(opts: StartChatOptions): Promise<ChatSession> {
  await ensureListeners()

  const uiId = nextUiId++
  const session = reactive<ChatSession>({
    uiId,
    chatId: null,
    agent: opts.agent,
    projectKey: opts.projectKey,
    cwd: opts.cwd,
    sessionId: opts.sessionId ?? '',
    title: opts.title,
    createdAt: opts.created ?? new Date().toISOString(),
    msgs: opts.preloadMsgs ? [...opts.preloadMsgs] : [],
    turnState: 'idle',
    turnStartedAt: 0,
    lastTurnMs: 0,
    status: 'spawning',
    stderrTail: [],
    live: null,
    permissionMode: opts.permissionMode ?? 'acceptEdits',
    // 「不存在 default」：每个会话起步即带一个明确模型 + effort（用户可改）。
    model: opts.model ?? defaultModel(opts.agent),
    effort: opts.effort ?? defaultEffort(opts.agent),
    // 续聊种子：原会话末尾上下文规模，首个 result 到达前给进度角标兜底。
    usage: opts.initialUsage,
  }) as ChatSession
  chatSessions.value.push(session)
  activeChatUiId.value = uiId

  try {
    // Haiku 等不支持 effort 的模型省掉 --effort（effectiveEffort → undefined）。
    const eff = sessionEffectiveEffort(session)
    const info = await api.agentChatStart(
      opts.agent,
      opts.cwd,
      opts.sessionId,
      session.permissionMode,
      session.model,
      eff,
    )
    session.chatId = info.chatId
    session.processModel = info.processModel
    // 记下这套进程实际起在哪个设置上（restart 检测基线）。
    session.applied = {
      permissionMode: session.permissionMode,
      model: session.model,
      effort: eff,
    }
    registerChat(info.chatId, session)
    if (session.status === 'spawning') session.status = 'running'

    if (opts.initialPrompt || (opts.initialImages && opts.initialImages.length)) {
      await sendPrompt(session, opts.initialPrompt ?? '', opts.initialImages ?? [])
    }
  } catch (err) {
    session.status = 'error'
    session.errorMessage = String(err)
  }
  return session
}

/** 发送一条用户消息：本地立即回显成一条 user 气泡 → 置 running → 写进子进程 stdin。 */
export async function sendPrompt(
  session: ChatSession,
  text: string,
  images: ChatImageAttachment[] = [],
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed && images.length === 0) return
  if (session.chatId === null || session.status === 'exited' || session.status === 'error') {
    return
  }

  // 本地回显（与离线回看同形：image 块 + text 块）。
  const blocks: Block[] = []
  for (const img of images) {
    blocks.push({ kind: 'image', imageSrc: img.dataUrl, isError: false })
  }
  if (trimmed) {
    blocks.push({ kind: 'text', text: trimmed, isError: false })
  }
  // 重建数组（理由同 onMsg）；带上「此刻」时间戳，否则 user 气泡时间显示成「—」。
  session.msgs = [
    ...session.msgs,
    { role: 'user', sidechain: false, blocks, timestamp: new Date().toISOString() },
  ]

  // 长驻进程（Claude）：模型/effort/权限在进程 start 时已定型，若用户改了就先
  // restart-with-resume 换新进程再发；one-shot（Codex）不用 restart —— 设置随这一轮
  // 的 agentChatSend 下发，下一轮带新 flag 即生效。
  if (session.processModel === 'longLivedStdin' && settingsChanged(session)) {
    const ok = await restartChat(session)
    if (!ok) return // restart 失败：status 已置 error
  }

  const chatId = session.chatId
  if (chatId === null) return // restart 兜底：进程没起来就别发

  startTurn(session)
  try {
    await api.agentChatSend(
      chatId,
      trimmed,
      images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      session.model,
      sessionEffectiveEffort(session),
      session.permissionMode,
    )
  } catch (err) {
    endTurn(session)
    session.status = 'error'
    session.errorMessage = String(err)
  }
}

/** 运行中的长驻进程实际生效的设置，与当前选择是否已不一致（需 restart 才能换）。 */
function settingsChanged(s: ChatSession): boolean {
  const a = s.applied
  if (!a) return false
  return (
    a.permissionMode !== s.permissionMode ||
    a.model !== s.model ||
    a.effort !== sessionEffectiveEffort(s)
  )
}

/**
 * §10.0 restart-with-resume：停掉旧长驻进程，用当前 model/effort/权限重起一个 `--resume`
 * 既有 session 的新进程，热替换 `chatId` 并重注册路由（`msgs` 原样保留）。one-shot
 * agent 无需 restart（直接返回 true）。返回 false 表示 restart 失败（已置 error）。
 */
async function restartChat(s: ChatSession): Promise<boolean> {
  if (s.processModel !== 'longLivedStdin' || s.chatId === null) return true
  const old = s.chatId
  try {
    sessionsByChatId.delete(old)
    await api.agentChatStop(old)
    // 有源 session id 就 --resume 续上下文；还没有（首轮 init 未回填）就全新起，
    // 反正此时也没历史可丢，新 flag 直接生效。
    const eff = sessionEffectiveEffort(s)
    const info = await api.agentChatStart(
      s.agent,
      s.cwd,
      s.sessionId || undefined,
      s.permissionMode,
      s.model,
      eff,
    )
    s.chatId = info.chatId
    s.processModel = info.processModel
    s.applied = { permissionMode: s.permissionMode, model: s.model, effort: eff }
    registerChat(info.chatId, s)
    return true
  } catch (err) {
    s.status = 'error'
    s.errorMessage = String(err)
    return false
  }
}

/** 中止当前轮 / 结束会话进程，但**保留**会话与已有 transcript（不从列表移除）。
 *  MVP 没有「不杀进程的软中断」，stop = kill 子进程 → 会话进入 exited，输入禁用。 */
export async function stopChat(session: ChatSession): Promise<void> {
  if (session.chatId !== null) {
    try {
      await api.agentChatStop(session.chatId)
    } catch {
      /* 幂等 */
    }
  }
  endTurn(session)
  if (session.status !== 'error') session.status = 'exited'
}

/** 中断当前这一轮回复，但保留 chat 会话继续可发。Claude 映射到 CLI 的 Esc。 */
export async function interruptChat(session: ChatSession): Promise<void> {
  if (session.chatId === null) return
  if (session.processModel === 'longLivedStdin') {
    const old = session.chatId
    try {
      // TODO：这里**故意丢弃**当前 live 流式内容，只保留一条 interrupted marker。
      //
      // 原因：Claude 的 headless stream-json 模式并不会像交互式 TTY 那样，在用户中断时把
      // 「已经流出来但尚未定稿」的半成品 assistant 内容可靠地写进 transcript/JSONL。
      // 如果前端擅自把那段 live 文本塞进 msgs，live 视图看起来像保留住了内容，但一旦切到
      // read 模式或刷新页面（它们重新 read_session 只认磁盘上的真实 transcript），那段
      // 内容就会消失，形成前后不一致的“假象”。这里宁可少显示，也要保证 live/read/刷新
      // 三者都只基于真实可重放的数据。
      appendInterruptedMarker(session)
      session.suppressNextExit = true
      sessionsByChatId.delete(old)
      pendingByChatId.delete(old)
      await api.agentChatStop(old)
      const eff = sessionEffectiveEffort(session)
      const info = await api.agentChatStart(
        session.agent,
        session.cwd,
        session.sessionId || undefined,
        session.permissionMode,
        session.model,
        eff,
      )
      session.chatId = info.chatId
      session.processModel = info.processModel
      session.applied = {
        permissionMode: session.permissionMode,
        model: session.model,
        effort: eff,
      }
      registerChat(info.chatId, session)
      endTurn(session)
      session.live = null
      session.status = 'running'
      return
    } catch (err) {
      session.suppressNextExit = false
      session.status = 'error'
      session.errorMessage = String(err)
      endTurn(session)
      return
    }
  }
  try {
    await api.agentChatInterrupt(session.chatId)
    endTurn(session)
    session.live = null
    if (session.status === 'spawning') session.status = 'running'
  } catch (err) {
    session.status = 'error'
    session.errorMessage = String(err)
    endTurn(session)
  }
}

/** 关闭并回收一个 chat 会话：停进程、解路由、从列表移除。 */
export async function closeChat(uiId: number): Promise<void> {
  const idx = chatSessions.value.findIndex((c) => c.uiId === uiId)
  if (idx === -1) return
  const session = chatSessions.value[idx]
  if (session.chatId !== null) {
    sessionsByChatId.delete(session.chatId)
    pendingByChatId.delete(session.chatId)
    try {
      await api.agentChatStop(session.chatId)
    } catch {
      /* 幂等：已死的 id 也安全 */
    }
  }
  chatSessions.value.splice(idx, 1)
  if (activeChatUiId.value === uiId) {
    activeChatUiId.value = chatSessions.value.length ? chatSessions.value[0].uiId : null
  }
}

export function setActiveChat(uiId: number | null) {
  activeChatUiId.value = uiId
}
