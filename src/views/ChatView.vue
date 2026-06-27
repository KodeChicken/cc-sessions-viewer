<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Agent, Msg, SessionMeta, Block } from '../types'
import { renderText, formatTime, isCaveatOnlyMsg, parseSystemEvent, cleanMetaText, metaKindIsPre, parseMetaFields, parseTeammateMessage, stripImagePlaceholders } from '../format'
import type { MetaField } from '../format'
import { prettifyAndHighlightJson } from '../jsonHighlight'
import { renderAllMermaid, resetMermaidForTheme } from '../mermaid'
import { highlightAllCodeBlocks, rehighlightAllCodeBlocks } from '../shikiHighlight'
import { decorateCodeBlocks } from '../codeCopy'
import { theme } from '../settings'
import { t } from '../i18n'
import ToolResult from '../components/ToolResult.vue'
import CollapsibleBox from '../components/CollapsibleBox.vue'
import VueEasyLightbox from 'vue-easy-lightbox'
import { highlightDiff, looksLikeDiff } from '../diffHighlight'
import { renderCodexApplyPatchHtml } from '../codexApplyPatch'
import {
  search,
  searchCount,
  searchIndex,
  searchScope,
  setSearchNavigator,
  toolsCollapsed,
} from '../chatToolbar'
import {
  IconArrowLeft,
  IconRefresh,
  IconTrash,
  IconRestore,
  IconPlay,
  IconFolder,
  IconArrowUp,
  IconArrowDown,
  IconChevronRight,
  IconPencil,
  IconCopy,
  IconCheck,
  IconDownload,
  IconMarkdown,
  IconHtml,
  IconJson,
  IconChart,
  IconFold,
  IconUnfold,
  IconLocate,
  IconEyeOff,
  IconEye,
  IconChat,
  IconReader,
  IconStar,
  agentIcons,
} from '../components/icons'
import ChatComposer from '../components/ChatComposer.vue'
import { now as chatNow, type ChatSession } from '../chatSessions'

const props = defineProps<{
  agent: Agent
  session: SessionMeta
  messages: Msg[]
  /** 会话来自回收站 —— 只读查看，隐藏 重命名/恢复终端/删除/导出/统计 等操作。 */
  trashed?: boolean
  /** Live tail 状态：后端正在追这条 JSONL；为 true 时显示 "● Live" 徽章。 */
  live?: boolean
  /** Resume CLI 时使用的 cwd。空字符串时禁用「在窗口内对话」按钮。 */
  cwd?: string
  /** 非空 = live GUI chat 模式：底部挂 ChatComposer、隐藏只读专属操作按钮，
   *  `messages` 由父组件传入活跃会话的 reactive `msgs`。 */
  liveSession?: ChatSession | null
  /** live 模式下是否有「来源只读会话」可回看 —— 有才显示头部「切到 read」按钮。 */
  hasReadView?: boolean
  /** 当前会话是否已收藏进「Views」历史 —— 决定头部星标实心 / 空心。 */
  favorited?: boolean
  /** 是否允许收藏（普通项目会话才可；回收站 / 导出历史 / 无 path 的 live chat 不可）。 */
  canFavorite?: boolean
}>()

defineEmits<{
  back: []
  refresh: []
  delete: []
  /** 入口 2：让父组件 openOrFocusTui，开（或聚焦已有）一个 TUI tab。 */
  resumeHere: []
  /** 入口 3：把当前只读会话就地切到 GUI chat 模式。 */
  switchToChat: []
  /** live chat 头部：切回来源会话的只读详情（read 模式），进程不停。 */
  switchToRead: []
  rename: []
  reveal: []
  copyId: []
  exportMd: []
  exportHtml: []
  exportJson: []
  restore: []
  /** 打开会话统计页 —— 原本住在 ChatTopbar 里，现挪进 chat-head 减少
   *  topbar + chat-head 两排 icon-only 按钮重叠的扫描负担。 */
  openSessionStats: []
  /** 头部星标：把当前会话收藏 / 取消收藏到「Views」历史。 */
  toggleFavorite: []
}>()

/** live 模式当前轮已运行秒数（由 chatSessions 的模块时钟驱动）。 */
const runningElapsedSec = computed(() => {
  const s = props.liveSession
  if (!s || s.turnState !== 'running') return 0
  return Math.max(0, Math.floor((chatNow.value - s.turnStartedAt) / 1000))
})

function toggleTools() {
  toolsCollapsed.value = !toolsCollapsed.value
}

// Resume 按钮是否可用：回收站、缺 session id、缺 cwd 时禁用。
const canResumeHere = computed(
  () => !props.trashed && !!props.session.id && !!props.cwd,
)

function shortId(id: string): string {
  if (!id) return ''
  return id.length > 8 ? id.slice(0, 8) : id
}

function isToolOnly(m: Msg): boolean {
  return m.role === 'user' && m.blocks.every((b) => b.kind === 'tool_result')
}

function toolLabel(b: Block): string {
  if (b.kind === 'tool_use') return t('tool.call', { name: b.toolName ?? '' })
  if (b.kind === 'thinking') return t('tool.thinking')
  return ''
}

function isCodexInlineCodeToolUse(b: Block): boolean {
  return props.agent === 'codex' && b.kind === 'tool_use' && b.toolName === 'apply_patch'
}

function renderNumberedCodeHtml(html: string): string {
  const lines = html.split('\n')
  return lines
    .map((line, i) => {
      const content = line || '&nbsp;'
      return `<div class="inline-code-line"><span class="inline-code-no">${i + 1}</span><span class="inline-code-text">${content}</span></div>`
    })
    .join('')
}

function toolUseCodeHtml(b: Block): string {
  const input = b.toolInput ?? ''
  if (isCodexInlineCodeToolUse(b)) {
    const rendered = renderCodexApplyPatchHtml(input, props.cwd)
    if (rendered) return rendered
  }
  const highlighted = looksLikeDiff(input)
    ? highlightDiff(input)
    : prettifyAndHighlightJson(input)
  return renderNumberedCodeHtml(highlighted)
}

function isCodexApplyPatchStructured(b: Block): boolean {
  return isCodexInlineCodeToolUse(b) && !!renderCodexApplyPatchHtml(b.toolInput ?? '', props.cwd)
}

function toolUseCodeClass(b: Block): string[] {
  if (isCodexApplyPatchStructured(b)) return ['codex-apply-patch']
  return ['code-block', looksLikeDiff(b.toolInput ?? '') ? 'lang-diff' : 'lang-json']
}

// 这几个工具会让 tool_result 携带 structuredPatch / 文件 diff，需要单独以
// 一个块呈现，便于一眼看到改动；其它工具（Read / Bash / TaskUpdate / Grep …）
// 的结果只是文本输出，嵌入到 Tool call 内部更紧凑。
const FILE_MUTATING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
])

// 搜索范围分类 —— 给 .msg-row / tool_use <details> 打 data-search-scope，
// applySearch 沿祖先链找最近的 scope 决定是否收录该文本节点。
//   'user' / 'assistant'：用户消息 / 助手文本（含 thinking）
//   'tools-edit'：文件改动型工具（与 'agent' 选项合并）
//   'tools-other'：其它工具调用（与 'tools' 选项匹配）
function rowScope(m: Msg): string {
  // tool-only 行只在 FILE_MUTATING_TOOLS 的 tool_result 拆出来时出现，所以一定是 edit 类
  if (isToolOnly(m)) return 'tools-edit'
  // 系统注入块不是用户 prose 也不是助手回复 —— 给个独立 scope，只在「全部」筛选下命中。
  if (m.metaKind) return 'meta'
  return m.role
}
function toolUseScope(b: Block): string {
  return FILE_MUTATING_TOOLS.has(b.toolName ?? '') ? 'tools-edit' : 'tools-other'
}

