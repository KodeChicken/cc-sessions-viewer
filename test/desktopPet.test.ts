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
  it('sorts task activity using Codex priority and recency', async () => {
    const prefs = await import('../src/desktopPet')
    const tasks: import('../src/desktopPet').DesktopTask[] = [
      { agent: 'codex', path: 'running', state: 'started', title: 'Running', updatedAt: 50 },
      { agent: 'claude', path: 'ready', state: 'completed', title: 'Ready', updatedAt: 40 },
      { agent: 'agy', path: 'failed', state: 'failed', title: 'Failed', updatedAt: 30 },
      { agent: 'claude', path: 'input-old', state: 'blocked', title: 'Input old', updatedAt: 10 },
      { agent: 'codex', path: 'input-new', state: 'blocked', title: 'Input new', updatedAt: 20 },
    ]

    expect(prefs.sortDesktopTasks(tasks).map((task) => task.path)).toEqual([
      'input-new',
      'input-old',
      'failed',
      'ready',
      'running',
    ])
    expect(prefs.dominantDesktopTaskState(tasks)).toBe('blocked')
    expect(prefs.dominantDesktopTaskState([])).toBeNull()
  })

  it('uses the Codex defaults without requiring hooks', async () => {
    const prefs = await import('../src/desktopPet')

    expect(prefs.desktopPetEnabled.value).toBe(false)
    expect(prefs.desktopPetCharacter.value).toBe('codex:codex')
    expect(prefs.desktopPetSize.value).toBe(112)
    expect(prefs.desktopPetPosition.value).toBeNull()
  })

  it('persists the enabled state, pet, size, and settled position', async () => {
    const prefs = await import('../src/desktopPet')

    prefs.setDesktopPetEnabled(true)
    prefs.setDesktopPetCharacter('custom:sample')
    prefs.setDesktopPetSize(156.4)
    prefs.setDesktopPetPosition({ x: 320, y: 240 })

    expect(localStorage.getItem('desktopPetEnabled:v1')).toBe('1')
    expect(localStorage.getItem('desktopPetCharacter:v1')).toBe('custom:sample')
    expect(localStorage.getItem('desktopPetSize:v1')).toBe('156')
    expect(JSON.parse(localStorage.getItem('desktopPetPosition:v1')!)).toEqual({ x: 320, y: 240 })
  })

  it('clamps restored size to the Codex 80–224 pixel range', async () => {
    localStorage.setItem('desktopPetSize:v1', '999')
    const prefs = await import('../src/desktopPet')

    expect(prefs.desktopPetSize.value).toBe(224)
    expect(prefs.setDesktopPetSize(12)).toBe(80)
  })

  it('loads the runtime catalog and falls back when a saved pet is unavailable', async () => {
    localStorage.setItem('desktopPetCharacter:v1', 'custom:missing')
    invokeMock.mockResolvedValueOnce({
      pets: [{
        key: 'codex:codex',
        id: 'codex',
        displayName: 'Codex',
        description: 'The original Codex companion.',
        spriteVersionNumber: 2,
        spritesheetPath: 'C:/pets/codex.webp',
        source: 'codex',
      }],
      customDirectory: 'C:/Users/test/.codex/pets',
      codexInstalled: true,
    })
    const prefs = await import('../src/desktopPet')

    await prefs.loadDesktopPetCatalog()

    expect(invokeMock).toHaveBeenCalledWith('desktop_pet_catalog')
    expect(prefs.desktopPetCharacter.value).toBe('codex:codex')
    expect(prefs.activeDesktopPet.value?.displayName).toBe('Codex')
  })

  it('restores an enabled pet independently of hook status', async () => {
    localStorage.setItem('desktopPetEnabled:v1', '1')
    const prefs = await import('../src/desktopPet')

    await prefs.restoreDesktopPet()

    expect(invokeMock).toHaveBeenCalledWith('set_desktop_pet_enabled', { enabled: true })
    expect(prefs.desktopPetEnabled.value).toBe(true)
  })

  it('synchronizes pet and size changes with an open avatar window', async () => {
    const prefs = await import('../src/desktopPet')

    await prefs.notifyDesktopPetCharacter('codex:bsod')
    await prefs.notifyDesktopPetSize(176)

    expect(emitToMock).toHaveBeenNthCalledWith(
      1,
      'desktop-pet',
      'desktop-pet://preferences',
      { character: 'codex:bsod', size: 112 },
    )
    expect(emitToMock).toHaveBeenNthCalledWith(
      2,
      'desktop-pet',
      'desktop-pet://preferences',
      { character: 'codex:bsod', size: 176 },
    )
  })

  it('uses the shared backend commands for activity snapshot, navigation, and acknowledgement', async () => {
    const prefs = await import('../src/desktopPet')
    const task = { agent: 'codex' as const, path: 'C:/sessions/task.jsonl' }

    await prefs.fetchDesktopPetTasks()
    await prefs.openDesktopPetSession(task)
    await prefs.acknowledgeDesktopPetTask(task)
    await prefs.resolveDesktopPetSession(task)

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'desktop_pet_tasks')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'open_desktop_pet_session', task)
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'acknowledge_desktop_pet_task', task)
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'resolve_desktop_pet_session', task)
  })
})
