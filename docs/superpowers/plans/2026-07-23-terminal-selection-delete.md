# Integrated TUI Selection Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow one plain Windows `Delete` press to remove a safely identifiable mouse selection from the current, unsubmitted integrated Codex/Claude TUI input.

**Architecture:** Extend the existing terminal input tracker into a cursor-aware, reliability-aware pure state reducer. Add a separate pure selection-to-keystroke planner, then connect it to the agent TUI custom key handler through a small testable adapter while leaving shell tabs and the native GUI textarea unchanged.

**Tech Stack:** TypeScript 6, Vue 3 reactive state, xterm.js 6, Vitest 4, Tauri PTY bridge.

---

## File Structure

- Modify `src/tabStatus.ts`
  - Own the tracked terminal input state and reducer because this file already
    derives turn status from terminal input.
  - Preserve `applyTerminalInputLineState` as a compatibility wrapper for
    existing callers/tests.
- Create `src/terminalSelectionDelete.ts`
  - Own pure event eligibility and selection-to-terminal-sequence planning.
  - Do not import Vue, Tauri, or concrete xterm instances.
- Modify `src/terminals.ts`
  - Store `TerminalInputState` per tab.
  - Adapt the concrete xterm selection/buffer APIs to the pure planner.
  - Feed synthesized sequences back through `term.input`.
- Modify `test/tabStatus.test.ts`
  - Cover cursor-aware editing and reliability transitions.
- Create `test/terminalSelectionDelete.test.ts`
  - Cover selection validation and exact generated key sequences.
- Modify `test/terminals.test.ts`
  - Cover the concrete handler contract: consume selection Delete, clear a
    valid selection, preserve invalid selection, and leave ordinary Delete
    untouched.

### Task 1: Cursor-aware terminal input state

**Files:**
- Modify: `src/tabStatus.ts:44-119`
- Modify: `test/tabStatus.test.ts:1-79`

- [ ] **Step 1: Add failing reducer tests**

Change the import in `test/tabStatus.test.ts` and append the following cases:

```ts
import {
  applyTerminalInputLineState,
  applyTerminalInputState,
  createTerminalInputState,
  isSlashCommandInput,
  shouldTerminalInputStartTurn,
} from '../src/tabStatus'

describe('cursor-aware terminal input state', () => {
  it('inserts text at the logical cursor after left movement', () => {
    const current = createTerminalInputState('abcd')
    expect(applyTerminalInputState(current, '\x1b[D\x1b[DZ')).toEqual({
      nextState: { text: 'abZcd', cursor: 3, reliable: true },
      submittedLines: [],
    })
  })

  it('applies Backspace and Delete at the logical cursor', () => {
    const current = { text: '你好ab', cursor: 3, reliable: true }
    expect(applyTerminalInputState(current, '\x7f\x1b[3~')).toEqual({
      nextState: { text: '你好', cursor: 2, reliable: true },
      submittedLines: [],
    })
  })

  it('supports Home, End, and bracketed paste without losing reliability', () => {
    const current = createTerminalInputState('ab')
    expect(
      applyTerminalInputState(current, '\x1b[HZ\x1b[F\x1b[200~你\x1b[201~'),
    ).toEqual({
      nextState: { text: 'Zab你', cursor: 4, reliable: true },
      submittedLines: [],
    })
  })

  it('marks history navigation unreliable and resets after submit', () => {
    const unreliable = applyTerminalInputState(
      createTerminalInputState('draft'),
      '\x1b[A',
    ).nextState
    expect(unreliable).toEqual({
      text: 'draft',
      cursor: 5,
      reliable: false,
    })
    expect(applyTerminalInputState(unreliable, '\r').nextState).toEqual({
      text: '',
      cursor: 0,
      reliable: true,
    })
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/tabStatus.test.ts
```

Expected: FAIL because `applyTerminalInputState` and
`createTerminalInputState` are not exported.

- [ ] **Step 3: Implement the cursor-aware reducer**

In `src/tabStatus.ts`, add the public state type and constructor above the input
parsing functions:

```ts
export interface TerminalInputState {
  text: string
  cursor: number
  reliable: boolean
}

export function createTerminalInputState(text = ''): TerminalInputState {
  return {
    text,
    cursor: Array.from(text).length,
    reliable: true,
  }
}
```

Replace the string-only parsing implementation with the following reducer and
control-sequence reader:

