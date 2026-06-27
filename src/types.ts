export type Agent = 'claude' | 'codex' | 'gemini'

export interface ProjectInfo {
  dirName: string
  displayPath: string
  sessionCount: number
  lastModified: number
  /** 项目目录当前是否仍存在于磁盘上 */
  exists: boolean
  bookmarked?: boolean
  parentDirName?: string
  worktreeName?: string
}

export interface SessionMeta {
  id: string
  fileName: string
  path: string
  title: string
  cwd?: string
  created?: string
  modified: number
  size: number
  messageCount: number
  codexAppListRank?: number | null
  codexAppListScanned: number
  codexAppFirstPageSize: number
  codexAppFirstPagePosition: number
  codexInternal: boolean
  codexArchived: boolean
}

export interface SessionPage {
  total: number
  sessions: SessionMeta[]
}

export type BlockKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image'

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface Block {
  kind: BlockKind
  text?: string
  toolName?: string
  toolInput?: string
  toolId?: string
  isError: boolean
  filePath?: string
  diff?: DiffHunk[]
  imageSrc?: string
}

export interface Msg {
  uuid?: string
  role: 'user' | 'assistant'
  timestamp?: string
  model?: string
  sidechain: boolean
  blocks: Block[]
  /** 系统注入的 `type:"user"` 记录归类（compact / meta / task-notification /
   *  system / command-output）。后端 claude 源填充；其它 agent 不填 → undefined。
   *  非空时前端把这条渲染成低调的「系统」块，而非「Me」气泡。 */
  metaKind?: string
}

/** 全局搜索的命中条目（与 Rust 端 SearchHit 同形）。 */
export type SearchField = 'title' | 'id' | 'path' | 'text'
export interface SearchHit {
  projectKey: string
  projectDisplay: string
  session: SessionMeta
  matchedField: SearchField
  /** 命中片段：title/id/path 等于原值；text 上是带前后文（带省略号）的小段。 */
  snippet: string
  /** 文本命中所在消息的索引（read_session 返回的数组下标）；metadata 命中为 undefined。 */
  matchMsgIndex?: number
  /** 文本命中所在消息的 uuid（若 agent 写了）；前端定位时优先用 uuid 兜底。 */
  matchMsgUuid?: string
}

/** 单个会话的 token 用量；与 Rust 端 UsageSummary 同形。
 *  `cacheCreation1hInputTokens` 是 `cacheCreationInputTokens` 的子集（1-hour tier），
 *  cost 公式额外按 1× 5min 价位再算一遍（合计 2×），别在 UI 上把它加进 total。 */
export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheCreation1hInputTokens: number
  cacheReadInputTokens: number
  reasoningOutputTokens: number
  total: number
}

/** 统计 dashboard：单个项目的聚合（与 Rust ProjectStats 同形）。 */
export interface ProjectStats {
  dirName: string
  displayPath: string
  sessionCount: number
  messageCount: number
  callCount: number
  usage: UsageSummary
  costUsd: number
  lastModified: number
}

/** 统计 dashboard：某一天（UTC）的活动量。 */
export interface DailyActivity {
  date: string // YYYY-MM-DD
  sessionCount: number
  messageCount: number
  callCount: number
  tokens: number
  costUsd: number
}

/** Top Sessions 排行里的一条。 */
export interface SessionStat {
  agent: Agent
  sessionId: string
  path: string
  projectDisplay: string
  title: string
  lastModified: number
  callCount: number
  usage: UsageSummary
  costUsd: number
}

/** By Model 排行里的一条。 */
export interface ModelStat {
  model: string
  label: string
  callCount: number
  usage: UsageSummary
  costUsd: number
  /** 0..=1。cache_read / (input + cache_read + cache_creation)。 */
  cacheHitRate: number
}

/** By Tool / By Shell / By MCP 共用 name+count 对。 */
export interface NamedCount {
  name: string
  count: number
}

/** By Activity 一行：分类 key + 调用 / 成本。`key` 对应 stats.activity.* 翻译。 */
export interface ActivityStat {
  key: string
  turnCount: number
  callCount: number
  costUsd: number
}

/** 统计范围筛选 —— 前端 dropdown 切换。 */
export type StatsScope = 'all' | Agent

/** 时间范围筛选。 */
export type StatsRange = 'today' | 'days7' | 'days30' | 'month' | 'months6'

/** 流式统计的完整结果（与 Rust AgentStats 同形）。`scope` 标识维度。 */
export interface AgentStats {
  scope: 'all' | Agent | string
  sessionCount: number
  messageCount: number
  callCount: number
  daysActive: number
  usage: UsageSummary
  costUsd: number
  cacheHitRate: number
  /** 按 cost_usd 降序的项目列表。 */
  projects: ProjectStats[]
  /** 按日期升序的日活时间轴（稀疏，没活动的天不出现）。 */
  dailyActivity: DailyActivity[]
  /** 按 cost_usd 降序的 Top 10 会话。 */
  topSessions: SessionStat[]
  /** 按 cost_usd 降序的模型排行。 */
  byModel: ModelStat[]
  /** 按调用次数降序的工具排行。 */
  byTool: NamedCount[]
  /** 按调用次数降序的 shell 主命令排行。 */
  byShell: NamedCount[]
  /** 按调用次数降序的 MCP server 排行。 */
  byMcp: NamedCount[]
  /** 按 cost_usd 降序的活动分类排行。 */
  byActivity: ActivityStat[]
}

