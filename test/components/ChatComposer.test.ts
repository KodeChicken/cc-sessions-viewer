import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatComposer from '../../src/components/ChatComposer.vue'
import { vTooltip } from '../../src/tooltip'
import { setLang } from '../../src/settings'
import type { ChatSession } from '../../src/chatSessions'

const { claudeRuntimeInfoMock } = vi.hoisted(() => ({
  claudeRuntimeInfoMock: vi.fn().mockResolvedValue({ hasCustomBaseUrl: false }),
}))

vi.mock('../../src/api', () => ({
  agentChatSlashCommands: vi.fn().mockResolvedValue([]),
  claudeRuntimeInfo: claudeRuntimeInfoMock,
}))

vi.mock('../../src/usage', () => ({
  usage: { value: null },
  usageWindows: vi.fn(() => [
    { key: 'five_hour', usedPct: 0, resetsAt: new Date(Date.now() + 60_000).toISOString() },
    { key: 'seven_day', usedPct: 0, resetsAt: new Date(Date.now() + 120_000).toISOString() },
  ]),
  usageLevel: vi.fn(() => 'ok'),
  formatRemaining: vi.fn(() => ''),
  nowMs: { value: Date.now() },
  startUsagePolling: vi.fn(),
  stopUsagePolling: vi.fn(),
  bumpUsage: vi.fn(),
}))

const baseSession = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    uiId: 1,
    chatId: 1,
    agent: 'claude',
    projectKey: 'proj',
    cwd: '/work/proj',
    sessionId: 's1',
    title: 'Chat',
    createdAt: new Date().toISOString(),
    msgs: [],
    turnState: 'idle',
    turnStartedAt: 0,
    lastTurnMs: 0,
    status: 'running',
    usage: undefined,
    lastModel: undefined,
    apiKeySource: 'none',
    errorMessage: undefined,
    stderrTail: [],
    live: null,
    permissionMode: 'acceptEdits',
    model: 'claude-opus-4-8',
    effort: 'high',
    processModel: 'longLivedStdin',
    applied: { permissionMode: 'acceptEdits', model: 'claude-opus-4-8', effort: 'high' },
    ...over,
  }) as ChatSession

describe('ChatComposer', () => {
  it('hides the effort slider for Claude API-key sessions', () => {
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: 'ANTHROPIC_API_KEY' }) },
      global: { directives: { tooltip: vTooltip } },
    })
    expect(wrapper.findComponent({ name: 'ChatEffortSlider' }).exists()).toBe(false)
  })

  it('hides effort and rate limits for Claude custom endpoints even when apiKeySource reports none', async () => {
    claudeRuntimeInfoMock.mockResolvedValueOnce({ hasCustomBaseUrl: true })
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: 'none' }) },
      global: { directives: { tooltip: vTooltip } },
    })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'ChatEffortSlider' }).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('5h')
    expect(wrapper.text()).not.toContain('week')
  })

  it('keeps the model picker for Claude API-key sessions so settings.json model mapping can apply', () => {
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: 'ANTHROPIC_API_KEY' }) },
      global: { directives: { tooltip: vTooltip } },
    })
    expect(wrapper.findComponent({ name: 'ChatModelMenu' }).exists()).toBe(true)
    expect(wrapper.text()).toContain('Opus')
  })

  it('keeps the effort slider for Claude subscription sessions', () => {
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: 'none' }) },
      global: { directives: { tooltip: vTooltip } },
    })
    expect(wrapper.findComponent({ name: 'ChatEffortSlider' }).exists()).toBe(true)
  })

  it('hides the effort slider while Claude apiKeySource is still unknown', () => {
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: undefined }) },
      global: { directives: { tooltip: vTooltip } },
    })
    expect(wrapper.findComponent({ name: 'ChatEffortSlider' }).exists()).toBe(false)
  })

  it('hides subscription rate-limit badges until Claude apiKeySource is confirmed as none', () => {
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: undefined }) },
      global: { directives: { tooltip: vTooltip } },
    })
    expect(wrapper.text()).not.toContain('5h')
    expect(wrapper.text()).not.toContain('week')
  })

  it('seeds effort slider + rate limits from the runtime guess before init arrives', async () => {
    // runtime_info 预判官方订阅（钥匙串有凭证）→ session.apiKeySource 还没回来也该立刻显示。
    claudeRuntimeInfoMock.mockResolvedValueOnce({ hasCustomBaseUrl: false, apiKeySource: 'none' })
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: undefined }) },
      global: { directives: { tooltip: vTooltip } },
    })
    // 预判前：仍是保守态（未知 → 不显示）。
    expect(wrapper.findComponent({ name: 'ChatEffortSlider' }).exists()).toBe(false)
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    // 预判落地后：官方专属元素出现，无需等首轮 init。
    expect(wrapper.findComponent({ name: 'ChatEffortSlider' }).exists()).toBe(true)
    expect(wrapper.text()).toContain('5h')
  })

  it('lets a real init apiKeySource override the runtime guess', async () => {
    // runtime 误判成订阅，但 init 权威地说是 API key → 以 init 为准，隐藏 effort。
    claudeRuntimeInfoMock.mockResolvedValueOnce({ hasCustomBaseUrl: false, apiKeySource: 'none' })
    setLang('en')
    const wrapper = mount(ChatComposer, {
      props: { session: baseSession({ apiKeySource: 'ANTHROPIC_API_KEY' }) },
      global: { directives: { tooltip: vTooltip } },
    })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'ChatEffortSlider' }).exists()).toBe(false)
  })
})