const resultByToolId = computed(() => {
  const map = new Map<string, Block>()
  for (const m of props.messages) {
    for (const b of m.blocks) {
      if (b.kind === 'tool_result' && b.toolId) map.set(b.toolId, b)
    }
  }
  return map
})

const toolUseById = computed(() => {
  const map = new Map<string, Block>()
  for (const m of props.messages) {
    for (const b of m.blocks) {
      if (b.kind === 'tool_use' && b.toolId) map.set(b.toolId, b)
    }
  }
  return map
})

const inlinedResultIds = computed(() => {
  const set = new Set<string>()
  for (const m of props.messages) {
    for (const b of m.blocks) {
      if (
        b.kind === 'tool_use' &&
        b.toolId &&
        !FILE_MUTATING_TOOLS.has(b.toolName ?? '') &&
        resultByToolId.value.has(b.toolId)
      ) {
        set.add(b.toolId)
      }
    }
  }
  return set
})

function inlinedResultFor(b: Block): Block | undefined {
  if (b.kind !== 'tool_use' || !b.toolId) return undefined
  if (!inlinedResultIds.value.has(b.toolId)) return undefined
  return resultByToolId.value.get(b.toolId)
}

function isInlinedResult(b: Block): boolean {
  return b.kind === 'tool_result' && !!b.toolId && inlinedResultIds.value.has(b.toolId)
}

// 文件改动型 tool_result（structuredPatch diff）整块挂回发起它的 assistant tool_use 行内：
// 渲染在气泡下方、时间行上方，让「Tool call · Edit + File change + 时间」成为同一条消息的
// 整体（之前 diff 自成一行、时间夹在调用卡与 diff 之间，看着像断开两段）。其独立 tool-only
// 行随之隐藏。与 inlinedResult* 互斥：非文件改动型仍内嵌进调用卡。
const attachedResultIds = computed(() => {
  const set = new Set<string>()
  for (const m of props.messages) {
    for (const b of m.blocks) {
      if (
        b.kind === 'tool_use' &&
        b.toolId &&
        FILE_MUTATING_TOOLS.has(b.toolName ?? '') &&
        resultByToolId.value.has(b.toolId)
      ) {
        set.add(b.toolId)
      }
    }
  }
  return set
})

function attachedResultFor(b: Block): Block | undefined {
  if (b.kind !== 'tool_use' || !b.toolId) return undefined
  if (!attachedResultIds.value.has(b.toolId)) return undefined
  return resultByToolId.value.get(b.toolId)
}

function isAttachedResult(b: Block): boolean {
  return b.kind === 'tool_result' && !!b.toolId && attachedResultIds.value.has(b.toolId)
}

function shouldHideToolResult(b: Block): boolean {
  if (b.kind !== 'tool_result' || !b.toolId) return false
  const toolUse = toolUseById.value.get(b.toolId)
  return !!toolUse && isCodexInlineCodeToolUse(toolUse)
}

function rowHasContent(m: Msg): boolean {
  // Local-command caveat user messages are pure plumbing — hide the row entirely.
  if (isCaveatOnlyMsg(m)) return false
  if (!isToolOnly(m)) return true
  return m.blocks.some((b) => !isInlinedResult(b) && !isAttachedResult(b) && !shouldHideToolResult(b))
}

// ---- 图片：缩略图浮在气泡上方（参考 Claude 客户端），不进灰底气泡 ----
function imageBlocks(m: Msg): Block[] {
  return m.blocks.filter((b) => b.kind === 'image' && b.imageSrc)
}
// 带图消息的正文要滤掉 [Image #n] 占位符（缩略图已单独展示）；无图消息原样渲染，
// 免得误删正文里对图片的文字引用。
function bubbleText(m: Msg, raw: string): string {
  return imageBlocks(m).length ? stripImagePlaceholders(raw) : raw
}
// 气泡是否还有非图片正文 —— 纯图片消息不渲染空灰泡，只留上方缩略图。
function hasBubbleBody(m: Msg): boolean {
  return m.blocks.some((b) => {
    if (b.kind === 'image') return false
    if (b.kind === 'text') return bubbleText(m, b.text ?? '').trim().length > 0
    return true
  })
}


// ---- 消息右键隐藏 ----
// 按 session path 在 localStorage 中存一组隐藏的消息标识（uuid 或索引）。
// 隐藏状态纯前端，不修改 JSONL 文件，三个 agent 通用。
function hiddenStorageKey(): string {
  return `hidden:${props.session.path}`
}
function loadHiddenSet(): Set<string> {
  try {
    const raw = localStorage.getItem(hiddenStorageKey())
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}
function saveHiddenSet(set: Set<string>) {
  if (set.size === 0) {
    localStorage.removeItem(hiddenStorageKey())
  } else {
    localStorage.setItem(hiddenStorageKey(), JSON.stringify([...set]))
  }
}

const hiddenIds = ref<Set<string>>(new Set())
const showHidden = ref(false)

function msgKey(m: Msg, idx: number): string {
  return m.uuid || `idx:${idx}`
}

function isHidden(m: Msg, idx: number): boolean {
  return hiddenIds.value.has(msgKey(m, idx))
}

const hiddenCount = computed(() => hiddenIds.value.size)

function toggleHideMsg(m: Msg, idx: number) {
  const key = msgKey(m, idx)
  const set = new Set(hiddenIds.value)
  if (set.has(key)) {
    set.delete(key)
  } else {
    set.add(key)
  }
  hiddenIds.value = set
  saveHiddenSet(set)
}

// 当前悬停的消息键。用 JS 状态而非纯 CSS :hover 来驱动操作行的显隐——live chat 流式
// 重渲染时 Chromium 的 :hover 伪类可能「粘」在旧行上，导致多行操作行同时常亮、移走也不
// 收（用户反馈：hover A 再 hover 别的都不自动隐藏）。改成 mouseenter/leave 维护单一键，
// 任一时刻只有一行 row-active，互斥且确定性收起。
const hoveredKey = ref<string | null>(null)

// ---- 消息悬停操作：复制原文 ----
// 复制成功后短暂把对应消息的图标切成对勾（按 msgKey 记一个键，避免影响其它消息）。
const copiedMsgKey = ref<string | null>(null)
let copiedResetTimer = 0
function copyMsg(m: Msg, idx: number) {
  const text = m.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.text ?? '')
    .join('\n\n')
    .trim()
  if (!text) return
  void navigator.clipboard?.writeText(text)
  const key = msgKey(m, idx)
  copiedMsgKey.value = key
  window.clearTimeout(copiedResetTimer)
  copiedResetTimer = window.setTimeout(() => {
    if (copiedMsgKey.value === key) copiedMsgKey.value = null
  }, 1200)
}

// 切换会话时重新加载隐藏集合
watch(
  () => props.session.path,
  () => {
    hiddenIds.value = loadHiddenSet()
    showHidden.value = false
  },
  { immediate: true },
)

// 隐藏消息现由气泡下方的悬停操作行接管；右键恢复浏览器默认行为（选中复制等），
// 不再弹自定义菜单。

const assistantName = computed(() =>
  props.agent === 'codex'
    ? 'Codex'
    : props.agent === 'gemini'
      ? 'Gemini'
      : 'Claude',
)

