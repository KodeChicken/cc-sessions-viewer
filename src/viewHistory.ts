// View 历史（"Views" 下拉，List 和 View 之间的可搜索历史 + 收藏）。
//
// 和 terminals.ts 里的 SavedView（savedViews:v1）分工不同：
//   - savedViews:v1（App.openSessionByProject）→ 「每个项目回来时要恢复的那一条 View」，
//     由 List/View tab 的开关逻辑增删，是 View tab 的记忆，行为不变。
//   - viewHistory:v1（这里）            → 「某项目里历史上打开过的所有 View + 收藏」，
//     只增不删（无上限），给 List 和 View 之间那个可搜索的下拉列表用。
// 当前 View 自然也是历史的一员：两者在打开会话时一起更新，但读取目的不同。
// 每条按 (agent, dir, session.path) 去重，按 (agent, dir) 过滤后即「该项目独立的」列表。
//
// 独立成模块（不依赖 xterm / tauri）以便单测：只用 vue 的 ref + 类型。

import { ref } from 'vue'
import type { Agent, SessionMeta } from './types'

const VIEW_HISTORY_KEY = 'viewHistory:v1'

export interface ViewHistoryEntry {
  agent: Agent
  dir: string
  session: SessionMeta
  mode: 'read' | 'chat'
  /** 是否收藏 —— 收藏项永远排在最前、视觉上高亮 */
  favorite: boolean
  /** 最近一次打开的时间戳；非收藏项按它倒序（最近在前） */
  openedAt: number
  /** 收藏时间戳；收藏项之间按它倒序（最近收藏在前） */
  favoritedAt?: number
}

export const viewHistory = ref<ViewHistoryEntry[]>(loadViewHistory())

