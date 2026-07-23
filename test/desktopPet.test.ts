import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitToMock, invokeMock } = vi.hoisted(() => ({
  emitToMock: vi.fn(),
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ emitTo: emitToMock }))

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
  invokeMock.mockReset().mockResolvedValue(undefined)
  emitToMock.mockReset().mockResolvedValue(undefined)
})

describe('desktop pet preferences', () => {
  it('defaults to disabled with the momo character', async () => {
    const prefs = await import('../src/desktopPet')

    expect(prefs.desktopPetEnabled.value).toBe(false)
    expect(prefs.desktopPetCharacter.value).toBe('momo')
  })

  it('persists enabled and character changes', async () => {
    const prefs = await import('../src/desktopPet')

    prefs.setDesktopPetEnabled(true)
    prefs.setDesktopPetCharacter('kumo')

    expect(localStorage.getItem('desktopPetEnabled:v1')).toBe('1')
    expect(localStorage.getItem('desktopPetCharacter:v1')).toBe('kumo')
  })

  it('restores valid values and rejects an unknown character', async () => {
    localStorage.setItem('desktopPetEnabled:v1', '1')
    localStorage.setItem('desktopPetCharacter:v1', 'unknown')

    const prefs = await import('../src/desktopPet')

    expect(prefs.desktopPetEnabled.value).toBe(true)
    expect(prefs.desktopPetCharacter.value).toBe('momo')
  })

  it('groups only the latest task snapshot by status', async () => {
    const prefs = await import('../src/desktopPet')
    const groups = prefs.groupDesktopTasks([
      { agent: 'codex', path: '/one', state: 'started', title: 'one', updatedAt: 2 },
      { agent: 'claude', path: '/two', state: 'blocked', title: 'two', updatedAt: 1 },
      { agent: 'agy', path: '/three', state: 'failed', title: 'three', updatedAt: 3 },
    ])

    expect(groups.started.map((task) => task.title)).toEqual(['one'])
    expect(groups.blocked.map((task) => task.title)).toEqual(['two'])
    expect(groups.completed).toEqual([])
    expect(groups.failed.map((task) => task.title)).toEqual(['three'])
  })

  it('restores an enabled pet only when hooks are ready', async () => {
    localStorage.setItem('desktopPetEnabled:v1', '1')
    const prefs = await import('../src/desktopPet')

    await prefs.syncDesktopPetWithHooks(true)

    expect(invokeMock).toHaveBeenCalledWith('set_desktop_pet_enabled', { enabled: true })
    expect(prefs.desktopPetEnabled.value).toBe(true)
  })

  it('closes and clears an enabled pet when hooks are unavailable', async () => {
    localStorage.setItem('desktopPetEnabled:v1', '1')
    const prefs = await import('../src/desktopPet')

    await prefs.syncDesktopPetWithHooks(false)

    expect(invokeMock).toHaveBeenCalledWith('set_desktop_pet_enabled', { enabled: false })
    expect(prefs.desktopPetEnabled.value).toBe(false)
    expect(localStorage.getItem('desktopPetEnabled:v1')).toBe('0')
  })
})