function systemEventLabel(m: Msg): string | null {
  const ev = parseSystemEvent(m)
  if (!ev) return null
  if (ev.kind === 'rename') return t('chat.systemEvent.rename', { name: ev.name })
  if (ev.kind === 'interrupt') return t('chat.systemEvent.interrupted')
  return null
}

// 系统注入的 user 记录（metaKind）—— 后端 claude 源打的标记。映射到本地化标题，
// 前端据此把它们渲染成低调的「系统」块而非「Me」气泡。
const META_KIND_KEY: Record<string, string> = {
  compact: 'chat.metaKind.compact',
  meta: 'chat.metaKind.meta',
  'task-notification': 'chat.metaKind.taskNotification',
  system: 'chat.metaKind.system',
  'command-output': 'chat.metaKind.commandOutput',
  'teammate-message': 'chat.metaKind.teammateMessage',
}
function metaKindLabel(kind: string | undefined): string {
  if (!kind) return ''
  return t(META_KIND_KEY[kind] ?? 'chat.metaKind.system')
}
// 该消息的 metaKind 是否以等宽 <pre> 呈现（undefined-safe 包装，便于模板调用）。
function metaIsPre(m: Msg): boolean {
  return !!m.metaKind && metaKindIsPre(m.metaKind)
}
// metaKind 块里每个文本块的渲染：command-output / 通知类去壳 + ANSI 后以等宽
// <pre> 原样呈现；compact / meta 本身是 markdown，走常规 renderText。
function metaBlockHtml(kind: string | undefined, text: string): string {
  if (kind && metaKindIsPre(kind)) return cleanMetaText(text)
  return renderText(text)
}
// 把 metaKind 正文解析成 key/value 字段供模板格式化渲染：先试通用 <tag>value</tag>
// 结构（任务通知），再试 teammate-message 结构（多 agent 协作消息）。都不匹配
// （命令输出等纯文本）返回 null，交给 <pre> / markdown 分支。
function metaFieldsOf(text: string): MetaField[] | null {
  return parseMetaFields(text) ?? parseTeammateMessage(text)
}

const stats = computed(() => {
  const u = props.messages.filter(
    (m) =>
      m.role === 'user' &&
      !m.metaKind &&
      !isToolOnly(m) &&
      !isCaveatOnlyMsg(m) &&
      !systemEventLabel(m),
  ).length
  const a = props.messages.filter((m) => m.role === 'assistant').length
  return { u, a }
})

const lightboxVisible = ref(false)
const lightboxImgs = ref<string[]>([])
const lightboxIndex = ref(0)
// 同一条消息的多张图片整组进灯箱，点哪张就从哪张开始，可左右翻看。
function openLightbox(imgs: string[], index = 0) {
  lightboxImgs.value = imgs
  lightboxIndex.value = index
  lightboxVisible.value = true
}

const scrollEl = ref<HTMLElement>()

// 自定义 rAF 平滑滚动：原生 behavior:'smooth' 在长会话里会随距离把动画拉长，
// 每帧又触发大段 reflow，所以 420 条消息时就会卡。这里用固定时长 + ease-out，
// 并在用户滚动/再次点击时打断。
let scrollRAF = 0
let pinRAF = 0
function cancelScroll() {
  if (scrollRAF) {
    cancelAnimationFrame(scrollRAF)
    scrollRAF = 0
  }
  if (pinRAF) {
    cancelAnimationFrame(pinRAF)
    pinRAF = 0
  }
}

// live GUI chat 专用：把视口「钉」在底部一小段时间。进入会话（预载历史）/ 新消息
// 到达后，代码高亮 / DiffBlock / 图片会异步把内容撑高 —— 单次 scrollToBottom 会
// 因为 scrollHeight 还在涨而停在半路。这里每帧重读 scrollHeight 跳到底，持续 ms 毫秒，
// 直到高度稳定。用户一旦主动滚动（wheel/touch）立即放手，绝不和用户抢滚动条。
function pinToBottomFor(ms: number) {
  const el = scrollEl.value
  if (!el) return
  cancelScroll()
  const until = performance.now() + ms
  const release = () => {
    cancelScroll()
    el.removeEventListener('wheel', release)
    el.removeEventListener('touchmove', release)
  }
  const stick = () => {
    const e = scrollEl.value
    if (!e) {
      pinRAF = 0
      return
    }
    e.scrollTop = e.scrollHeight
    if (performance.now() < until) {
      pinRAF = requestAnimationFrame(stick)
    } else {
      pinRAF = 0
      el.removeEventListener('wheel', release)
      el.removeEventListener('touchmove', release)
    }
  }
  el.addEventListener('wheel', release, { passive: true, once: true })
  el.addEventListener('touchmove', release, { passive: true, once: true })
  pinRAF = requestAnimationFrame(stick)
}
function smoothScrollTo(target: number) {
  const el = scrollEl.value
  if (!el) return
  cancelScroll()
  const start = el.scrollTop
  const dest = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight))
  const dist = dest - start
  if (Math.abs(dist) < 2) {
    el.scrollTop = dest
    return
  }
  // 距离越长动画稍微拉长一点，但封顶 360ms，避免长会话拖沓
  const duration = Math.min(360, 180 + Math.abs(dist) * 0.05)
  const t0 = performance.now()
  // easeOutCubic
  const ease = (p: number) => 1 - Math.pow(1 - p, 3)
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration)
    el.scrollTop = start + dist * ease(p)
    if (p < 1) {
      scrollRAF = requestAnimationFrame(step)
    } else {
      scrollRAF = 0
    }
  }
  // 用户主动滚动则中断
  const onUserScroll = () => {
    cancelScroll()
    el.removeEventListener('wheel', onUserScroll)
    el.removeEventListener('touchmove', onUserScroll)
  }
  el.addEventListener('wheel', onUserScroll, { passive: true, once: true })
  el.addEventListener('touchmove', onUserScroll, { passive: true, once: true })
  scrollRAF = requestAnimationFrame(step)
}
function scrollToTop() {
  smoothScrollTo(0)
}
function scrollToBottom() {
  const el = scrollEl.value
  if (el) smoothScrollTo(el.scrollHeight)
}