```ts
const LEFT = new Set(['\x1b[D', '\x1bOD'])
const RIGHT = new Set(['\x1b[C', '\x1bOC'])
const HOME = new Set(['\x1b[H', '\x1bOH'])
const END = new Set(['\x1b[F', '\x1bOF'])
const DELETE = '\x1b[3~'
const PASTE_MARKERS = new Set(['\x1b[200~', '\x1b[201~'])
const FOCUS_MARKERS = new Set(['\x1b[I', '\x1b[O'])
const HISTORY = new Set(['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB'])

function terminalControlSequenceEnd(data: string, start: number): number {
  const first = data[start]
  if (first === '\x9b') {
    let end = start + 1
    while (end < data.length && !/[\x40-\x7e]/.test(data[end])) end += 1
    return Math.min(end + 1, data.length)
  }

  const next = data[start + 1]
  if (next === '[') {
    let end = start + 2
    while (end < data.length && !/[\x40-\x7e]/.test(data[end])) end += 1
    return Math.min(end + 1, data.length)
  }
  if (next === 'O') return Math.min(start + 3, data.length)
  if (next === ']') {
    let end = start + 2
    while (end < data.length) {
      if (data[end] === '\x07') return end + 1
      if (data[end] === '\x1b' && data[end + 1] === '\\') return end + 2
      end += 1
    }
    return data.length
  }
  if (next && /[PX^_]/.test(next)) {
    let end = start + 2
    while (end < data.length) {
      if (data[end] === '\x1b' && data[end + 1] === '\\') return end + 2
      end += 1
    }
    return data.length
  }
  return Math.min(start + (next ? 2 : 1), data.length)
}

export function applyTerminalInputState(
  current: TerminalInputState,
  data: string,
): { nextState: TerminalInputState; submittedLines: string[] } {
  const chars = Array.from(current.text)
  let cursor = Math.min(current.cursor, chars.length)
  let reliable = current.reliable
  const submittedLines: string[] = []

  const insert = (value: string) => {
    const added = Array.from(value)
    chars.splice(cursor, 0, ...added)
    cursor += added.length
  }
  const backspace = () => {
    if (cursor <= 0) return
    chars.splice(cursor - 1, 1)
    cursor -= 1
  }
  const deleteForward = () => {
    if (cursor < chars.length) chars.splice(cursor, 1)
  }
  const reset = () => {
    chars.splice(0)
    cursor = 0
    reliable = true
  }

  for (let index = 0; index < data.length; ) {
    const currentChar = data[index]
    if (currentChar === '\x1b' || currentChar === '\x9b') {
      const end = terminalControlSequenceEnd(data, index)
      const sequence = data.slice(index, end)
      if (LEFT.has(sequence)) cursor = Math.max(0, cursor - 1)
      else if (RIGHT.has(sequence)) cursor = Math.min(chars.length, cursor + 1)
      else if (HOME.has(sequence)) cursor = 0
      else if (END.has(sequence)) cursor = chars.length
      else if (sequence === DELETE) deleteForward()
      else if (HISTORY.has(sequence)) reliable = false
      else if (!PASTE_MARKERS.has(sequence) && !FOCUS_MARKERS.has(sequence)) {
        reliable = false
      }
      index = end
      continue
    }

    const codePoint = data.codePointAt(index)
    if (codePoint === undefined) break
    const value = String.fromCodePoint(codePoint)
    index += value.length

    if (value === '\r' || value === '\n') {
      submittedLines.push(chars.join(''))
      reset()
    } else if (value === '\b' || value === '\x7f') {
      backspace()
    } else if (value === '\x15') {
      reset()
    } else if (value === '\x01') {
      cursor = 0
    } else if (value === '\x05') {
      cursor = chars.length
    } else if (value >= ' ') {
      insert(value)
    } else {
      reliable = false
    }
  }

  return {
    nextState: { text: chars.join(''), cursor, reliable },
    submittedLines,
  }
}
```

Keep the old public helper as a compatibility wrapper:

```ts
export function applyTerminalInputLineState(
  current: string,
  data: string,
): { nextLine: string; submittedLines: string[] } {
  const result = applyTerminalInputState(createTerminalInputState(current), data)
  return {
    nextLine: result.nextState.text,
    submittedLines: result.submittedLines,
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/tabStatus.test.ts
```

Expected: PASS, including all pre-existing terminal status inference tests.

- [ ] **Step 5: Commit the reducer**

```powershell
git add src/tabStatus.ts test/tabStatus.test.ts
git commit -m "feat: track terminal input cursor state"
```

### Task 2: Safe selection delete planner

**Files:**
- Create: `src/terminalSelectionDelete.ts`
- Create: `test/terminalSelectionDelete.test.ts`

- [ ] **Step 1: Add failing event and planner tests**

