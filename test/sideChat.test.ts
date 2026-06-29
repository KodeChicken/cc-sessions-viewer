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

import { sideChat, openSideChat, closeSideChat } from '../src/sideChat'

/** 取最近一次某命令的 invoke 参数对象。 */
function lastInvoke(cmd: string): Record<string, unknown> | undefined {
  const calls = invokeMock.mock.calls.filter((c) => c[0] === cmd)
  return calls.length ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined
}

describe('btw side chat store', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    // 每个用例从「无侧聊」起步：直接清 ref（不走 closeSideChat 以免多一次 stop invoke）。
    sideChat.value = null
  })

  it('forks the main session when a sessionId is given (inherits context, plan mode)', async () => {
    invokeMock.mockResolvedValueOnce({ chatId: 1, processModel: 'longLivedStdin' })
    await openSideChat({ projectKey: 'proj', cwd: '/tmp', forkSessionId: 'sess-1' })

    const args = lastInvoke('agent_chat_start')
    expect(args).toMatchObject({
      agent: 'claude',
      cwd: '/tmp',
      sessionId: 'sess-1',
      fork: true,
      permissionMode: 'plan',
    })
    expect(sideChat.value).not.toBeNull()
  })

  it('starts a fresh side chat when there is no main session to fork', async () => {
    invokeMock.mockResolvedValueOnce({ chatId: 2, processModel: 'longLivedStdin' })
    await openSideChat({ projectKey: 'proj', cwd: '/tmp' })

    const args = lastInvoke('agent_chat_start')
    expect(args).toMatchObject({ agent: 'claude', fork: false, sessionId: undefined })
  })

  it('sends the /btw prompt as the first message', async () => {
    invokeMock.mockResolvedValueOnce({ chatId: 3, processModel: 'longLivedStdin' })
    invokeMock.mockResolvedValueOnce(undefined) // agent_chat_send
    await openSideChat({ projectKey: 'proj', cwd: '/tmp', prompt: 'what does foo do?' })

    const sent = lastInvoke('agent_chat_send')
    expect(sent?.text).toContain('what does foo do?')
  })

  it('reuses the open panel instead of spawning a second process', async () => {
    invokeMock.mockResolvedValueOnce({ chatId: 4, processModel: 'longLivedStdin' })
    await openSideChat({ projectKey: 'proj', cwd: '/tmp' })
    const startsAfterFirst = invokeMock.mock.calls.filter((c) => c[0] === 'agent_chat_start').length

    invokeMock.mockResolvedValueOnce(undefined) // agent_chat_send for the follow-up
    await openSideChat({ projectKey: 'proj', cwd: '/tmp', prompt: 'follow up' })

    const startsAfterSecond = invokeMock.mock.calls.filter((c) => c[0] === 'agent_chat_start').length
    expect(startsAfterSecond).toBe(startsAfterFirst) // no new process
    expect(lastInvoke('agent_chat_send')?.text).toContain('follow up')
  })

  it('closeSideChat stops the subprocess and clears the ref', async () => {
    invokeMock.mockResolvedValueOnce({ chatId: 5, processModel: 'longLivedStdin' })
    await openSideChat({ projectKey: 'proj', cwd: '/tmp' })
    invokeMock.mockResolvedValueOnce(undefined) // agent_chat_stop

    closeSideChat()
    await Promise.resolve()
    expect(sideChat.value).toBeNull()
    expect(lastInvoke('agent_chat_stop')).toMatchObject({ id: 5 })
  })
})