// 跳转到某条消息：滚到对应 .msg-row，触发一次 .msg-flash 闪烁动画。
// 全局搜索点击命中后被 App.vue 通过 defineExpose 调用。idx 与 uuid 双兜底
// —— uuid 在场用 uuid 找（更稳，能扛重排），否则按 data-msg-idx 找。
//
// 长会话的滚动「不准」问题：
//   1) chatMsgs 被赋值后，巨型 v-for 要一两帧才把 .msg-row 真正挂上 DOM；
//   2) 挂上之后，里头的代码高亮 / DiffBlock / 图片还会异步把内容塞进去，
//      命中行的 offsetTop 会继续往下推。
// 应对：先「等 row 出现」最多 ~500ms；找到之后启动一个 rAF 循环，每帧重读
// offsetTop 让滚动追上后涨的高度；动画窗口（~360ms）结束后再校准 ~1.2s。
// 任何 wheel / pointerdown / keydown 都立即让位，绝不和用户抢滚动条。
const flashIdx = ref<number | null>(null)
let flashTimer = 0
let flashStickCleanup: (() => void) | null = null
function cancelFlashStick() {
  flashStickCleanup?.()
}
function flashMessage(idx: number, uuid?: string) {
  const inner = innerEl.value
  const sa = scrollEl.value
  if (!inner || !sa) return
  const findRow = () =>
    (uuid
      ? inner.querySelector<HTMLElement>(`.msg-row[data-msg-uuid="${CSS.escape(uuid)}"]`)
      : null) ?? inner.querySelector<HTMLElement>(`.msg-row[data-msg-idx="${idx}"]`)

  // 先取消上一个跳转的尾巴 + 任何在跑的平滑滚动。
  cancelFlashStick()
  cancelScroll()

  // Step 1：等 row 挂上 DOM —— readSession 返回后大长 v-for 通常 1-2 帧搞定，
  // 但留 30 帧（≈500ms）兜底，超过仍找不到就放弃。
  let waitFrames = 0
  const start = () => {
    const first = findRow()
    if (!first) {
      if (++waitFrames > 30) return
      requestAnimationFrame(start)
      return
    }
    run(first)
  }

  // Step 2：自带 rAF 循环 —— 不复用 smoothScrollTo，因为它把目标缓存为常量，
  // 长会话里目标会随子组件渲染往下挪，必须每帧重新读 offsetTop。
  const run = (first: HTMLElement) => {
    const startScroll = sa.scrollTop
    const firstTarget = Math.max(0, first.offsetTop - 80)
    const initDist = firstTarget - startScroll
    const duration = Math.min(360, 180 + Math.abs(initDist) * 0.05)
    const ease = (p: number) => 1 - Math.pow(1 - p, 3)
    const t0 = performance.now()
    // 总「贴靠」时长：动画 ~360ms + 校准 ~1.2s。校准期是为了等图片 / 代码块
    // 异步渲染完后还能把命中行拉回正确位置。
    const STICK_MS = 1600

    let userBailed = false
    const onUserInput = () => {
      userBailed = true
    }
    sa.addEventListener('wheel', onUserInput, { passive: true })
    sa.addEventListener('pointerdown', onUserInput, { passive: true })
    sa.addEventListener('keydown', onUserInput)

    let raf = 0
    const tick = () => {
      if (userBailed) return cleanup()
      const now = performance.now()
      const elapsed = now - t0
      if (elapsed > STICK_MS) return cleanup()

      // 每帧重新拿引用：keep-alive 之类的边界场景下 row 节点可能被换掉。
      const cur = findRow()
      if (!cur) {
        raf = requestAnimationFrame(tick)
        return
      }
      const target = Math.max(0, cur.offsetTop - 80)

      if (elapsed < duration) {
        // 动画阶段：用 ease 平滑滚到 target；target 每帧都重新读，自然追得上后涨高度
        const p = elapsed / duration
        sa.scrollTop = startScroll + (target - startScroll) * ease(p)
      } else {
        // 校准阶段：层出不穷的 1-2 像素抖动忽略；只在偏差明显时硬对齐
        if (Math.abs(sa.scrollTop - target) > 1) sa.scrollTop = target
      }
      raf = requestAnimationFrame(tick)
    }

    const cleanup = () => {
      if (raf) cancelAnimationFrame(raf)
      sa.removeEventListener('wheel', onUserInput)
      sa.removeEventListener('pointerdown', onUserInput)
      sa.removeEventListener('keydown', onUserInput)
      flashStickCleanup = null
    }
    flashStickCleanup = cleanup
    raf = requestAnimationFrame(tick)

    // 闪烁：先清状态，等下一帧再写，确保 CSS 动画从头跑。
    const realIdx = Number(first.dataset.msgIdx ?? idx)
    flashIdx.value = null
    requestAnimationFrame(() => {
      flashIdx.value = realIdx
      window.clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => {
        flashIdx.value = null
      }, 1400)
    })
  }

  start()
}
// ============================ Live tail: 自动跟随 + "N 条新" pill ============================
//
// 设计：当后端 emit session:append 后，App.vue 把新 Msg 推进 messages，
// 然后调 onLiveAppend(n) 让本组件决定怎么回应：
//   - 用户当前接近底部（100px 以内）→ 自动平滑滚到底，pill 不出现；
//   - 否则 → 在 pill 上累加 N，用户点 pill 才滚到底。
//
// 切换会话 / 关闭后重新打开同一会话时，watch(session.path) 把 newCount 归零，
// 避免把上一条会话的"未读"带到下一条。
const newCount = ref(0)
// 100px 阈值：比 atBottom 用的 8px 宽松得多，鼓励"贴着底"的常态自动跟随。
const FOLLOW_THRESHOLD = 100
function isNearBottom(): boolean {
  const el = scrollEl.value
  if (!el) return true
  return el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_THRESHOLD
}

function onLiveAppend(addedCount: number) {
  if (addedCount <= 0) return
  if (isNearBottom()) {
    // 等新行布局完成再滚 —— 否则 scrollHeight 还是旧值。
    requestAnimationFrame(() => {
      scrollToBottom()
      newCount.value = 0
    })
  } else {
    newCount.value += addedCount
  }
}

function jumpToNewest() {
  newCount.value = 0
  scrollToBottom()
}

// 切换到不同会话 → 清掉"未读"计数。
watch(
  () => props.session?.path,
  () => {
    newCount.value = 0
  },
)

defineExpose({ flashMessage, onLiveAppend })

// 到顶 / 到底时分别隐藏对应方向的 FAB，留一点 8px 阈值避免抖动
const atTop = ref(true)
const atBottom = ref(true)
function updateEdges() {
  const el = scrollEl.value
  if (!el) return
  atTop.value = el.scrollTop <= 8
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
  if (atBottom.value && newCount.value > 0) {
    newCount.value = 0
  }
}
let rafEdge = 0
function onScroll() {
  if (rafEdge) return
  rafEdge = requestAnimationFrame(() => {
    rafEdge = 0
    updateEdges()
  })
}
onMounted(() => {
  scrollEl.value?.addEventListener('scroll', onScroll, { passive: true })
  // 内容渲染完再算一次（长消息列表挂载后 scrollHeight 才稳定）
  requestAnimationFrame(updateEdges)
})
onUnmounted(() => {
  scrollEl.value?.removeEventListener('scroll', onScroll)
  if (rafEdge) cancelAnimationFrame(rafEdge)
  cancelScroll()
  cancelFlashStick()
  window.clearTimeout(flashTimer)
})

// ============================ 顶栏功能：折叠工具 / 搜索 ============================

const innerEl = ref<HTMLElement>()

// ---- 一键折叠/展开所有 <details> （工具调用 + thinking 块）
//
// 实现方式：当 toolsCollapsed 切换时，扫一遍 chat-inner 下所有 <details>，
// 把它们的 `open` 属性同步过去。之后用户单独点哪个 <summary> 仍然能再次展开 /
// 收起——直到下次点击 topbar 的折叠按钮全局再 sweep 一次。
function sweepDetails(open: boolean) {
  const root = innerEl.value
  if (!root) return
  for (const el of root.querySelectorAll<HTMLDetailsElement>('details')) {
    if (!open && el.classList.contains('auto-open')) continue
    el.open = open
  }
}
watch(toolsCollapsed, (v) => sweepDetails(!v))

// ---- 消息内搜索：DOM walker 把匹配文本包成 <mark class="search-hit">
//
// 不修改渲染管线（renderText 走 v-html），而是渲染完之后再扫一遍 DOM，
// 把所有匹配的纯文本节点替换成带 <mark> 的片段。然后维护一组 mark 元素
// 让 ↑/↓ 按钮 / Enter 键能在它们之间跳转。messages / search 变化时整体重做。

let marks: HTMLElement[] = []
let searchDebounce = 0