Create `test/terminalSelectionDelete.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildTerminalSelectionDeleteSequence,
  shouldHandleTerminalSelectionDelete,
} from '../src/terminalSelectionDelete'

const state = (
  text: string,
  cursor = Array.from(text).length,
  reliable = true,
) => ({ text, cursor, reliable })

const range = (startY = 10, endY = 10) => ({
  start: { x: 2, y: startY },
  end: { x: 5, y: endY },
})

const key = (over: Partial<KeyboardEvent> = {}) =>
  ({
    type: 'keydown',
    key: 'Delete',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  }) as KeyboardEvent

describe('shouldHandleTerminalSelectionDelete', () => {
  it('accepts only plain Windows Delete with a selection', () => {
    expect(shouldHandleTerminalSelectionDelete(key(), true, 'Win32')).toBe(true)
    expect(shouldHandleTerminalSelectionDelete(key(), false, 'Win32')).toBe(false)
    expect(shouldHandleTerminalSelectionDelete(key(), true, 'MacIntel')).toBe(false)
    expect(
      shouldHandleTerminalSelectionDelete(key({ ctrlKey: true }), true, 'Win32'),
    ).toBe(false)
    expect(
      shouldHandleTerminalSelectionDelete(key({ key: 'Backspace' }), true, 'Win32'),
    ).toBe(false)
  })
})

describe('buildTerminalSelectionDeleteSequence', () => {
  it('moves left and deletes a unique middle selection', () => {
    expect(
      buildTerminalSelectionDeleteSequence(
        state('353545353434535453543534', 24),
        '343453',
        range(),
        10,
      ),
    ).toBe('\x1b[D'.repeat(16) + '\x1b[3~'.repeat(6))
  })

  it('moves right when the selection starts after the logical cursor', () => {
    expect(
      buildTerminalSelectionDeleteSequence(
        state('abcdef', 1),
        'de',
        range(),
        10,
      ),
    ).toBe('\x1b[C'.repeat(2) + '\x1b[3~'.repeat(2))
  })

  it('counts Chinese text by code point', () => {
    expect(
      buildTerminalSelectionDeleteSequence(
        state('甲乙丙丁', 4),
        '乙丙',
        range(),
        10,
      ),
    ).toBe('\x1b[D'.repeat(3) + '\x1b[3~'.repeat(2))
  })

  it.each([
    ['unreliable state', state('abcdef', 6, false), 'bc', range(), 10],
    ['empty selection', state('abcdef'), '', range(), 10],
    ['multiline selection', state('abcdef'), 'b\nc', range(), 10],
    ['repeated selection', state('abcabc'), 'abc', range(), 10],
    ['history row', state('abcdef'), 'bc', range(8, 8), 10],
    ['wrapped rows', state('abcdef'), 'bc', range(10, 11), 10],
  ])('rejects %s', (_name, input, selection, position, cursorRow) => {
    expect(
      buildTerminalSelectionDeleteSequence(
        input as ReturnType<typeof state>,
        selection as string,
        position,
        cursorRow as number,
      ),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/terminalSelectionDelete.test.ts
```

Expected: FAIL because `src/terminalSelectionDelete.ts` does not exist.

- [ ] **Step 3: Implement event eligibility and sequence planning**

Create `src/terminalSelectionDelete.ts`:

```ts
import type { TerminalInputState } from './tabStatus'

type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
>

export interface TerminalSelectionRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

const CURSOR_LEFT = '\x1b[D'
const CURSOR_RIGHT = '\x1b[C'
const DELETE_FORWARD = '\x1b[3~'

export function shouldHandleTerminalSelectionDelete(
  event: TerminalKeyEvent,
  hasSelection: boolean,
  platform = navigator.platform,
): boolean {
  return (
    /Win/i.test(platform) &&
    hasSelection &&
    event.type === 'keydown' &&
    event.key === 'Delete' &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  )
}

function findSelectionStart(text: string[], selection: string[]): number | null {
  let found: number | null = null
  for (let start = 0; start <= text.length - selection.length; start += 1) {
    if (selection.every((value, offset) => text[start + offset] === value)) {
      if (found !== null) return null
      found = start
    }
  }
  return found
}

export function buildTerminalSelectionDeleteSequence(
  state: TerminalInputState,
  selectedText: string,
  position: TerminalSelectionRange | undefined,
  activeCursorRow: number,
): string | null {
  if (
    !state.reliable ||
    !selectedText ||
    /[\r\n]/.test(selectedText) ||
    !position ||
    position.start.y !== activeCursorRow ||
    position.end.y !== activeCursorRow
  ) {
    return null
  }

  const text = Array.from(state.text)
  const selection = Array.from(selectedText)
  const selectionStart = findSelectionStart(text, selection)
  if (selectionStart === null) return null

  const cursor = Math.min(state.cursor, text.length)
  const movement =
    selectionStart < cursor
      ? CURSOR_LEFT.repeat(cursor - selectionStart)
      : CURSOR_RIGHT.repeat(selectionStart - cursor)

  return movement + DELETE_FORWARD.repeat(selection.length)
}
```

