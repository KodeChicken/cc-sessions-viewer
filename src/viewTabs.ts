// View tabs — session 查看 / GUI chat 的 tab 化管理。
//
// 对标 terminals.ts（TUI tab），但不需要 xterm：
//   session tab → 只读查看会话，msgs 从磁盘读取
//   chat tab    → live GUI chat（子进程由 chatSessions 管理），msgs 从 ChatSession 实时推送
//
// 每个 tab 按 (agent, projectKey) 归属，切项目时隐藏但不杀；和终端 tab 行为一致。

import { ref, computed } from 'vue'
import type { Agent, SessionMeta, Msg } from './types'
import type { ChatSession } from './chatSessions'

let nextViewTabId = 1

export interface ViewTab {
  uiId: number
  type: 'session' | 'chat'
  agent: Agent
  projectKey: string
  title: string
  createdAt: number
  // session tab
  session: SessionMeta | null
  msgs: Msg[]
  loadingMsgs: boolean
  // chat tab
  chatSession: ChatSession | null
  // 来源会话（chat tab 续聊时绑定的原始 transcript）
  sourceSession: SessionMeta | null
  // live tail 状态（session tab 的文件追踪）
  liveTailing: boolean
  liveFadeTimer: number
  // 回收站来源（session tab 从回收站打开时）
  trashAgent: Agent | null
  // 导出历史来源 agent（可能与侧栏 agent 不同）
  importedAgent: Agent | null
}

export const viewTabs = ref<ViewTab[]>([])
export const activeViewTabId = ref<number | null>(null)

export const activeViewTab = computed<ViewTab | null>(() =>
  viewTabs.value.find(t => t.uiId === activeViewTabId.value) ?? null,
)

export function createViewTab(partial: Partial<ViewTab> & Pick<ViewTab, 'type' | 'agent' | 'projectKey'>): ViewTab {
  const uiId = nextViewTabId++
  const tab: ViewTab = {
    uiId,
    title: '',
    session: null,
    msgs: [],
    loadingMsgs: false,
    chatSession: null,
    sourceSession: null,
    liveTailing: false,
    liveFadeTimer: 0,
    trashAgent: null,
    importedAgent: null,
    ...partial,
    createdAt: partial.createdAt ?? Date.now(),
  }
  viewTabs.value.push(tab)
  activeViewTabId.value = uiId
  // Return the reactive proxy, not the plain object, so callers' mutations trigger reactivity
  return viewTabs.value[viewTabs.value.length - 1]
}

export function findViewTab(predicate: (t: ViewTab) => boolean): ViewTab | undefined {
  return viewTabs.value.find(predicate)
}

export function removeViewTab(uiId: number) {
  const idx = viewTabs.value.findIndex(t => t.uiId === uiId)
  if (idx < 0) return
  const tab = viewTabs.value[idx]
  window.clearTimeout(tab.liveFadeTimer)
  viewTabs.value.splice(idx, 1)
  if (activeViewTabId.value === uiId) {
    // 关闭当前 tab 后，激活同项目的上一个 tab（如有）
    const sameProject = viewTabs.value.filter(
      t => t.agent === tab.agent && t.projectKey === tab.projectKey,
    )
    activeViewTabId.value = sameProject.length > 0 ? sameProject[sameProject.length - 1].uiId : null
  }
}

export function setActiveViewTab(uiId: number | null) {
  activeViewTabId.value = uiId
}

export function visibleViewTabs(agent: Agent, projectKey: string | null): ViewTab[] {
  return viewTabs.value.filter(
    t => t.agent === agent && t.projectKey === (projectKey ?? ''),
  )
}

export function closeViewTabsByProject(projectKey: string) {
  const toRemove = viewTabs.value.filter(t => t.projectKey === projectKey)
  for (const t of toRemove) removeViewTab(t.uiId)
}

const SAVED_VIEW_TABS_KEY = 'savedViewTabs:v1'

export interface SavedViewTab {
  type: 'session' | 'chat'
  agent: Agent
  projectKey: string
  title: string
  createdAt: number
  session: SessionMeta | null
  sessionId: string | null
  trashAgent: Agent | null
  importedAgent: Agent | null
}

export function persistViewTabs() {
  const items: SavedViewTab[] = viewTabs.value
    .filter(t => (t.type === 'session' && t.session) || t.type === 'chat')
    .map(t => ({
      type: t.type,
      agent: t.agent,
      projectKey: t.projectKey,
      title: t.title,
      createdAt: t.createdAt,
      session: t.session ?? t.sourceSession,
      sessionId: t.chatSession?.sessionId ?? t.session?.id ?? null,
      trashAgent: t.trashAgent,
      importedAgent: t.importedAgent,
    }))
  try {
    localStorage.setItem(SAVED_VIEW_TABS_KEY, JSON.stringify({
      tabs: items,
      activeIdx: activeViewTabId.value != null
        ? viewTabs.value.findIndex(t => t.uiId === activeViewTabId.value)
        : null,
    }))
  } catch {}
}

export function loadSavedViewTabs(): { tabs: SavedViewTab[]; activeIdx: number | null } {
  try {
    const raw = localStorage.getItem(SAVED_VIEW_TABS_KEY)
    if (!raw) return { tabs: [], activeIdx: null }
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.tabs)) return { tabs: [], activeIdx: null }
    const valid = data.tabs.filter((t: any) => t && t.agent && (
      (t.type === 'session' && t.session) || t.type === 'chat'
    )) as SavedViewTab[]
    // Dedup: keep last occurrence per (type, agent, sessionId/path)
    const seen = new Set<string>()
    const deduped: SavedViewTab[] = []
    for (let i = valid.length - 1; i >= 0; i--) {
      const t = valid[i]
      const key = `${t.type}:${t.agent}:${t.sessionId ?? t.session?.path ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.unshift(t)
    }
    for (let i = 0; i < deduped.length; i++) {
      if (!deduped[i].createdAt) deduped[i].createdAt = i + 1
    }
    return {
      tabs: deduped,
      activeIdx: typeof data.activeIdx === 'number' ? data.activeIdx : null,
    }
  } catch {
    return { tabs: [], activeIdx: null }
  }
}
