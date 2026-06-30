import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  viewHistory,
  recordView,
  setViewMode,
  toggleViewFavorite,
  removeView,
  removeViewEverywhere,
  isViewFavorited,
  sortViewHistory,
  persistViewHistory,
  type ViewHistoryEntry,
} from '../src/viewHistory'
import type { SessionMeta } from '../src/types'

function sess(path: string, title = path): SessionMeta {
  return {
    id: path,
    fileName: path,
    path,
    title,
    modified: 0,
    size: 0,
    messageCount: 0,
  } as SessionMeta
}

function entry(over: Partial<ViewHistoryEntry>): ViewHistoryEntry {
  return {
    agent: 'claude',
    dir: '/p',
    session: sess('a'),
    mode: 'read',
    favorite: false,
    openedAt: 0,
    ...over,
  }
}

let now = 1000
beforeEach(() => {
  localStorage.clear()
  viewHistory.value = []
  now = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('recordView', () => {
  it('appends a new entry with favorite=false and openedAt=now', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    expect(viewHistory.value).toHaveLength(1)
    expect(viewHistory.value[0]).toMatchObject({
      agent: 'claude',
      dir: '/p',
      favorite: false,
      openedAt: 1000,
      mode: 'read',
    })
  })

  it('dedups by (agent,dir,path): re-record bumps openedAt + mode, keeps one entry', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    now = 2000
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl', 'renamed'), mode: 'chat' })
    expect(viewHistory.value).toHaveLength(1)
    expect(viewHistory.value[0].openedAt).toBe(2000)
    expect(viewHistory.value[0].mode).toBe('chat')
    expect(viewHistory.value[0].session.title).toBe('renamed')
  })

  it('preserves favorite state across re-record', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    toggleViewFavorite('claude', '/p', 'a.jsonl')
    now = 3000
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    expect(viewHistory.value).toHaveLength(1)
    expect(viewHistory.value[0].favorite).toBe(true)
  })

  it('treats same path under a different agent/dir as a distinct entry', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    recordView({ agent: 'codex', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    recordView({ agent: 'claude', dir: '/q', session: sess('a.jsonl'), mode: 'read' })
    expect(viewHistory.value).toHaveLength(3)
  })

  it('ignores entries without a dir or session path', () => {
    recordView({ agent: 'claude', dir: '', session: sess('a.jsonl'), mode: 'read' })
    recordView({ agent: 'claude', dir: '/p', session: sess(''), mode: 'read' })
    expect(viewHistory.value).toHaveLength(0)
  })
})

describe('setViewMode', () => {
  it('patches mode without changing openedAt', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    now = 5000
    setViewMode('claude', '/p', 'a.jsonl', 'chat')
    expect(viewHistory.value[0].mode).toBe('chat')
    expect(viewHistory.value[0].openedAt).toBe(1000)
  })

  it('is a no-op for unknown entries', () => {
    setViewMode('claude', '/p', 'missing', 'chat')
    expect(viewHistory.value).toHaveLength(0)
  })
})

describe('toggleViewFavorite / isViewFavorited', () => {
  it('flips favorite and sets/clears favoritedAt; returns new state', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    now = 7000
    expect(toggleViewFavorite('claude', '/p', 'a.jsonl')).toBe(true)
    expect(viewHistory.value[0].favorite).toBe(true)
    expect(viewHistory.value[0].favoritedAt).toBe(7000)
    expect(isViewFavorited('claude', '/p', 'a.jsonl')).toBe(true)

    expect(toggleViewFavorite('claude', '/p', 'a.jsonl')).toBe(false)
    expect(viewHistory.value[0].favorite).toBe(false)
    expect(viewHistory.value[0].favoritedAt).toBeUndefined()
    expect(isViewFavorited('claude', '/p', 'a.jsonl')).toBe(false)
  })

  it('returns false for unknown entries', () => {
    expect(toggleViewFavorite('claude', '/p', 'missing')).toBe(false)
  })
})

describe('removeView', () => {
  it('drops the matching entry only', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    recordView({ agent: 'claude', dir: '/p', session: sess('b.jsonl'), mode: 'read' })
    removeView('claude', '/p', 'a.jsonl')
    expect(viewHistory.value.map((v) => v.session.path)).toEqual(['b.jsonl'])
  })
})

describe('removeViewEverywhere', () => {
  it('removes all matching entries for the deleted session across dirs/modes', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    recordView({ agent: 'claude', dir: '/q', session: sess('a.jsonl'), mode: 'chat' })
    recordView({ agent: 'codex', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    recordView({ agent: 'claude', dir: '/p', session: sess('b.jsonl'), mode: 'read' })
    removeViewEverywhere('claude', 'a.jsonl')
    expect(viewHistory.value.map((v) => `${v.agent}:${v.session.path}`)).toEqual([
      'codex:a.jsonl',
      'claude:b.jsonl',
    ])
  })
})

describe('sortViewHistory', () => {
  it('puts favorites first (by favoritedAt desc), then the rest by openedAt desc', () => {
    const list = [
      entry({ session: sess('r1', 'recent one'), openedAt: 100 }),
      entry({ session: sess('r2', 'recent two'), openedAt: 300 }),
      entry({ session: sess('f1', 'fav one'), favorite: true, favoritedAt: 50 }),
      entry({ session: sess('f2', 'fav two'), favorite: true, favoritedAt: 80 }),
    ]
    const out = sortViewHistory(list)
    expect(out.map((v) => v.session.path)).toEqual(['f2', 'f1', 'r2', 'r1'])
  })

  it('filters by case-insensitive title substring', () => {
    const list = [
      entry({ session: sess('a', 'Fix login bug'), openedAt: 300 }),
      entry({ session: sess('b', 'Add usage badges'), openedAt: 200 }),
      entry({ session: sess('c', 'refactor LOGIN flow'), openedAt: 100 }),
    ]
    const out = sortViewHistory(list, 'login')
    expect(out.map((v) => v.session.path)).toEqual(['a', 'c'])
  })

  it('does not mutate the input array', () => {
    const list = [
      entry({ session: sess('r1'), openedAt: 100 }),
      entry({ session: sess('f1'), favorite: true, favoritedAt: 50 }),
    ]
    const snapshot = list.map((v) => v.session.path)
    sortViewHistory(list)
    expect(list.map((v) => v.session.path)).toEqual(snapshot)
  })
})

describe('persistence', () => {
  it('persistViewHistory writes the reactive list to localStorage', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    persistViewHistory()
    const raw = localStorage.getItem('viewHistory:v1')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].session.path).toBe('a.jsonl')
  })

  it('mutations auto-persist (recordView writes through)', () => {
    recordView({ agent: 'claude', dir: '/p', session: sess('a.jsonl'), mode: 'read' })
    expect(JSON.parse(localStorage.getItem('viewHistory:v1')!)).toHaveLength(1)
  })

  it('reloads only valid entries from localStorage on module init', async () => {
    localStorage.setItem(
      'viewHistory:v1',
      JSON.stringify([
        { agent: 'claude', dir: '/p', session: { path: 'ok' }, mode: 'chat', favorite: true, favoritedAt: 9, openedAt: 5 },
        { agent: 'claude', dir: '/p', session: {} }, // no path → dropped
        { foo: 'bar' }, // garbage → dropped
      ]),
    )
    vi.resetModules()
    const mod = await import('../src/viewHistory')
    expect(mod.viewHistory.value).toHaveLength(1)
    expect(mod.viewHistory.value[0]).toMatchObject({
      session: { path: 'ok' },
      mode: 'chat',
      favorite: true,
      favoritedAt: 9,
      openedAt: 5,
    })
  })
})