- [ ] **Step 4: Run planner tests and verify GREEN**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/terminalSelectionDelete.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the planner**

```powershell
git add src/terminalSelectionDelete.ts test/terminalSelectionDelete.test.ts
git commit -m "feat: plan terminal selection deletion"
```

### Task 3: Integrate selection deletion with agent TUI tabs

**Files:**
- Modify: `src/terminals.ts:34-47`
- Modify: `src/terminals.ts:145-190`
- Modify: `src/terminals.ts:1251-1313`
- Modify: `src/terminals.ts:1403-1421`
- Modify: `src/terminals.ts:1456-1501`
- Modify: `test/terminals.test.ts:1-43`

- [ ] **Step 1: Add failing concrete handler tests**

Extend the import in `test/terminals.test.ts`:

```ts
import {
  codexSgrNormalizer,
  handleWindowsTerminalSelectionDelete,
  shouldCopyWindowsTerminalSelection,
} from '../src/terminals'
```

Add this helper and suite below the existing terminal keyboard tests:

```ts
function deleteKey(over: Partial<KeyboardEvent> = {}) {
  return {
    type: 'keydown',
    key: 'Delete',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...over,
  } as unknown as KeyboardEvent
}

function selectionTarget(selectedText = '34', row = 5) {
  return {
    hasSelection: () => true,
    getSelection: () => selectedText,
    getSelectionPosition: () => ({
      start: { x: 2, y: row },
      end: { x: 4, y: row },
    }),
    getActiveCursorRow: () => 5,
    clearSelection: vi.fn(),
    input: vi.fn(),
  }
}

describe('terminal selection Delete integration', () => {
  it('clears a valid selection and feeds the edit through xterm input', () => {
    const target = selectionTarget()
    const event = deleteKey()

    expect(
      handleWindowsTerminalSelectionDelete(
        target,
        { text: '123456', cursor: 6, reliable: true },
        event,
        true,
        'Win32',
      ),
    ).toBe(true)
    expect(target.clearSelection).toHaveBeenCalledOnce()
    expect(target.input).toHaveBeenCalledWith(
      '\x1b[D'.repeat(4) + '\x1b[3~'.repeat(2),
      true,
    )
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('consumes an unsafe selection without clearing or editing it', () => {
    const target = selectionTarget('34', 3)
    expect(
      handleWindowsTerminalSelectionDelete(
        target,
        { text: '123456', cursor: 6, reliable: true },
        deleteKey(),
        true,
        'Win32',
      ),
    ).toBe(true)
    expect(target.clearSelection).not.toHaveBeenCalled()
    expect(target.input).not.toHaveBeenCalled()
  })

  it('leaves ordinary Delete and dead PTYs to the existing path', () => {
    const target = selectionTarget()
    expect(
      handleWindowsTerminalSelectionDelete(
        { ...target, hasSelection: () => false },
        { text: '123456', cursor: 6, reliable: true },
        deleteKey(),
        true,
        'Win32',
      ),
    ).toBe(false)
    expect(
      handleWindowsTerminalSelectionDelete(
        target,
        { text: '123456', cursor: 6, reliable: true },
        deleteKey(),
        false,
        'Win32',
      ),
    ).toBe(false)
  })
})
```

Also add `vi` to the Vitest import:

```ts
import { describe, expect, it, vi } from 'vitest'
```

- [ ] **Step 2: Run the focused integration test and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/terminals.test.ts
```

Expected: FAIL because `handleWindowsTerminalSelectionDelete` is not exported.

- [ ] **Step 3: Add the concrete xterm adapter and handler**

In `src/terminals.ts`, import the new state and planner APIs:

```ts
import {
  applyTerminalInputState,
  createTerminalInputState,
  type TerminalInputState,
} from './tabStatus'
import {
  buildTerminalSelectionDeleteSequence,
  shouldHandleTerminalSelectionDelete,
  type TerminalSelectionRange,
} from './terminalSelectionDelete'
```

Define the testable adapter next to the existing selection-copy handler:

```ts
export interface TerminalSelectionDeleteTarget {
  hasSelection(): boolean
  getSelection(): string
  getSelectionPosition(): TerminalSelectionRange | undefined
  getActiveCursorRow(): number
  clearSelection(): void
  input(data: string, wasUserInput?: boolean): void
}

