import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { eventHandlers, invokeMock, listenMock, startDraggingMock } = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload?: any }) => void | Promise<void>>(),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  startDraggingMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn().mockResolvedValue(undefined),
  listen: listenMock,
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging: startDraggingMock }),
}))

import DesktopPet from '../../src/components/DesktopPet.vue'
import { setDesktopPetCharacter } from '../../src/desktopPet'
import { setLang } from '../../src/settings'

const taskSnapshot = [
  {
    agent: 'codex',
    path: 'C:/sessions/one.jsonl',
    state: 'started',
    title: 'one',
    updatedAt: Date.now(),
  },
  {
    agent: 'claude',
    path: 'C:/sessions/two.jsonl',
    state: 'failed',
    title: 'two',
    updatedAt: Date.now() - 60_000,
  },
]
let currentSnapshot = taskSnapshot

beforeEach(() => {
  setLang('en')
  setDesktopPetCharacter('momo')
  eventHandlers.clear()
  currentSnapshot = taskSnapshot
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'desktop_pet_tasks') return Promise.resolve(currentSnapshot)
    return Promise.resolve(undefined)
  })
  startDraggingMock.mockReset().mockResolvedValue(undefined)
  listenMock.mockReset().mockImplementation((event: string, handler: (event: { payload?: any }) => void | Promise<void>) => {
    eventHandlers.set(event, handler)
    return Promise.resolve(vi.fn())
  })
})

async function factory() {
  const wrapper = mount(DesktopPet, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('DesktopPet', () => {
  it('keeps progress hidden until the pet is hovered', async () => {
    const wrapper = await factory()

    expect(wrapper.get('.pet-art').find('svg').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-head').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-ear-left').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-tail').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-paw-left').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-laptop').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-screen-beam').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-face-light').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-face-light').element.tagName.toLowerCase()).toBe('path')
    expect(wrapper.get('.pet-art').find('.pet-mouth-happy').exists()).toBe(true)
    expect(wrapper.classes()).toContain('has-running')
    expect(wrapper.classes()).toContain('has-failed')
    expect(wrapper.get('.status-notice.is-failed').text()).toContain('Task failed')
    expect(wrapper.find('.task-panel').exists()).toBe(false)
    await wrapper.get('.character-area').trigger('mouseenter')

    expect(wrapper.find('.status-notices').exists()).toBe(false)
    expect(wrapper.get('.status-pill.is-started strong').text()).toBe('1')
    expect(wrapper.get('.status-pill.is-blocked strong').text()).toBe('0')
    expect(wrapper.get('.status-pill.is-completed strong').text()).toBe('0')
    expect(wrapper.get('.status-pill.is-failed strong').text()).toBe('1')
  })

  it('opens the hovered task in the main session viewer', async () => {
    const wrapper = await factory()

    await wrapper.get('.character-area').trigger('mouseenter')
    await wrapper.get('.task-item').trigger('click')

    expect(invokeMock).toHaveBeenCalledWith('open_desktop_pet_session', {
      agent: 'codex',
      path: 'C:/sessions/one.jsonl',
      title: 'one',
    })
  })

  it('keeps progress open while the mouse crosses from the pet to the task panel', async () => {
    const wrapper = await factory()
    vi.useFakeTimers()

    try {
      await wrapper.get('.character-area').trigger('mouseenter')
      await wrapper.get('.character-area').trigger('mouseleave')
      await wrapper.get('.task-panel').trigger('mouseenter')
      vi.advanceTimersByTime(200)
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.task-panel').exists()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('updates the rendered character from the live event', async () => {
    const wrapper = await factory()

    eventHandlers.get('desktop-pet://character')?.({ payload: { character: 'lumi' } })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.pet-art').attributes('data-character')).toBe('lumi')
    expect(wrapper.get('.pet-art').attributes('aria-label').toLowerCase()).toContain('lumi')
    expect(wrapper.get('.pet-art').find('.pet-tail').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-paw-left').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-screen-light').exists()).toBe(true)

    eventHandlers.get('desktop-pet://character')?.({ payload: { character: 'kumo' } })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.pet-art').attributes('data-character')).toBe('kumo')
    expect(wrapper.get('.pet-art').find('.pet-wing-left').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-wing-right').exists()).toBe(true)
    expect(wrapper.get('.pet-art').find('.pet-screen-light').exists()).toBe(true)
  })

  it('animates and links the notice for a new completed event', async () => {
    const wrapper = await factory()
    currentSnapshot = [{ ...taskSnapshot[0], state: 'completed' }]

    await eventHandlers.get('terminal-turn://state')?.({
      payload: {
        agent: 'codex',
        path: 'C:/sessions/one.jsonl',
        state: 'completed',
      },
    })
    await flushPromises()

    expect(wrapper.classes()).toContain('is-celebrating')
    expect(wrapper.get('.status-notice.is-completed').text()).toContain('Task completed')

    await wrapper.get('.status-notice.is-completed').trigger('click')
    await flushPromises()
    expect(invokeMock).toHaveBeenCalledWith('open_desktop_pet_session', {
      agent: 'codex',
      path: 'C:/sessions/one.jsonl',
      title: 'one',
    })
    expect(wrapper.find('.status-notice.is-completed').exists()).toBe(false)

    await wrapper.get('.character-area').trigger('mouseenter')
    expect(wrapper.get('.status-pill.is-completed strong').text()).toBe('0')
    expect(wrapper.find('.task-item').exists()).toBe(false)
  })

  it('raises the approval state when a task is blocked', async () => {
    currentSnapshot = [{ ...taskSnapshot[0], state: 'blocked' }]
    const wrapper = await factory()

    expect(wrapper.classes()).toContain('has-blocked')
    expect(wrapper.get('.approval-mark').text()).toBe('!')
    expect(wrapper.get('.status-notice.is-blocked').text()).toContain('needs approval')
    expect(wrapper.classes()).not.toContain('has-running')
  })

  it('keeps one notice for every current terminal state without replaying completion animation', async () => {
    currentSnapshot = [
      { ...taskSnapshot[0], state: 'completed', updatedAt: Date.now() },
      { ...taskSnapshot[1], state: 'blocked', updatedAt: Date.now() - 1 },
      { ...taskSnapshot[0], path: 'C:/sessions/three.jsonl', state: 'failed', updatedAt: Date.now() - 2 },
    ]
    const wrapper = await factory()

    expect(wrapper.classes()).not.toContain('is-celebrating')
    expect(wrapper.findAll('.status-notice')).toHaveLength(3)
    expect(wrapper.get('.status-notice.is-completed').exists()).toBe(true)
    expect(wrapper.get('.status-notice.is-blocked').exists()).toBe(true)
    expect(wrapper.get('.status-notice.is-failed').exists()).toBe(true)
  })
})