function unmarkAll() {
  const root = innerEl.value
  if (!root) return
  const list = root.querySelectorAll<HTMLElement>('mark.search-hit')
  list.forEach((m) => {
    const parent = m.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m)
    parent.normalize()
  })
  marks = []
}

function applySearch() {
  unmarkAll()
  const root = innerEl.value
  const q = search.value.trim()
  if (!q || !root) {
    searchCount.value = 0
    searchIndex.value = 0
    return
  }
  const lower = q.toLowerCase()
  const filter = searchScope.value
  // 沿祖先链找到最近的 data-search-scope 标签，再决定是否计入当前筛选项。
  function scopeOk(parent: HTMLElement): boolean {
    if (filter === 'all') return true
    const node = parent.closest<HTMLElement>('[data-search-scope]')
    const scope = node?.dataset.searchScope ?? null
    if (filter === 'user') return scope === 'user'
    if (filter === 'agent') return scope === 'assistant' || scope === 'tools-edit'
    if (filter === 'tools') return scope === 'tools-other'
    return true
  }
  // 收集所有候选文本节点（跳过 <script>/<style>/已经是 mark 内部的）
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const txt = node.textContent
      if (!txt || !txt.toLowerCase().includes(lower)) return NodeFilter.FILTER_REJECT
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // 不在脚本/样式里搜
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      if (!scopeOk(parent)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) targets.push(n as Text)

  const collected: HTMLElement[] = []
  for (const text of targets) {
    const s = text.data
    const lowerS = s.toLowerCase()
    const frag = document.createDocumentFragment()
    let cur = 0
    let idx = lowerS.indexOf(lower, cur)
    while (idx >= 0) {
      if (idx > cur) frag.appendChild(document.createTextNode(s.slice(cur, idx)))
      const mark = document.createElement('mark')
      mark.className = 'search-hit'
      mark.textContent = s.slice(idx, idx + lower.length)
      frag.appendChild(mark)
      collected.push(mark)
      cur = idx + lower.length
      idx = lowerS.indexOf(lower, cur)
    }
    if (cur < s.length) frag.appendChild(document.createTextNode(s.slice(cur)))
    text.parentNode?.replaceChild(frag, text)
  }
  marks = collected
  searchCount.value = marks.length
  searchIndex.value = marks.length > 0 ? 1 : 0
  setCurrentMark()
}

function setCurrentMark() {
  marks.forEach((m) => m.classList.remove('current'))
  if (searchIndex.value < 1 || searchIndex.value > marks.length) return
  const target = marks[searchIndex.value - 1]
  target.classList.add('current')
  // 匹配可能藏在 collapsed 的 <details> 里 —— 沿着祖先链全部打开，确保可见
  let p: HTMLElement | null = target.parentElement
  while (p) {
    if (p.tagName === 'DETAILS' && !(p as HTMLDetailsElement).open) {
      ;(p as HTMLDetailsElement).open = true
    }
    p = p.parentElement
  }
  // 不用 smooth scroll：长会话里成百上千次跳转会卡，且我们已有自定义滚动 RAF。
  // block: 'center' 让 mark 出现在视区中部，符合搜索体验直觉。
  target.scrollIntoView({ block: 'center' })
}

function navigateMatches(dir: 1 | -1) {
  if (marks.length === 0) return
  const next = ((searchIndex.value - 1 + dir + marks.length) % marks.length) + 1
  searchIndex.value = next
  setCurrentMark()
}

watch(search, () => {
  // 短文本输入会快速变更，debounce 避免每按一键都重写一遍 DOM
  window.clearTimeout(searchDebounce)
  searchDebounce = window.setTimeout(applySearch, 120)
})

// 切换搜索范围时立即重做（不 debounce —— 是离散操作）
watch(searchScope, () => {
  if (search.value) applySearch()
})

// 消息变化（切换会话 / 刷新）后重新建立标记 + 重新 sweep 折叠态 + 渲染 mermaid 占位符
// live GUI chat 自动跟随：必须在「消息变化导致 DOM 撑高之前」判断用户是否贴底，
// 否则新消息一来 scrollHeight 立刻变大、isNearBottom 误判为 false，就再也不跟随了。
// flush:'pre' 的 watcher 在 re-render 前跑，此刻 scrollTop/scrollHeight 还是旧值。
let wasAtBottomBeforeUpdate = true
watch(
  () => props.messages,
  () => {
    if (props.liveSession) wasAtBottomBeforeUpdate = isNearBottom()
  },
)
watch(
  () => props.messages,
  () => {
    nextTick(() => {
      if (toolsCollapsed.value) sweepDetails(false)
      if (search.value) applySearch()
      renderAllMermaid(innerEl.value ?? null)
      highlightAllCodeBlocks(innerEl.value ?? null)
      decorateCodeBlocks(innerEl.value ?? null)
      // 聊天进行中：变化前贴底 → 钉到最新消息（钉一小段，扛住高亮/图片异步撑高）。
      if (props.liveSession && wasAtBottomBeforeUpdate) {
        pinToBottomFor(220)
      }
    })
  },
  { flush: 'post' },
)

// §10.6 流式即时渲染：把正在生成的文本走与定稿气泡同一个 markdown 渲染器（renderText），
// 逐 delta 重渲染 → 标题 / 粗体 / 列表 / 行内代码即时成型，而非等结束才把 md 语法转成格式
// （对齐 VSCode 插件）。代码块语法高亮 / mermaid 仍只在权威记录定稿后由 DOM 扫描 watcher
// 处理（与正常气泡一致）。computed 只在 live.text 变化时重 parse —— `now` 计时每 250ms 的
// 重渲染命中缓存、不会重复 parse。
const streamingHtml = computed(() => {
  const lv = props.liveSession?.live
  return lv ? renderText(lv.text) : ''
})

// §10.6 流式：delta 逐 token 撑高时跟随贴底。默认 flush 'pre' → 回调先于 DOM 更新跑，
// 此刻 isNearBottom() 读的是「撑高前」的滚动位置（= 用户是否在跟读）；nextTick 后 DOM
// 已撑高再钉底。只读 liveSession.live.text，不触发整列表 mermaid/高亮重算。
watch(
  () => props.liveSession?.live?.text,
  () => {
    if (!props.liveSession?.live) return
    if (isNearBottom()) nextTick(() => pinToBottomFor(120))
  },
)

// 用户发起一轮（turnState idle→running 仅由 sendPrompt 触发）→ **无视当前滚动位置**，
// 强制跳到底部并跟随这一轮的最新消息（用户回显 + agent 回复）。这是聊天的标准行为：
// 发消息总该看到自己刚发的那条 + 随后的回答，哪怕之前滚到了中间。之后若用户手动上滑读
// 历史，isNearBottom() 转 false，message/delta watcher 自动停止跟随、不打扰。
watch(
  () => props.liveSession?.turnState,
  (ts, prev) => {
    if (ts === 'running' && prev !== 'running') {
      wasAtBottomBeforeUpdate = true
      nextTick(() => pinToBottomFor(500))
    }
  },
)

// 主题切换：mermaid 不能运行时换色，要把已渲染节点 reset 再 redraw。
watch(theme, () => {
  nextTick(() => {
    resetMermaidForTheme(innerEl.value ?? null)
    renderAllMermaid(innerEl.value ?? null)
    rehighlightAllCodeBlocks(innerEl.value ?? null)
  })
})

