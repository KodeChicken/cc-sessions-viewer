# Terminal Selection Backspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain Backspace delete a valid integrated-terminal selection in one action, matching the existing forward Delete behavior.

**Architecture:** Keep the existing terminal selection planner and integration handler unchanged. Extend only the Windows key eligibility predicate so both plain `Delete` and plain `Backspace` enter the same safety checks and edit sequence.

**Tech Stack:** TypeScript, Vue 3, xterm.js, Vitest

## Global Constraints

- Affect only the integrated agent TUI selection behavior.
- Preserve ordinary single-character behavior when no xterm selection exists.
- Do not intercept modified Backspace or Delete combinations.
- Preserve the existing reliable-input, single-row, active-row, and unique-match safety checks.
- Do not add UI labels, settings, or dependencies.

---

### Task 1: Accept Backspace for terminal selection deletion

**Files:**
- Modify: `test/terminalSelectionDelete.test.ts`
- Modify: `test/terminals.test.ts`
- Modify: `src/terminalSelectionDelete.ts`

**Interfaces:**
- Consumes: `shouldHandleTerminalSelectionDelete(event, hasSelection, platform): boolean`
- Consumes: `handleWindowsTerminalSelectionDelete(target, inputState, event, canEdit, platform): boolean`
- Produces: Both functions accept plain Windows Backspace when a terminal selection exists, while retaining all existing safety behavior.

- [ ] **Step 1: Write the failing predicate test**

Replace the Backspace rejection assertion in
`shouldHandleTerminalSelectionDelete` with explicit accepted and rejected cases:

```ts
expect(
  shouldHandleTerminalSelectionDelete(
    key({ key: 'Backspace' }),
    true,
    'Win32',
  ),
).toBe(true)
expect(
  shouldHandleTerminalSelectionDelete(
    key({ key: 'Backspace', ctrlKey: true }),
    true,
    'Win32',
  ),
).toBe(false)
expect(
  shouldHandleTerminalSelectionDelete(
    key({ key: 'Backspace' }),
    false,
    'Win32',
  ),
).toBe(false)
```

- [ ] **Step 2: Write the failing integration test**

Add a regression test that uses the real handler boundary:

```ts
it('deletes a valid selection when the user presses Backspace', () => {
  const target = selectionTarget()
  const event = deleteKey({ key: 'Backspace' })

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
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/terminalSelectionDelete.test.ts test/terminals.test.ts --maxWorkers=1
```

Expected: the new Backspace predicate and integration assertions fail because
`shouldHandleTerminalSelectionDelete` currently accepts only `event.key ===
'Delete'`.

- [ ] **Step 4: Implement the minimal predicate change**

In `src/terminalSelectionDelete.ts`, change only the key condition:

```ts
const isSelectionDeletionKey =
  event.key === 'Delete' || event.key === 'Backspace'

return (
  /Win/i.test(platform) &&
  hasSelection &&
  event.type === 'keydown' &&
  isSelectionDeletionKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  !event.metaKey
)
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- test/terminalSelectionDelete.test.ts test/terminals.test.ts --maxWorkers=1
```

Expected: both files pass, including the existing Delete and unsafe-selection
coverage.

- [ ] **Step 6: Run shared verification**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run test:run -- --maxWorkers=1
npm run build
git diff --check
```

Expected: all deterministic tests pass, the production frontend build succeeds,
and the diff contains no whitespace errors.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- src/terminalSelectionDelete.ts test/terminalSelectionDelete.test.ts test/terminals.test.ts
git commit -m "fix: delete terminal selection with backspace"
```