function loadViewHistory(): ViewHistoryEntry[] {
  try {
    const raw = localStorage.getItem(VIEW_HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((v: any) => v && v.agent && v.dir && v.session && (v.session.id || v.session.path))
      .map((v: any) => ({
        agent: v.agent,
        dir: v.dir,
        session: v.session,
        mode: v.mode === 'chat' ? 'chat' : 'read',
        favorite: !!v.favorite,
        openedAt: typeof v.openedAt === 'number' ? v.openedAt : 0,
        ...(typeof v.favoritedAt === 'number' ? { favoritedAt: v.favoritedAt } : {}),
      }))
  } catch {
    return []
  }
}

export function persistViewHistory() {
  try {
    localStorage.setItem(VIEW_HISTORY_KEY, JSON.stringify(viewHistory.value))
  } catch {
    /* 配额满 / 隐私模式：丢了也只是少几条历史，无所谓 */
  }
}

/** 条目的稳定 key —— 优先 session id（跨「新建 chat / 从列表打开」都稳定），回退 path。 */
export function viewKey(s: { id?: string; path?: string }): string {
  return s.id || s.path || ''
}

// 按 (agent, dir, key) 定位；key 可传 session id 或磁盘 path —— 两者都比对，这样
// 「新建 chat（只有 id、没有 path）」与「从列表打开同一会话（有 path）」能归到同一条。
function findViewIndex(agent: Agent, dir: string, key: string): number {
  if (!key) return -1
  return viewHistory.value.findIndex(
    (v) =>
      v.agent === agent &&
      v.dir === dir &&
      (v.session.id === key || v.session.path === key),
  )
}

// 打开一个会话 → 进历史（按 session id 去重，回退 path）；已存在则刷新 session/mode
// 并顶起 openedAt，但**保留**收藏状态。无上限。
export function recordView(input: {
  agent: Agent
  dir: string
  session: SessionMeta
  mode: 'read' | 'chat'
}) {
  const key = viewKey(input.session)
  if (!input.dir || !key) return
  const i = findViewIndex(input.agent, input.dir, key)
  const now = Date.now()
  if (i >= 0) {
    const prev = viewHistory.value[i]
    viewHistory.value[i] = {
      ...prev,
      session: {
        ...input.session,
        // 新建 chat 没有磁盘 path —— 别用空 path 覆盖已记录的真实 path。
        path: input.session.path || prev.session.path,
      },
      mode: input.mode,
      openedAt: now,
    }
  } else {
    viewHistory.value.push({
      agent: input.agent,
      dir: input.dir,
      session: input.session,
      mode: input.mode,
      favorite: false,
      openedAt: now,
    })
  }
  persistViewHistory()
}

// 仅同步 read⇄chat 子模式，不动 openedAt（不打乱历史顺序）。
export function setViewMode(agent: Agent, dir: string, key: string, mode: 'read' | 'chat') {
  const i = findViewIndex(agent, dir, key)
  if (i < 0 || viewHistory.value[i].mode === mode) return
  viewHistory.value[i] = { ...viewHistory.value[i], mode }
  persistViewHistory()
}

// 切换收藏；返回切换后的状态。条目不在历史里（理论上不会）则忽略并返回 false。
export function toggleViewFavorite(agent: Agent, dir: string, key: string): boolean {
  const i = findViewIndex(agent, dir, key)
  if (i < 0) return false
  const prev = viewHistory.value[i]
  const favorite = !prev.favorite
  const next: ViewHistoryEntry = { ...prev, favorite }
  if (favorite) next.favoritedAt = Date.now()
  else delete next.favoritedAt
  viewHistory.value[i] = next
  persistViewHistory()
  return favorite
}

// 会话被重命名后，同步历史里该条的标题（按 agent + id/path 匹配、忽略 dir，避免漏更新）。
export function setViewTitle(agent: Agent, key: string, title: string) {
  if (!key) return
  let changed = false
  viewHistory.value = viewHistory.value.map((v) => {
    if (
      v.agent === agent &&
      (v.session.id === key || v.session.path === key) &&
      v.session.title !== title
    ) {
      changed = true
      return { ...v, session: { ...v.session, title } }
    }
    return v
  })
  if (changed) persistViewHistory()
}

export function removeView(agent: Agent, dir: string, key: string) {
  const i = findViewIndex(agent, dir, key)
  if (i < 0) return
  viewHistory.value.splice(i, 1)
  persistViewHistory()
}

// 会话被删除后，需要把 Views 历史里所有指向它的条目一起清掉。
// 这里按 agent + (session.id | session.path) 全局匹配，故意**不**要求 dir：
//   - 从聊天详情页删除时，来源可能是导出历史/跨项目，调用点未必拿得到稳定 dir；
//   - 同一会话在历史里可能因旧数据/模式切换残留多条引用，统一扫一遍最稳。
export function removeViewEverywhere(agent: Agent, key: string) {
  if (!key) return
  const next = viewHistory.value.filter(
    (v) => !(v.agent === agent && (v.session.id === key || v.session.path === key)),
  )
  if (next.length === viewHistory.value.length) return
  viewHistory.value = next
  persistViewHistory()
}

export function isViewFavorited(agent: Agent, dir: string, key: string): boolean {
  const i = findViewIndex(agent, dir, key)
  return i >= 0 && viewHistory.value[i].favorite
}

// 纯函数：收藏在前（按 favoritedAt 倒序），其余按 openedAt 倒序；filter 为标题子串
// 大小写不敏感过滤。调用方先按 (agent, dir) 过滤好再传进来。导出供单测。
export function sortViewHistory(list: ViewHistoryEntry[], filter?: string): ViewHistoryEntry[] {
  const q = (filter ?? '').trim().toLowerCase()
  const filtered = q
    ? list.filter((v) => (v.session.title ?? '').toLowerCase().includes(q))
    : list.slice()
  return filtered.sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    if (a.favorite && b.favorite) return (b.favoritedAt ?? 0) - (a.favoritedAt ?? 0)
    return b.openedAt - a.openedAt
  })
}
