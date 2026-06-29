import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))

import { chatEffectiveEffortForTest, interruptChat, parseRetryLine, startChat } from '../src/chatSessions'

describe('chatSessions Claude API-key compatibility', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('drops Claude effort for API-key sessions', () => {
    expect(
      chatEffectiveEffortForTest({
        agent: 'claude',
        model: 'claude-opus-4-8',
        effort: 'high',
        apiKeySource: 'ANTHROPIC_API_KEY',
      }),
    ).toBeUndefined()
  })

  it('keeps Claude effort for subscription sessions', () => {
    expect(
      chatEffectiveEffortForTest({
        agent: 'claude',
        model: 'claude-opus-4-8',
        effort: 'high',
        apiKeySource: 'none',
      }),
    ).toBe('high')
  })

  it('starts Claude chat without forcing a default model or effort', async () => {
    invokeMock.mockResolvedValueOnce({ chatId: 1, processModel: 'longLivedStdin' })
    const s = await startChat({
      agent: 'claude',
      projectKey: 'proj',
      cwd: '/tmp',
      title: 'Chat',
    })
    expect(s.model).toBeUndefined()
    expect(s.effort).toBeUndefined()
    expect(invokeMock).toHaveBeenCalledWith(
      'agent_chat_start',
      expect.objectContaining({
        agent: 'claude',
        model: undefined,
        effort: undefined,
      }),
    )
  })

  it('interrupts the current Claude turn by restarting the long-lived process with resume', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    invokeMock.mockResolvedValueOnce({ chatId: 8, processModel: 'longLivedStdin' })
    const session = {
      chatId: 7,
      agent: 'claude',
      cwd: '/tmp',
      sessionId: 'sess-1',
      permissionMode: 'acceptEdits',
      model: undefined,
      effort: undefined,
      apiKeySource: 'none',
      processModel: 'longLivedStdin',
      applied: { permissionMode: 'acceptEdits', model: undefined, effort: undefined },
      status: 'running',
      turnState: 'running',
      turnStartedAt: Date.now(),
      lastTurnMs: 0,
      msgs: [],
      live: { kind: 'text', text: 'hello' },
    } as any
    await interruptChat(session)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_chat_stop', { id: 7 })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_chat_start', {
      agent: 'claude',
      cwd: '/tmp',
      sessionId: 'sess-1',
      permissionMode: 'acceptEdits',
      model: undefined,
      effort: undefined,
    })
    expect(session.chatId).toBe(8)
    expect(session.status).toBe('running')
    expect(session.turnState).toBe('idle')
    expect(session.live).toBeNull()
    expect(session.msgs).toHaveLength(1)
    expect(session.msgs[0].role).toBe('user')
    expect(session.msgs[0].blocks[0].text).toBe('[Request interrupted by user]')
  })
})

describe('parseRetryLine — network-retry detection from CLI stderr', () => {
  it('extracts attempt/max from "(N/M)" form', () => {
    expect(parseRetryLine('Request failed · retrying (4/10) · 24s')).toEqual({ attempt: 4, max: 10 })
  })

  it('extracts attempt/max from "N of M" form', () => {
    expect(parseRetryLine('API error, retrying 2 of 5...')).toEqual({ attempt: 2, max: 5 })
  })

  it('matches transient-error keywords without a count → empty object', () => {
    expect(parseRetryLine('Overloaded, backing off')).toEqual({})
    expect(parseRetryLine('fetch failed: ECONNRESET')).toEqual({})
    expect(parseRetryLine('socket hang up')).toEqual({})
  })

  it('is case-insensitive', () => {
    expect(parseRetryLine('RETRYING request')).toEqual({})
  })

  it('returns null for unrelated stderr lines', () => {
    expect(parseRetryLine('[debug] loaded 3 of 4 plugins')).toBeNull()
    expect(parseRetryLine('Reading config from ~/.claude')).toBeNull()
    expect(parseRetryLine('')).toBeNull()
  })
})