export function handleWindowsTerminalSelectionDelete(
  target: TerminalSelectionDeleteTarget,
  inputState: TerminalInputState,
  event: KeyboardEvent,
  canEdit: boolean,
  platform = navigator.platform,
): boolean {
  if (
    !canEdit ||
    !shouldHandleTerminalSelectionDelete(
      event,
      target.hasSelection(),
      platform,
    )
  ) {
    return false
  }

  event.preventDefault()
  event.stopImmediatePropagation()
  const sequence = buildTerminalSelectionDeleteSequence(
    inputState,
    target.getSelection(),
    target.getSelectionPosition(),
    target.getActiveCursorRow(),
  )
  if (sequence) {
    target.clearSelection()
    target.input(sequence, true)
  }
  return true
}
```

Add a small adapter factory for concrete xterm instances:

```ts
function selectionDeleteTarget(term: Terminal): TerminalSelectionDeleteTarget {
  return {
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    getSelectionPosition: () => term.getSelectionPosition(),
    getActiveCursorRow: () =>
      term.buffer.active.baseY + term.buffer.active.cursorY,
    clearSelection: () => term.clearSelection(),
    input: (data, wasUserInput) => term.input(data, wasUserInput),
  }
}
```

- [ ] **Step 4: Store and update cursor-aware input state**

Replace `currentInputLine: string` on `TerminalTab` with:

```ts
inputState: TerminalInputState
```

Initialize both agent and shell tabs with:

```ts
inputState: createTerminalInputState(),
```

In the agent `term.onData` callback, replace the old line reducer with:

```ts
if (isTerminalCancelInput(data)) {
  clearLocalWorkingTurn(tab, activeUiId.value === tab.uiId)
  tab.inputState = createTerminalInputState()
} else {
  const input = applyTerminalInputState(tab.inputState, data)
  if (
    tab.turnState !== 'blocked' &&
    input.submittedLines.some((line) =>
      shouldTerminalInputStartTurn(tab.agent, line),
    )
  ) {
    setTurnState(tab, 'working', 'pty-input')
  }
  tab.inputState = input.nextState
}
```

Do not add state tracking to the shell tab `onData` path; its initialized state
only satisfies the shared tab type.

- [ ] **Step 5: Intercept selection Delete in the agent handler only**

Immediately after the Windows selection-copy check in the agent
`attachCustomKeyEventHandler`, add:

```ts
if (
  handleWindowsTerminalSelectionDelete(
    selectionDeleteTarget(term),
    tab.inputState,
    ev,
    tab.ptyId !== null && tab.processState === 'alive',
  )
) {
  return false
}
```

Do not add this call to `openShellTab`; shell terminal selection remains
copy-only.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/tabStatus.test.ts test/terminalSelectionDelete.test.ts test/terminals.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run TypeScript production build**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run build
```

Expected: `vue-tsc --noEmit` and Vite build both exit 0.

- [ ] **Step 8: Commit the integration**

```powershell
git add src/terminals.ts test/terminals.test.ts
git commit -m "feat: delete selected terminal input"
```

### Task 4: Regression and manual verification

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run the complete deterministic test suite**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- --maxWorkers=1
```

Expected: all test files and tests pass. Single-worker mode avoids the known
Mermaid jsdom timeout under full parallel load.

- [ ] **Step 2: Review the complete feature diff**

Run:

```powershell
git diff --check main...HEAD
git diff --stat main...HEAD
git diff main...HEAD -- src/tabStatus.ts src/terminalSelectionDelete.ts src/terminals.ts test/tabStatus.test.ts test/terminalSelectionDelete.test.ts test/terminals.test.ts
```

Check:

- no native `ChatComposer` changes;
- no shell handler wiring;
- unsafe selections are consumed but remain highlighted;
- valid edits go through `term.input`;
- every new exported helper has focused tests.

- [ ] **Step 3: Run the integrated Tauri app**

Start the worktree app using the repository's normal development command:

```powershell
npm run tauri dev
```

In an integrated Codex TUI:

1. Type `353545353434535453543534`.
2. Drag-select the unique middle substring `343545`.
3. Press `Delete` once.
4. Confirm the entire selection disappears and the cursor remains at its start.
5. Press ordinary `Delete` without a selection and confirm one character is
   deleted.
6. Select historical output and press `Delete`; confirm the live input is not
   changed and the selection remains.
7. Select current input and press `Ctrl+C`; confirm copy still works.

- [ ] **Step 4: Check final repository state**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -6
```

Expected: clean `feat/terminal-selection-delete` worktree with implementation,
tests, design, and plan committed.
