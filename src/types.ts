export type Agent = 'claude' | 'codex' | 'gemini'

export interface ProjectInfo {
  dirName: string
  displayPath: string
  sessionCount: number
  lastModified: number
  /** 项目目录当前是否仍存在于磁盘上 */
  exists: boolean
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