onMounted(() => {
  setSearchNavigator(navigateMatches)
  document.addEventListener('click', onDocClick)
  // 初次挂载也跑一遍 —— 会话已经有 messages 时 watch 不会触发。
  nextTick(() => {
    renderAllMermaid(innerEl.value ?? null)
    highlightAllCodeBlocks(innerEl.value ?? null)
    decorateCodeBlocks(innerEl.value ?? null)
    // live GUI chat：进入时（含入口 3 切换 / 列表续聊的预载历史）钉到底部一会儿，
    // 露出最新上下文 + composer，扛住代码高亮/图片异步撑高。
    if (props.liveSession) {
      wasAtBottomBeforeUpdate = true
      pinToBottomFor(600)
    }
  })
})

// live ChatView 可能复用读模式的实例（同为 <ChatView> 组件），patch-in-place 时
// onMounted 不会重跑 —— 监听 liveSession 由空变有，确保「切换进 chat」也钉到底。
watch(
  () => props.liveSession,
  (ls) => {
    if (ls) {
      wasAtBottomBeforeUpdate = true
      nextTick(() => pinToBottomFor(600))
    }
  },
)
onUnmounted(() => {
  setSearchNavigator(null)
  window.clearTimeout(searchDebounce)
  unmarkAll()
  document.removeEventListener('click', onDocClick)
})

// 导出下拉菜单：点空白处关闭。锚定到导出按钮容器，点容器内的项不触发关闭。
const exportMenuOpen = ref(false)
const exportMenuEl = ref<HTMLElement>()
function toggleExportMenu(e: Event) {
  e.stopPropagation()
  exportMenuOpen.value = !exportMenuOpen.value
  locateMenuOpen.value = false
}

