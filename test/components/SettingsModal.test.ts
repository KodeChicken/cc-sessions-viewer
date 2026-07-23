import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { appVersionMock, checkAppUpdateMock, emitToMock, installTurnHooksMock, openPathExternalMock, tauriInvokeMock, turnHookStatusMock } = vi.hoisted(() => ({
  appVersionMock: vi.fn(),
  checkAppUpdateMock: vi.fn(),
  emitToMock: vi.fn(),
  installTurnHooksMock: vi.fn(),
  openPathExternalMock: vi.fn(),
  tauriInvokeMock: vi.fn(),
  turnHookStatusMock: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ emitTo: emitToMock }))
vi.mock('../../src/api', () => ({
  appVersion: appVersionMock,
  installTurnHooks: installTurnHooksMock,
  openPathExternal: openPathExternalMock,
  turnHookStatus: turnHookStatusMock,
}))
vi.mock('../../src/updateCheck', async (importOriginal) => {
  const orig: any = await importOriginal()
  return { ...orig, checkAppUpdate: checkAppUpdateMock }
})

import SettingsModal from '../../src/components/SettingsModal.vue'
import { vTooltip } from '../../src/tooltip'
import { lang, setLang, setTheme, theme } from '../../src/settings'
import {
  turnHookStatus,
  turnHookStatusError,
  turnHookStatusLoading,
} from '../../src/turnHookStatus'
import {
  desktopPetCharacter,
  desktopPetEnabled,
  setDesktopPetCharacter,
  setDesktopPetEnabled,
} from '../../src/desktopPet'

const fullHookStatus = {
  enabled: true,
  claude: {
    installed: true,
    configPath: '/home/test/.claude/settings.json',
    events: ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest']
      .map((name) => ({ name, installed: true })),
    hooks: [
      {
        event: 'PreToolUse',
        category: null,
        matcher: 'Bash',
        hookType: 'command',
        detail: 'echo external-hook',
        managed: false,
      },
      {
        event: 'UserPromptSubmit',
        category: null,
        matcher: null,
        hookType: 'command',
        detail: 'node turn-signal-hook.cjs',
        managed: true,
      },
    ],
  },
  codex: {
    installed: true,
    configPath: '/home/test/.codex/hooks.json',
    events: ['UserPromptSubmit', 'Stop', 'PermissionRequest']
      .map((name) => ({ name, installed: true })),
    hooks: [{
      event: 'Stop',
      category: null,
      matcher: null,
      hookType: 'command',
      detail: 'node turn-signal-hook.cjs',
      managed: true,
    }],
  },
  agy: {
    installed: true,
    configPath: '/home/test/.gemini/config/hooks.json',
    events: ['PreInvocation', 'Stop'].map((name) => ({ name, installed: true })),
    hooks: [{
      event: 'PreInvocation',
      category: 'cc-sessions-viewer-turn-status',
      matcher: null,
      hookType: 'command',
      detail: 'node turn-signal-hook.cjs',
      managed: true,
    }],
  },
}

beforeEach(() => {
  setLang('en')
  setTheme('system')
  appVersionMock.mockReset().mockResolvedValue('9.9.9')
  checkAppUpdateMock.mockReset()
  installTurnHooksMock.mockReset().mockResolvedValue({})
  openPathExternalMock.mockReset().mockResolvedValue(undefined)
  tauriInvokeMock.mockReset().mockResolvedValue(undefined)
  emitToMock.mockReset().mockResolvedValue(undefined)
  turnHookStatusMock.mockReset().mockResolvedValue(fullHookStatus)
  turnHookStatus.value = null
  turnHookStatusLoading.value = false
  turnHookStatusError.value = ''
  setDesktopPetEnabled(false)
  setDesktopPetCharacter('momo')
})
afterEach(() => {
  setLang('en')
  setTheme('system')
})

type Props = InstanceType<typeof SettingsModal>['$props']
const factory = (props: Partial<Props> = {}) =>
  mount(SettingsModal, {
    props: { cacheBytes: 0, ...props } as Props,
    global: { directives: { tooltip: vTooltip } },
    attachTo: document.body,
  })

