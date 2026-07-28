import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'

const api = vi.hoisted(() => ({
  ptySpawn: vi.fn(async () => 41),
  ptySpawnNew: vi.fn(async () => 42),
  ptySpawnShell: vi.fn(async () => 43),
  ptyWrite: vi.fn(async () => undefined),
  ptyResize: vi.fn(async () => undefined),
  ptyKill: vi.fn(async () => undefined),
  watchSessionTurn: vi.fn(async () => undefined),
  unwatchSessionTurn: vi.fn(async () => undefined),
  saveClipboardImage: vi.fn(async () => 'clipboard.png'),
}))

vi.mock('../src/api', () => api)
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}))

import {
  closeTab,
  openOrFocusTui,
  openShellTab,
  tabs,
} from '../src/terminals'

function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function populateScrollback(term: Terminal) {
  term.resize(8, 2)
  await write(term, 'one\r\ntwo\r\nthree\r\nfour')
  const buffer = term.buffer.active
  expect(buffer.baseY).toBeGreaterThan(0)
  return {
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    firstLine: buffer.getLine(0)?.translateToString(true),
  }
}

async function openTui(agent: 'codex' | 'claude') {
  await openOrFocusTui({
    agent,
    projectKey: `project-${agent}`,
    sessionId: `session-${agent}`,
    sessionPath: `session-${agent}.jsonl`,
    title: agent,
    cwd: 'C:\\workspace',
  })
  return tabs.value.at(-1)!.term
}

beforeEach(() => {
  vi.spyOn(Terminal.prototype, 'open').mockImplementation(() => undefined)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  for (const tab of [...tabs.value]) closeTab(tab.uiId)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('terminal scrollback protection', () => {
  it('preserves Codex scrollback when the TUI emits CSI 3 J', async () => {
    const term = await openTui('codex')
    const before = await populateScrollback(term)

    await write(term, '\x1b[3J')

    expect(term.buffer.active.baseY).toBe(before.baseY)
    expect(term.buffer.active.viewportY).toBe(before.viewportY)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(before.firstLine)
  })

  it.each([
    ['0', '\x1b[H\x1b[0J'],
    ['1', '\x1b[2;8H\x1b[1J'],
    ['2', '\x1b[2J'],
  ])('leaves ordinary Codex CSI %s J screen erasure enabled', async (_param, sequence) => {
    const term = await openTui('codex')
    const before = await populateScrollback(term)

    await write(term, sequence)

    expect(term.buffer.active.baseY).toBe(before.baseY)
    for (let row = 0; row < term.rows; row += 1) {
      expect(
        term.buffer.active
          .getLine(term.buffer.active.baseY + row)
          ?.translateToString(true),
      ).toBe('')
    }
  })

  it('leaves CSI 3 J enabled for non-Codex TUI tabs', async () => {
    const term = await openTui('claude')
    await populateScrollback(term)

    await write(term, '\x1b[3J')

    expect(term.buffer.active.baseY).toBe(0)
    expect(term.buffer.active.viewportY).toBe(0)
  })

  it('leaves CSI 3 J enabled for embedded Shell tabs', async () => {
    await openShellTab({
      agent: 'codex',
      projectKey: 'project-shell',
      title: 'Shell',
      cwd: 'C:\\workspace',
    })
    const term = tabs.value.at(-1)!.term
    await populateScrollback(term)

    await write(term, '\x1b[3J')

    expect(term.buffer.active.baseY).toBe(0)
    expect(term.buffer.active.viewportY).toBe(0)
  })
})