/** 流式推送的进度负载。`partial` 是到目前为止的累计快照，前端直接替换。 */
export interface StatsProgress {
  requestId: number
  processed: number
  total: number
  partial: AgentStats
}

export interface StatsDone {
  requestId: number
  stats: AgentStats
}

export interface StatsError {
  requestId: number
  error: string
}

// ============================ GUI chat（程序化聊天）============================

/** 一轮问答的运行状态。 */
export type ChatTurnState = 'idle' | 'running'

/** 输入框里的图片附件（粘贴 / 拖拽 / 选择）。`dataUrl` 供预览与本地回显，
 *  `data` 是去掉 `data:` 前缀的纯 base64，发送给后端时用。 */
export interface ChatImageAttachment {
  dataUrl: string
  mediaType: string
  data: string
  /** 文件名（来自文件选择/拖拽；粘贴的截图回退 image.png）。仅前端展示用。 */
  name?: string
}

/** agent_chat_send 透传给后端的图片输入（与 Rust ChatImageInput 同形）。 */
export interface ChatImageInput {
  mediaType: string
  data: string
}

/** GUI chat `/` 浮层的一条动态指令（与 Rust SlashCommand 同形）。 */
export interface SlashCommand {
  name: string
  description: string
  /** project | user | skill */
  source: string
}

/** GUI chat 的进程模型：长驻 stdin（Claude，切设置需 restart-with-resume）
 *  vs 一轮一进程 resume（Codex/Gemini，切设置改下轮 flag 即生效）。 */
export type ChatProcessModel = 'longLivedStdin' | 'oneShotResume'

/** agent_chat_start 的返回（与 Rust ChatStartInfo 同形）。 */
export interface ChatStartInfo {
  chatId: number
  processModel: ChatProcessModel
}

export interface ClaudeRuntimeInfo {
  hasCustomBaseUrl: boolean
  aliasTargets: {
    opus?: string
    sonnet?: string
    haiku?: string
    fable?: string
  }
  /** init 事件回来前对鉴权方式的预判：'none' = 订阅/OAuth；其它 = API key；缺省 = 判不出。 */
  apiKeySource?: string
}

/** agent-chat://* 事件 payload（与 Rust 端同形）。 */
export interface ChatEventPayload { chatId: number; msg: Msg }
export interface ChatInitPayload { chatId: number; sessionId?: string; apiKeySource?: string }
export interface ChatResultPayload { chatId: number; ok: boolean; usage?: UsageSummary }
export interface ChatStderrPayload { chatId: number; line: string }
export interface ChatExitPayload { chatId: number; code: number }

/** token 级流式增量（仅 Claude --include-partial-messages）。 */
export interface ChatDelta {
  index: number
  /** 'start' | 'delta' | 'stop' —— 内容块生命周期。 */
  phase: string
  /** 块类型 text | thinking | tool_use（start 必有；delta 也带，前端兜底建块）。 */
  kind?: string
  /** 仅 delta：本次追加的文本片段。 */
  text?: string
}
export interface ChatDeltaPayload { chatId: number; delta: ChatDelta }

/** 单个额度窗口（与 Rust usage_api::UsageWindow 同形）。来自 OAuth 用量接口。 */
export interface UsageWindow {
  /** 利用率百分比 0–100。 */
  utilization: number
  /** ISO8601 重置时间（用 `new Date()` 解析）。 */
  resetsAt?: string
}
/** 账号额度快照（与 Rust usage_api::AccountUsage 同形）。 */
export interface AccountUsage {
  fiveHour?: UsageWindow | null
  sevenDay?: UsageWindow | null
  sevenDayOpus?: UsageWindow | null
  sevenDaySonnet?: UsageWindow | null
}

export interface TrashItem {
  trashFile: string
  agent: Agent
  projectLabel: string
  originalPath: string
  /** 回收站里 JSONL 的绝对路径，用于在回收站里直接查看会话详情。 */
  trashPath: string
  deletedAt: number
  title: string
  size: number
}

export interface TrayAgentSummary {
  agent: string
  todayTokens: number
  todayCost: number
  weekTokens: number
  weekCost: number
  monthTokens: number
  monthCost: number
  sessionCount: number
}

export interface TrayStats {
  agents: TrayAgentSummary[]
  totalTodayTokens: number
  totalTodayCost: number
  totalWeekTokens: number
  totalWeekCost: number
  totalMonthTokens: number
  totalMonthCost: number
}