describe('SettingsModal', () => {
  it('shows a human-readable cache size', () => {
    expect(factory({ cacheBytes: 2048 }).find('.set-section-tail').text()).toBe('2.0 KB')
  })

  it('shows "0 B" and the clear button is always enabled', () => {
    const wrapper = factory({ cacheBytes: 0 })
    expect(wrapper.find('.set-section-tail').text()).toBe('0 B')
    expect(wrapper.find('.btn.danger').attributes('disabled')).toBeUndefined()
  })

  it('enables the clear button and emits clearCache when there is cached data', async () => {
    const wrapper = factory({ cacheBytes: 4096 })
    const clearBtn = wrapper.find('.btn.danger')
    expect(clearBtn.attributes('disabled')).toBeUndefined()
    await clearBtn.trigger('click')
    expect(wrapper.emitted('clearCache')).toHaveLength(1)
  })

  it('emits close only from the X button, not the overlay backdrop', async () => {
    const wrapper = factory()
    await wrapper.find('.overlay').trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.find('.modal-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('switches language via the custom dropdown', async () => {
    const wrapper = factory()
    const dropdowns = wrapper.findAll('.set-dropdown-btn')
    await dropdowns[0].trigger('click')
    const items = wrapper.findAll('.set-dropdown-item')
    expect(items.length).toBeGreaterThanOrEqual(4)
    await items[1].trigger('click') // 简体中文
    expect(lang.value).toBe('zh')
  })

  it('switches theme via the custom dropdown', async () => {
    const wrapper = factory()
    const dropdowns = wrapper.findAll('.set-dropdown-btn')
    await dropdowns[1].trigger('click')
    const items = wrapper.findAll('.set-dropdown-item')
    // find the Dracula option (last one)
    await items[items.length - 1].trigger('click')
    expect(theme.value).toBe('dracula')
  })

  it('loads the app version on mount', async () => {
    // 版本与更新操作现在住在「Updates」tab 里
    const wrapper = factory({ initialTab: 'updates' })
    await flushPromises()
    expect(appVersionMock).toHaveBeenCalled()
    expect(wrapper.text()).toContain('v9.9.9')
  })

  it('shows hook config files without rendering individual hook details', async () => {
    turnHookStatus.value = fullHookStatus
    const wrapper = factory({ initialTab: 'hooks' })

    const files = wrapper.findAll('.set-hook-file')
    expect(files).toHaveLength(3)
    expect(wrapper.text()).toContain('3 files')
    expect(wrapper.text()).toContain('2 hooks')
    expect(wrapper.text()).not.toContain('echo external-hook')
    expect(wrapper.find('.set-desktop-pet-card').exists()).toBe(false)

    await files[0].trigger('click')
    expect(openPathExternalMock).toHaveBeenCalledWith('/home/test/.claude/settings.json')
    expect(wrapper.find('.set-hooks-enable').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.set-hooks-enable').text()).toContain('Enabled')
  })

  it('keeps the hook action enabled for a partial install and refreshes after repair', async () => {
    turnHookStatus.value = {
      ...fullHookStatus,
      enabled: false,
      codex: {
        ...fullHookStatus.codex,
        installed: false,
        events: fullHookStatus.codex.events.map((event, index) => ({
          ...event,
          installed: index !== 0,
        })),
      },
    }
    const wrapper = factory({ initialTab: 'hooks' })
    const action = wrapper.find('.set-hooks-enable')
    expect(action.attributes('disabled')).toBeUndefined()

    await action.trigger('click')
    await flushPromises()

    expect(installTurnHooksMock).toHaveBeenCalledOnce()
    expect(turnHookStatusMock).toHaveBeenCalledOnce()
    expect(wrapper.find('.set-hooks-enable').attributes('disabled')).toBeDefined()
  })

  it('disables desktop pet enablement until all tracking hooks are installed', () => {
    turnHookStatus.value = {
      ...fullHookStatus,
      enabled: false,
      codex: { ...fullHookStatus.codex, installed: false },
    }
    const wrapper = factory({ initialTab: 'pet' })

    expect(wrapper.get('.set-desktop-pet-toggle').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Enable session status tracking in Hooks')
  })

  it('opens the desktop pet and switches its character when hooks are ready', async () => {
    turnHookStatus.value = fullHookStatus
    const wrapper = factory({ initialTab: 'pet' })

    await wrapper.get('.set-desktop-pet-toggle').trigger('click')
    await flushPromises()
    expect(tauriInvokeMock).toHaveBeenCalledWith('set_desktop_pet_enabled', { enabled: true })
    expect(desktopPetEnabled.value).toBe(true)

    await wrapper.findAll('.set-desktop-pet-character')[1].trigger('click')
    await flushPromises()
    expect(desktopPetCharacter.value).toBe('lumi')
    expect(emitToMock).toHaveBeenCalledWith(
      'desktop-pet',
      'desktop-pet://character',
      { character: 'lumi' },
    )
  })

  it('reports when an update is available', async () => {
    checkAppUpdateMock.mockResolvedValue({ hasUpdate: true, latest: '2.0.0', current: '1.0.0' })
    const wrapper = factory({ initialTab: 'updates' })
    await flushPromises()

    const checkBtn = wrapper.find('.set-update-cta .btn')
    await checkBtn.trigger('click')
    await flushPromises()

    expect(checkAppUpdateMock).toHaveBeenCalled()
    expect(wrapper.text()).toContain('2.0.0')
  })

  it('reports when the app is up to date', async () => {
    checkAppUpdateMock.mockResolvedValue({ hasUpdate: false, latest: '1.0.0', current: '1.0.0' })
    const wrapper = factory({ initialTab: 'updates' })
    await flushPromises()

    const checkBtn = wrapper.find('.set-update-cta .btn')
    await checkBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('latest version')
  })

  it('surfaces a failed update check', async () => {
    checkAppUpdateMock.mockRejectedValue(new Error('offline'))
    const wrapper = factory({ initialTab: 'updates' })
    await flushPromises()

    const checkBtn = wrapper.find('.set-update-cta .btn')
    await checkBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Update check failed')
  })
})
