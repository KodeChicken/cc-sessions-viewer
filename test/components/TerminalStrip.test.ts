import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TerminalStrip from '../../src/components/TerminalStrip.vue'
import { vTooltip } from '../../src/tooltip'
import { setLang } from '../../src/settings'
import {
  activeUiId,
  reconcileNewTabs,
  syncTabTitlesFromSessions,
  tabs,
  type TerminalTab,
} from '../../src/terminals'

beforeEach(() => {
  setLang('en')
  activeUiId.value = null
  tabs.value = []
})

function tab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    uiId: 1,
    ptyId: 1,
    agent: 'codex',
    projectKey: 'proj',
    sessionId: '',
    sessionPath: '',
    title: 'New session',
    cwd: '/repo',
    createdAt: 1_000,
    term: {} as TerminalTab['term'],
    fitAddon: {} as TerminalTab['fitAddon'],
    container: document.createElement('div'),
    unlistenData: null,
    unlistenExit: null,
    onDataDisp: null,
    lastSyncedCols: 80,
    lastSyncedRows: 24,
    quietCursor: false,
    quietCursorTimer: null,
    lastUserInputAt: 0,
    status: 'running',
    ...over,
  }
}

function factory() {
  return mount(TerminalStrip, {
    props: {
      agent: 'codex',
      projectKey: 'proj',
      inProjectBrowse: true,
      hasOpenSession: false,
    },
    global: { directives: { tooltip: vTooltip } },
  })
}

describe('TerminalStrip', () => {
  it('opens the tab context menu from right-click and keeps existing actions', async () => {
    const t = tab()
    tabs.value = [t]
    const wrapper = factory()

    await wrapper.findAll('.term-tab').slice(-1)[0].trigger('contextmenu', {
      clientX: 80,
      clientY: 40,
    })

    const actions = wrapper
      .findAll('.term-tab-ctx-menu .ctx-item')
      .map((item) => item.attributes('data-menu-action'))
    expect(actions).toEqual([
      'tab-rename',
      'tab-close',
      'tab-close-others',
      'tab-close-project',
    ])
    expect(wrapper.emitted('tabRename')).toBeUndefined()
  })

  it('does not open the tab context menu from left-click', async () => {
    const t = tab()
    tabs.value = [t]
    const wrapper = factory()

    await wrapper.findAll('.term-tab').slice(-1)[0].trigger('click')

    expect(wrapper.find('.term-tab-more').exists()).toBe(false)
    expect(wrapper.find('.term-tab-ctx-menu').exists()).toBe(false)
    expect(wrapper.emitted('tabRename')).toBeUndefined()
  })

  it('emits tabRename when choosing rename from the context menu', async () => {
    const t = tab()
    tabs.value = [t]
    const wrapper = factory()

    await wrapper.findAll('.term-tab').slice(-1)[0].trigger('contextmenu', {
      clientX: 80,
      clientY: 40,
    })
    await wrapper.find('[data-menu-action="tab-rename"]').trigger('click')

    expect(wrapper.emitted('tabRename')![0]).toEqual([t])
  })

  it('syncs a newly created tab to the matched session title', () => {
    const t = tab({ createdAt: 10_000 })
    tabs.value = [t]

    reconcileNewTabs('proj', [
      {
        path: '/repo/session.jsonl',
        id: 'session-1',
        modified: 12_000,
        title: 'Investigate auth bug',
      },
    ], 'codex')

    expect(t.sessionPath).toBe('/repo/session.jsonl')
    expect(t.sessionId).toBe('session-1')
    expect(t.title).toBe('Investigate auth bug')
  })

  it('syncs existing tab titles from refreshed sessions', () => {
    const t = tab({
      sessionId: 'session-1',
      sessionPath: '/repo/session.jsonl',
      title: 'New session',
    })
    tabs.value = [t]

    syncTabTitlesFromSessions('codex', 'proj', [
      {
        path: '/repo/session.jsonl',
        id: 'session-1',
        modified: 12_000,
        title: 'Generated title',
      },
    ])

    expect(t.title).toBe('Generated title')
  })
})