// ---- 定位下拉：列出所有用户提问，点击跳转到对应消息。
const locateMenuOpen = ref(false)
const locateMenuEl = ref<HTMLElement>()
const locateFilter = ref('')
const locateInputEl = ref<HTMLInputElement>()
interface PromptEntry {
  idx: number
  seq: number
  uuid?: string
  text: string
  time: string
}
const promptEntries = computed<PromptEntry[]>(() => {
  const entries: PromptEntry[] = []
  for (let i = 0; i < props.messages.length; i++) {
    const m = props.messages[i]
    if (m.role !== 'user' || m.metaKind || isToolOnly(m) || isCaveatOnlyMsg(m) || systemEventLabel(m)) continue
    const textBlock = m.blocks.find((b) => b.kind === 'text' && b.text)
    const raw = textBlock?.text ?? ''
    const plain = raw.replace(/<[^>]*>/g, '').trim()
    const text = plain.length > 80 ? plain.slice(0, 80) + '…' : plain || `#${entries.length + 1}`
    entries.push({ idx: i, seq: entries.length + 1, uuid: m.uuid, text, time: formatTime(m.timestamp) })
  }
  return entries
})
const filteredPromptEntries = computed(() => {
  const q = locateFilter.value.trim().toLowerCase()
  if (!q) return promptEntries.value
  return promptEntries.value.filter((e) => e.text.toLowerCase().includes(q))
})
function toggleLocateMenu(e: Event) {
  e.stopPropagation()
  locateMenuOpen.value = !locateMenuOpen.value
  exportMenuOpen.value = false
  if (locateMenuOpen.value) {
    locateFilter.value = ''
    nextTick(() => locateInputEl.value?.focus())
  }
}
function jumpToPrompt(entry: PromptEntry) {
  locateMenuOpen.value = false
  flashMessage(entry.idx, entry.uuid)
}
function highlightLocateText(text: string): string {
  const q = locateFilter.value.trim()
  if (!q) return escapeHtml(text)
  const escaped = escapeHtml(text)
  const qEscaped = escapeHtml(q)
  const re = new RegExp(`(${qEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escaped.replace(re, '<mark class="locate-hl">$1</mark>')
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function onDocClick(e: MouseEvent) {
  if (exportMenuOpen.value) {
    if (!(exportMenuEl.value && exportMenuEl.value.contains(e.target as Node))) {
      exportMenuOpen.value = false
    }
  }
  if (locateMenuOpen.value) {
    if (!(locateMenuEl.value && locateMenuEl.value.contains(e.target as Node))) {
      locateMenuOpen.value = false
    }
  }
}
</script>

<template>
  <div class="chat-head">
    <button class="icon-btn" v-tooltip="t('chat.back')" @click="$emit('back')">
      <IconArrowLeft />
    </button>
    <div class="chat-head-info">
      <div class="t">
        <span class="t-text">{{ session.title }}</span>
        <button
          v-if="!trashed"
          class="title-rename-ic"
          v-tooltip="t('chat.action.rename')"
          @click="$emit('rename')"
        >
          <IconPencil />
        </button>
      </div>
      <div class="s">
        <span>{{
          t('chat.stats', {
            u: stats.u,
            a: stats.a,
            time: formatTime(session.created),
          })
        }}</span>
        <span
          v-if="live && !trashed"
          class="live-badge"
          v-tooltip="t('chat.live.tooltip')"
        >
          <span class="live-dot" />
          <span class="live-label">{{ t('chat.live') }}</span>
        </span>
        <span v-if="session.id" class="session-id" v-tooltip="session.id">
          <span class="session-id-label">{{ t('session.id') }}</span>
          <span class="session-id-text">{{ shortId(session.id) }}</span>
          <button
            class="session-id-copy"
            v-tooltip="t('chat.action.copyId')"
            @click="$emit('copyId')"
          >
            <IconCopy />
          </button>
        </span>
      </div>
    </div>
    <!-- 收藏星标：把当前会话收藏进「Views」历史（List/View 之间的下拉），收藏后实心。
         仅普通项目会话可收藏，回收站 / 导出历史 / 无 path 的新建 GUI chat 不显示。 -->
    <button
      v-if="canFavorite"
      class="icon-btn fav-btn"
      :class="{ active: favorited }"
      v-tooltip="favorited ? t('chat.action.unfavorite') : t('chat.action.favorite')"
      @click="$emit('toggleFavorite')"
    >
      <IconStar class="fav-star" :class="{ filled: favorited }" />
    </button>
    <!-- 会话统计 + 折叠 Tool calls：原本住在 ChatTopbar.ct-actions 里，
         与 chat-head 的 5 个会话级 icon 隔一行 40px topbar 在同一垂直线上。
         挪进 chat-head 后顶栏只剩 scope+search 一条横线。toolsCollapsed
         走 chatToolbar 模块 ref 共享，原 ChatTopbar 的对应按钮已删除。 -->
    <button
      v-if="!trashed"
      class="icon-btn"
      v-tooltip="t('chat.tb.sessionStats')"
      @click="$emit('openSessionStats')"
    >
      <IconChart />
    </button>
    <div ref="locateMenuEl" class="locate-menu-wrap">
      <button
        class="icon-btn"
        :class="{ active: locateMenuOpen }"
        v-tooltip="t('chat.tb.locate')"
        @click="toggleLocateMenu"
      >
        <IconLocate />
      </button>
      <div v-if="locateMenuOpen" class="locate-menu" role="menu">
        <div class="locate-menu-search">
          <input
            ref="locateInputEl"
            v-model="locateFilter"
            class="locate-search-input"
            :placeholder="t('chat.tb.locate.placeholder')"
            @keydown.escape.stop="locateMenuOpen = false"
          />
        </div>
        <div class="locate-menu-list">
          <button
            v-for="entry in filteredPromptEntries"
            :key="entry.idx"
            class="locate-menu-item"
            role="menuitem"
            @click="jumpToPrompt(entry)"
          >
            <span class="locate-item-idx">#{{ entry.seq }}</span>
            <span class="locate-item-text" v-html="highlightLocateText(entry.text)"></span>
            <span class="locate-item-time">{{ entry.time }}</span>
          </button>
          <div v-if="!filteredPromptEntries.length" class="locate-menu-empty">
            {{ t('chat.empty') }}
          </div>
        </div>
      </div>
    </div>
    <button
      class="icon-btn"
      v-tooltip="
        toolsCollapsed
          ? t('chat.tb.tools.expand')
          : t('chat.tb.tools.collapse')
      "
      @click="toggleTools"
    >
      <component :is="toolsCollapsed ? IconUnfold : IconFold" />
    </button>
    <button
      v-if="hiddenCount > 0"
      class="icon-btn"
      :class="{ active: showHidden }"
      v-tooltip="showHidden ? t('chat.action.hideHidden') : t('chat.action.showHidden')"
      @click="showHidden = !showHidden"
    >
      <component :is="showHidden ? IconEye : IconEyeOff" />
      <span class="hidden-badge">{{ hiddenCount }}</span>
    </button>
    <span class="chat-head-sep" />
    <!-- 在窗口内 resume（TUI）：仅只读详情。live chat 里已在对话中，无需再开 TUI tab。 -->
    <button
      v-if="!liveSession && !trashed"
      class="icon-btn"
      :class="{ disabled: !canResumeHere }"
      v-tooltip="canResumeHere ? t('chat.action.resumeHere') : t('chat.action.resumeUnavailable')"
      :disabled="!canResumeHere"
      @click="canResumeHere && $emit('resumeHere')"
    >
      <IconPlay />
    </button>
    <!-- 打开目录 / 导出：read 与 live chat 两种模式都需要。 -->
    <button
      v-if="!trashed"
      class="icon-btn"
      v-tooltip="t('chat.action.reveal')"
      @click="$emit('reveal')"
    >
      <IconFolder />
    </button>
    <!-- 刷新：仅只读详情。live chat 是实时流，无需手动刷新。 -->
    <button
      v-if="!liveSession && !trashed"
      class="icon-btn"
      v-tooltip="t('chat.action.refresh')"
      @click="$emit('refresh')"
    >
      <IconRefresh />
    </button>
    <span v-if="!trashed" class="chat-head-sep" />
    <div v-if="!trashed" ref="exportMenuEl" class="export-menu-wrap">
      <button
        class="icon-btn"
        :class="{ active: exportMenuOpen }"
        v-tooltip:top="t('chat.tb.export.md') + ' / ' + t('chat.tb.export.html')"
        @click="toggleExportMenu"
      >
        <IconDownload />
      </button>
      <div v-if="exportMenuOpen" class="export-menu" role="menu">
        <button
          class="export-menu-item"
          role="menuitem"
          @click="exportMenuOpen = false; $emit('exportMd')"
        >
          <IconMarkdown />
          <span>{{ t('chat.tb.export.md') }}</span>
        </button>
        <button
          class="export-menu-item"
          role="menuitem"
          @click="exportMenuOpen = false; $emit('exportHtml')"
        >
          <IconHtml />
          <span>{{ t('chat.tb.export.html') }}</span>
        </button>
        <button
          class="export-menu-item"
          role="menuitem"
          @click="exportMenuOpen = false; $emit('exportJson')"
        >
          <IconJson />
          <span>{{ t('chat.tb.export.json') }}</span>
        </button>
      </div>
    </div>
    <!-- 删除：read 与 live chat 两种模式都有（chat 里删 = 软删并停掉当前会话）。 -->
    <button
      v-if="!trashed"
      class="icon-btn danger"
      v-tooltip="t('chat.action.delete')"
      @click="$emit('delete')"
    >
      <IconTrash />
    </button>
    <button
      v-if="!liveSession && trashed"
      class="icon-btn chat-restore-btn"
      v-tooltip="t('trash.restore')"
      @click="$emit('restore')"
    >
      <IconRestore />
    </button>
  </div>

  <div ref="scrollEl" class="chat-scroll">
    <div ref="innerEl" class="chat-inner">
      <div
        v-for="(m, i) in messages"
        :key="m.uuid ?? i"
        v-show="rowHasContent(m) && (!isHidden(m, i) || showHidden)"
        class="msg-row"
        :class="[
          systemEventLabel(m) ? 'system' : m.metaKind ? 'meta' : isToolOnly(m) ? 'tool-only' : m.role,
          { 'msg-flash': flashIdx === i, 'msg-hidden': isHidden(m, i) && showHidden, 'row-active': hoveredKey === msgKey(m, i) },
        ]"
        :data-search-scope="rowScope(m)"
        :data-msg-idx="i"
        :data-msg-uuid="m.uuid ?? ''"
        @mouseenter="hoveredKey = msgKey(m, i)"
        @mouseleave="hoveredKey === msgKey(m, i) && (hoveredKey = null)"
      >
        <!-- System events (e.g. /rename) render as a small centered line,
             not a "Me" bubble — they're meta facts, not user prose. -->
        <div v-if="systemEventLabel(m)" class="system-event">
          {{ systemEventLabel(m) }}
        </div>

        <!-- System-injected user records (compaction summary, skill injection,
             task notifications, command output). Not "Me" prose — render like an
             assistant turn: a "✳ Claude" header + a collapsed, tool-call-style
             card holding the body. Notification pseudo-XML → clean key/value rows. -->
        <div v-else-if="m.metaKind" class="bubble meta-msg">
          <div class="role-tag">
            <span class="name">
              <component :is="agentIcons[agent]" class="agent-icon" :class="agent" />
              {{ assistantName }}
            </span>
          </div>
          <details class="block-card">
            <summary class="block-summary">
              <span class="chev"><IconChevronRight /></span>
              <span class="label meta-summary-label">{{ metaKindLabel(m.metaKind) }}</span>
            </summary>
            <div class="block-body">
              <template v-for="(b, bi) in m.blocks" :key="bi">
                <template v-if="b.kind === 'text'">
                  <dl v-if="metaFieldsOf(b.text ?? '')" class="meta-fields">
                    <template v-for="(f, fi) in metaFieldsOf(b.text ?? '')!" :key="fi">
                      <dt class="meta-field-key">{{ f.key }}</dt>
                      <dd class="meta-field-val">{{ f.value }}</dd>
                    </template>
                  </dl>
                  <pre v-else-if="metaIsPre(m)">{{ cleanMetaText(b.text ?? '') }}</pre>
                  <div v-else class="text-run" v-html="metaBlockHtml(m.metaKind, b.text ?? '')" />
                </template>
              </template>
            </div>
          </details>
        </div>

        <div v-else-if="isToolOnly(m)" style="max-width: 86%; min-width: 0">
          <template v-for="(b, bi) in m.blocks" :key="bi">
            <ToolResult
              v-if="!isInlinedResult(b) && !isAttachedResult(b) && !shouldHideToolResult(b)"
              :block="b"
            />
          </template>
        </div>

        <template v-else>
          <!-- 图片缩略图：浮在气泡上方、页面背景上（不进灰底气泡），小缩略图自适应比例、
               点击放大。参考 Claude 客户端：用户图片在「Me」气泡之上独立成排。 -->
          <div v-if="imageBlocks(m).length" class="msg-images">
            <button
              v-for="(b, bi) in imageBlocks(m)"
              :key="'img' + bi"
              type="button"
              class="msg-image-thumb"
              @click="openLightbox(imageBlocks(m).map((x) => x.imageSrc!), bi)"
            >
              <img :src="b.imageSrc" loading="lazy" alt="" />
            </button>
          </div>

          <div v-if="hasBubbleBody(m)" class="bubble" :class="m.role">
          <div class="role-tag">
            <span class="name">
              <component
                v-if="m.role === 'assistant'"
                :is="agentIcons[agent]"
                class="agent-icon"
                :class="agent"
              />
              {{ m.role === 'user' ? t('chat.role.me') : assistantName }}
            </span>
            <span v-if="m.model" class="tool-chip">{{ m.model }}</span>
            <span v-if="m.sidechain" class="sidechain-badge">
              {{ t('chat.badge.subtask') }}
            </span>
          </div>

          <CollapsibleBox :enabled="m.role === 'user'" :max-height="320">
            <template v-for="(b, bi) in m.blocks" :key="bi">
              <div v-if="b.kind === 'text'" class="text-run" v-html="renderText(bubbleText(m, b.text ?? ''))" />

              <!-- image 块已渲染在气泡上方，正文里跳过 -->

              <details
                v-else-if="b.kind === 'thinking'"
                class="block-card"
                :class="{ 'in-user': m.role === 'user' }"
              >
                <summary class="block-summary">
                  <span class="chev"><IconChevronRight /></span>
                  <span class="label">{{ toolLabel(b) }}</span>
                </summary>
                <div class="block-body"><pre>{{ b.text }}</pre></div>
              </details>

              <div
                v-else-if="isCodexInlineCodeToolUse(b)"
                class="inline-tool-code inline-tool-code-flat"
                :data-search-scope="toolUseScope(b)"
              >
                <div
                  :class="toolUseCodeClass(b)"
                  v-html="toolUseCodeHtml(b)"
                />
              </div>

              <details
                v-else-if="b.kind === 'tool_use'"
                class="block-card"
                :class="{ 'in-user': m.role === 'user' }"
                :data-search-scope="toolUseScope(b)"
              >
                <summary class="block-summary">
                  <span class="chev"><IconChevronRight /></span>
                  <span class="label">{{ toolLabel(b) }}</span>
                </summary>
                <div class="block-body">
                  <pre class="lang-json" v-html="prettifyAndHighlightJson(b.toolInput ?? '')" />
                  <ToolResult
                    v-if="inlinedResultFor(b)"
                    :block="inlinedResultFor(b)!"
                  />
                </div>
              </details>

              <ToolResult
                v-else-if="
                  b.kind === 'tool_result' &&
                  !isInlinedResult(b) &&
                  !isAttachedResult(b) &&
                  !shouldHideToolResult(b)
                "
                :block="b"
                :in-user="m.role === 'user'"
              />
            </template>
          </CollapsibleBox>
          </div>

          <!-- 文件改动型 tool_result：作为本条消息的一部分整块展示在气泡下方、时间行上方，
               与发起它的「Tool call · Edit」同属一条消息（diff 自成卡片便于一眼看改动）。 -->
          <template v-for="(b, bi) in m.blocks" :key="'fc' + bi">
            <div
              v-if="b.kind === 'tool_use' && attachedResultFor(b)"
              class="attached-result"
              data-search-scope="tools-edit"
            >
              <ToolResult :block="attachedResultFor(b)!" />
            </div>
          </template>

          <!-- 悬停操作行：与气泡平级、在「气泡下方」按行内排布（不再绝对定位贴边，
               故不会压到紧随其后的 tool-only 结果卡上）。时间统一藏起，hover 才露出。 -->
          <div class="msg-actions">
            <span class="msg-time">{{ formatTime(m.timestamp) }}</span>
            <button
              class="msg-action-btn"
              type="button"
              v-tooltip="copiedMsgKey === msgKey(m, i) ? t('chat.action.copied') : t('chat.action.copyMsg')"
              @click="copyMsg(m, i)"
            >
              <component :is="copiedMsgKey === msgKey(m, i) ? IconCheck : IconCopy" />
            </button>
            <!-- 隐藏消息仅在只读详情里出现：直播 chat 进行中无需隐藏自己刚发的消息。 -->
            <button
              v-if="!liveSession"
              class="msg-action-btn"
              type="button"
              v-tooltip="isHidden(m, i) ? t('chat.action.unhideMsg') : t('chat.action.hideMsg')"
              @click="toggleHideMsg(m, i)"
            >
              <component :is="isHidden(m, i) ? IconEye : IconEyeOff" />
            </button>
          </div>
        </template>
      </div>

      <!-- §10.6 流式预览：正在生成的文本块打字机（仅 Claude 产 delta；Codex 永不出现）。
           权威 assistant 记录到达即清空 live、真气泡入列表 —— 同位替换，无闪。 -->
      <div v-if="liveSession && liveSession.live" class="msg-row assistant">
        <div class="bubble assistant">
          <div class="role-tag">
            <span class="name">
              <component :is="agentIcons[agent]" class="agent-icon" :class="agent" />
              {{ assistantName }}
            </span>
          </div>
          <!-- 即时 markdown（v-html）：与定稿气泡同款渲染，定稿时同位无缝替换。 -->
          <div class="text-run" v-html="streamingHtml" />
        </div>
      </div>

      <!-- live 模式：本轮正在运行的 ✳ + 计时（参考 Claude 客户端） -->
      <div v-if="liveSession && liveSession.turnState === 'running'" class="chat-running-row">
        <span class="chat-running-star" :class="agent">✳</span>
        <span class="chat-running-time">{{ runningElapsedSec }}s</span>
      </div>

      <div v-if="!messages.length && !liveSession" class="empty" style="height: 200px">
        <div>{{ t('chat.empty') }}</div>
      </div>
    </div>
  </div>

  <div v-if="messages.length" class="scroll-fab" :class="{ 'has-composer': !!liveSession }">
    <!-- read ⇄ chat 切到对方模式的开关：两个方向共用底部同一个 FAB 位置，按模式二选一显示，
         图标就地在 book（→read）/ 气泡（→chat）间切换 —— 同位置即可，不需要过渡飞线动画。 -->
    <button
      v-if="liveSession && hasReadView"
      class="fab fab-accent"
      v-tooltip="t('chat.action.switchToRead')"
      @click="$emit('switchToRead')"
    >
      <IconReader />
    </button>
    <!-- 切到 chat（GUI live chat）目前只有 claude 支持；codex / gemini 不显示这个 FAB。 -->
    <button
      v-else-if="!liveSession && !trashed && canResumeHere && agent === 'claude'"
      class="fab fab-accent"
      v-tooltip="t('chat.action.switchToChat')"
      @click="$emit('switchToChat')"
    >
      <IconChat />
    </button>
    <div v-if="newCount > 0 || !atTop || !atBottom" class="scroll-arrow-stack">
      <button
        v-if="newCount > 0"
        class="new-pill"
        @click="jumpToNewest"
      >
        {{ t('chat.newMessages', { n: newCount }) }}
      </button>
      <button
        v-if="!atTop"
        class="fab"
        v-tooltip="t('chat.action.top')"
        @click="scrollToTop"
      >
        <IconArrowUp />
      </button>
      <button
        v-if="!atBottom"
        class="fab"
        v-tooltip="t('chat.action.bottom')"
        @click="scrollToBottom"
      >
        <IconArrowDown />
      </button>
    </div>
  </div>

  <!-- live GUI chat：底部输入框（Claude 客户端样式） -->
  <ChatComposer v-if="liveSession" :session="liveSession" />

  <VueEasyLightbox
    :visible="lightboxVisible"
    :imgs="lightboxImgs"
    :index="lightboxIndex"
    @hide="lightboxVisible = false"
  />
</template>
