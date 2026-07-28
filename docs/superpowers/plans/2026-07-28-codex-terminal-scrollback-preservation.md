# Codex Terminal Scrollback Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent embedded Codex TUI redraws from deleting xterm scrollback when Codex emits `CSI 3 J`.

**Architecture:** Add one focused module that registers an xterm CSI `J` handler and consumes parameter `3` only for non-shell Codex tabs. Register it from both existing terminal construction paths so the same policy explicitly preserves the default behavior for Shell and other agents. Exercise the real xterm parser and buffer through the existing terminal-opening APIs.

**Tech Stack:** Vue 3, TypeScript 6, xterm.js 6, Vitest 4, jsdom.

## Global Constraints

- Consume only non-private `CSI 3 J` for a non-shell Codex TUI tab.
- Let `CSI 0 J`, `CSI 1 J`, and `CSI 2 J` continue to xterm's default handler.
- Do not change search navigation, mouse/scrollbar/PageUp/PageDown scrolling, embedded Shell tabs, Claude, agy, or OpenCode tabs.
- Do not add an always-follow-bottom behavior.
- Remove the temporary runtime diagnostics before committing.

---

## File Structure

- Create `src/terminalScrollback.ts`: own the Codex-specific erase-in-display policy and xterm parser registration.
- Create `test/terminalScrollback.test.ts`: exercise terminal construction, real xterm parsing, scrollback retention, and unaffected branches.
- Modify `src/terminals.ts`: install the policy in the existing agent-TUI and Shell terminal constructors.
- Modify `src/components/TerminalPaneSlot.vue`: remove the temporary runtime probe and restore ordinary attach/refit behavior.
- Delete `src/terminalScrollDiagnostics.ts`: remove the diagnostic-only event recorder and logging.

### Task 1: Add the Regression Test and Scrollback Protection

**Files:**
- Create: `test/terminalScrollback.test.ts`
- Create: `src/terminalScrollback.ts`
- Modify: `src/terminals.ts:24-55`
- Modify: `src/terminals.ts:1285-1300`
- Modify: `src/terminals.ts:1510-1525`

**Interfaces:**
- Consumes: `Terminal.parser.registerCsiHandler({ final: 'J' }, callback)` from xterm.js and the existing `Agent` union.
- Produces: `installTerminalScrollbackProtection(term: Terminal, agent: Agent, isShell: boolean): void`.

- [ ] **Step 1: Write the failing real-xterm regression test**

Create `test/terminalScrollback.test.ts` with hoisted Tauri boundary fakes, while keeping the xterm parser and buffer real:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run test:run -- test/terminalScrollback.test.ts
```

Expected: the Codex `CSI 3 J` test fails because xterm changes `baseY` and `viewportY` to `0`; the ordinary `CSI 0/1/2 J`, non-Codex, and Shell characterization tests pass.

- [ ] **Step 3: Add the minimal parser-level implementation**

Create `src/terminalScrollback.ts`:

```ts
import type { Terminal } from '@xterm/xterm'
import type { Agent } from './types'

type CsiParams = (number | number[])[]

function shouldConsumeEraseInDisplay(
  agent: Agent,
  isShell: boolean,
  params: CsiParams,
): boolean {
  return agent === 'codex' && !isShell && params[0] === 3
}

export function installTerminalScrollbackProtection(
  term: Terminal,
  agent: Agent,
  isShell: boolean,
): void {
  term.parser.registerCsiHandler(
    { final: 'J' },
    (params) => shouldConsumeEraseInDisplay(agent, isShell, params),
  )
}
```

Import it in `src/terminals.ts`:

```ts
import { installTerminalScrollbackProtection } from './terminalScrollback'
```

Immediately after each `new Terminal(...)` construction, register the handler with explicit context:

```ts
installTerminalScrollbackProtection(term, opts.agent, false)
```

and in `openShellTab`:

```ts
installTerminalScrollbackProtection(term, opts.agent, true)
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
npm run test:run -- test/terminalScrollback.test.ts test/terminals.test.ts test/terminalSelectionDelete.test.ts
```

Expected: all focused terminal tests pass. The Codex test retains its original `baseY`, `viewportY`, and first scrollback line; Shell and Claude still trim scrollback.

### Task 2: Remove the Diagnostic Probe and Review the Diff

**Files:**
- Modify: `src/components/TerminalPaneSlot.vue:6-76`
- Delete: `src/terminalScrollDiagnostics.ts`

**Interfaces:**
- Consumes: the permanent parser protection from Task 1.
- Produces: production code without temporary timestamp logging, polling, DOM event probes, or diagnostic file writes.

- [ ] **Step 1: Restore the ordinary terminal slot lifecycle**

In `src/components/TerminalPaneSlot.vue`:

- remove imports from `../terminalScrollDiagnostics`;
- remove `disposeScrollDiagnostics`;
- remove every `recordTerminalScrollDiagnostic(...)` call;
- remove `installTerminalScrollDiagnostics(...)`;
- keep `attachActive()`, `refit(id)`, `tab.term.focus()`, the `ResizeObserver`, and terminal detach behavior unchanged.

- [ ] **Step 2: Delete the diagnostic-only module**

Delete `src/terminalScrollDiagnostics.ts`. No production module may reference it afterward.

- [ ] **Step 3: Inspect the complete feature diff**

Run:

```powershell
git diff -- src/terminalScrollback.ts src/terminals.ts src/components/TerminalPaneSlot.vue test/terminalScrollback.test.ts
git status --short
git diff --check
```

Expected: only the permanent scrollback protection, its regression tests, the diagnostic cleanup, the approved design, and this plan remain; `git diff --check` exits `0`.

- [ ] **Step 4: Commit the implementation**

Run:

```powershell
git add src/terminalScrollback.ts src/terminals.ts src/components/TerminalPaneSlot.vue test/terminalScrollback.test.ts docs/superpowers/plans/2026-07-28-codex-terminal-scrollback-preservation.md
git commit -m "fix: preserve codex terminal scrollback"
```

Expected: one conventional fix commit. The deleted untracked diagnostic module is absent and is not staged.

### Task 3: Complete Verification

**Files:**
- Verify: all files changed by Tasks 1 and 2.

**Interfaces:**
- Consumes: committed implementation from Task 2.
- Produces: fresh evidence that the focused behavior, full frontend suite, production bundle, and diff integrity all pass.

- [ ] **Step 1: Run the complete frontend test suite**

Run:

```powershell
npm run test:run
```

Expected: every Vitest file and test passes. Existing jsdom Canvas warnings may remain informational and must not be mistaken for test failures.

- [ ] **Step 2: Run the production frontend build**

Run:

```powershell
npm run build
```

Expected: `vue-tsc --noEmit` and `vite build` exit `0`.

- [ ] **Step 3: Run final repository checks**

Run:

```powershell
git diff --check HEAD^
git status --short
git log -1 --oneline
```

Expected: no whitespace errors, no remaining implementation changes, and the latest commit is `fix: preserve codex terminal scrollback`.

## Self-Review

- Spec coverage: Codex `CSI 3 J`, ordinary erase parameters, Shell, non-Codex agents, real scrollback state, diagnostic cleanup, focused tests, full tests, build, and diff checks each map to a task.
- Placeholder scan: no deferred implementation or unspecified error-handling steps remain.
- Type consistency: the plan consistently uses `installTerminalScrollbackProtection(term, agent, isShell)` and xterm's `(number | number[])[]` CSI parameter type.
