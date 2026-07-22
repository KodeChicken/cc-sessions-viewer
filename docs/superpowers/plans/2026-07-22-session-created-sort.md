# Session Creation-Time Sort Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one bidirectional sort shortcut in the sessions project header that toggles creation time newest/oldest while staying synchronized with the existing sort menu.

**Architecture:** Extend the existing module-level `sessionSort` state rather than creating a second control state. `filterSessions` owns timestamp parsing and fallback behavior, `SessionsTopbar` exposes all sort choices, and `SessionsView` adds the compact `IconSort` shortcut in its existing normal-mode action row.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, Vue Test Utils, existing `v-tooltip` directive and Lucide icon components.

---

### Task 1: Creation-time sorting state and pure behavior

**Files:**
- Modify: `test/sessionsToolbar.test.ts`
- Modify: `src/sessionsToolbar.ts`

- [ ] **Step 1: Write failing sorting tests**

Add these cases inside `describe('filterSessions')`:

```ts
it('sorts by creation time, newest first', () => {
  const created = [
    session({ path: 'a', created: '2026-01-02T00:00:00Z', modified: 300 }),
    session({ path: 'b', created: '2026-01-03T00:00:00Z', modified: 100 }),
    session({ path: 'c', created: '2026-01-01T00:00:00Z', modified: 200 }),
  ]
  sessionSort.value = 'createdRecent'
  expect(filterSessions(created).map((s) => s.path)).toEqual(['b', 'a', 'c'])
})

it('sorts by creation time, oldest first', () => {
  const created = [
    session({ path: 'a', created: '2026-01-02T00:00:00Z', modified: 300 }),
    session({ path: 'b', created: '2026-01-03T00:00:00Z', modified: 100 }),
    session({ path: 'c', created: '2026-01-01T00:00:00Z', modified: 200 }),
  ]
  sessionSort.value = 'createdOldest'
  expect(filterSessions(created).map((s) => s.path)).toEqual(['c', 'a', 'b'])
})

it('falls back to modified for missing or invalid creation times', () => {
  const created = [
    session({ path: 'valid', created: '1970-01-01T00:00:00.020Z', modified: 5 }),
    session({ path: 'missing', modified: 30 }),
    session({ path: 'invalid', created: 'not-a-date', modified: 10 }),
  ]
  sessionSort.value = 'createdRecent'
  expect(filterSessions(created).map((s) => s.path)).toEqual([
    'missing',
    'valid',
    'invalid',
  ])
})

it('breaks creation-time ties by newest modified', () => {
  const tied = [
    session({ path: 'old-update', created: '2026-01-01T00:00:00Z', modified: 10 }),
    session({ path: 'new-update', created: '2026-01-01T00:00:00Z', modified: 20 }),
  ]
  sessionSort.value = 'createdRecent'
  expect(filterSessions(tied).map((s) => s.path)).toEqual(['new-update', 'old-update'])
})
```

Add this case inside `describe('sessionsFilterActive')`:

```ts
it('is true for creation-time sorting', () => {
  sessionSort.value = 'createdRecent'
  expect(sessionsFilterActive.value).toBe(true)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run test\sessionsToolbar.test.ts
```

Expected: TypeScript collection fails because `createdRecent` and `createdOldest` are not members of `SessionSort`.

- [ ] **Step 3: Implement the minimal sorting behavior**

Change the sort union in `src/sessionsToolbar.ts`:

```ts
export type SessionSort =
  | 'recent'
  | 'oldest'
  | 'createdRecent'
  | 'createdOldest'
  | 'size'
  | 'messages'
```

Add a timestamp helper above `filterSessions`:

```ts
function sessionCreatedTime(session: SessionMeta): number {
  const created = session.created ? Date.parse(session.created) : Number.NaN
  return Number.isFinite(created) ? created : session.modified
}
```

Add the creation-time cases to the existing `switch`, retaining `byRecent` as the tie-breaker:

```ts
case 'createdRecent':
  return sessionCreatedTime(b) - sessionCreatedTime(a) || byRecent(a, b)
case 'createdOldest':
  return sessionCreatedTime(a) - sessionCreatedTime(b) || byRecent(a, b)
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused Vitest command. Expected: all `sessionsToolbar` tests pass.

- [ ] **Step 5: Commit the pure behavior**

```powershell
git add test/sessionsToolbar.test.ts src/sessionsToolbar.ts
git commit -m "feat: add session creation-time sorting"
```

### Task 2: Synchronize the topbar sort menu and translations

**Files:**
- Modify: `test/components/SessionsTopbar.test.ts`
- Modify: `src/components/topbar/SessionsTopbar.vue`
- Modify: `src/locales/en.ts`
- Modify: `src/locales/zh.ts`
- Modify: `src/locales/zh-TW.ts`
- Modify: `src/locales/ja.ts`

- [ ] **Step 1: Write the failing topbar test**

Replace the current four-option test with:

```ts
it('lists every sort option and applies creation-time sorting', async () => {
  const wrapper = factory()
  await wrapper.find('.ct-scope-btn').trigger('click')
  const items = wrapper.findAll('.ct-scope-item')
  expect(items).toHaveLength(6)

  await items[2].trigger('click')
  expect(sessionSort.value).toBe('createdRecent')
})
```

- [ ] **Step 2: Run the focused component test and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run test\components\SessionsTopbar.test.ts
```

Expected: FAIL because the menu still renders four items.

- [ ] **Step 3: Add the two shared menu choices**

Insert the two entries after `oldest` in `SessionsTopbar.vue`:

```ts
{ value: 'createdRecent', key: 'list.tb.sortCreatedRecent' },
{ value: 'createdOldest', key: 'list.tb.sortCreatedOldest' },
```

Add these locale entries beside the existing sort labels:

```ts
// en.ts
'list.tb.sortCreatedRecent': 'Created: newest first',
'list.tb.sortCreatedOldest': 'Created: oldest first',
'list.tb.sortCreated': 'Sort by creation time (newest first)',
'list.tb.sortCreatedRecentTip': 'Creation time: newest first; click for oldest first',
'list.tb.sortCreatedOldestTip': 'Creation time: oldest first; click for newest first',

// zh.ts
'list.tb.sortCreatedRecent': '创建时间：最新优先',
'list.tb.sortCreatedOldest': '创建时间：最早优先',
'list.tb.sortCreated': '按创建时间排序（最新优先）',
'list.tb.sortCreatedRecentTip': '创建时间：最新优先；点击切换为最早优先',
'list.tb.sortCreatedOldestTip': '创建时间：最早优先；点击切换为最新优先',

// zh-TW.ts
'list.tb.sortCreatedRecent': '建立時間：最新優先',
'list.tb.sortCreatedOldest': '建立時間：最早優先',
'list.tb.sortCreated': '依建立時間排序（最新優先）',
'list.tb.sortCreatedRecentTip': '建立時間：最新優先；點擊切換為最早優先',
'list.tb.sortCreatedOldestTip': '建立時間：最早優先；點擊切換為最新優先',

// ja.ts
'list.tb.sortCreatedRecent': '作成日時：新しい順',
'list.tb.sortCreatedOldest': '作成日時：古い順',
'list.tb.sortCreated': '作成日時で並べ替え（新しい順）',
'list.tb.sortCreatedRecentTip': '作成日時：新しい順。クリックで古い順に切り替え',
'list.tb.sortCreatedOldestTip': '作成日時：古い順。クリックで新しい順に切り替え',
```

- [ ] **Step 4: Run the topbar and i18n tests**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run test\components\SessionsTopbar.test.ts test\i18n.test.ts
```

Expected: both test files pass.

- [ ] **Step 5: Commit the synchronized menu**

```powershell
git add test/components/SessionsTopbar.test.ts src/components/topbar/SessionsTopbar.vue src/locales/en.ts src/locales/zh.ts src/locales/zh-TW.ts src/locales/ja.ts
git commit -m "feat: expose creation sorting in sessions menu"
```

### Task 3: Add the bidirectional project-header shortcut

**Files:**
- Modify: `test/views/SessionsView.test.ts`
- Modify: `src/views/SessionsView.vue`

- [ ] **Step 1: Write failing shortcut component tests**

Import `sessionSort` beside the existing toolbar refs in `test/views/SessionsView.test.ts`, then add these cases inside `describe('header actions')`:

```ts
it('shows the creation sort shortcut only when there are 2+ sessions', () => {
  const one = factory([session()])
  expect(findByLabel(one, 'Sort by creation time')).toBeUndefined()

  const two = factory([session(), session({ path: '/work/proj/b.jsonl' })])
  expect(findByLabel(two, 'Sort by creation time')).toBeDefined()
})

it('toggles creation-time order and marks the shortcut active', async () => {
  const wrapper = factory([session(), session({ path: '/work/proj/b.jsonl' })])
  const button = findByLabel(wrapper, 'Sort by creation time')

  await button.trigger('click')
  expect(sessionSort.value).toBe('createdRecent')
  expect(button.classes()).toContain('active')
  expect(button.attributes('aria-label')).toBe(
    'Creation time: newest first; click for oldest first',
  )

  await button.trigger('click')
  expect(sessionSort.value).toBe('createdOldest')
  expect(button.attributes('aria-label')).toBe(
    'Creation time: oldest first; click for newest first',
  )
})

it('hides the creation sort shortcut in select mode', () => {
  sessionSelectMode.value = true
  const wrapper = factory([session(), session({ path: '/work/proj/b.jsonl' })])
  expect(findByLabel(wrapper, 'Sort by creation time')).toBeUndefined()
})
```

- [ ] **Step 2: Run the focused view test and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run test\views\SessionsView.test.ts
```

Expected: FAIL because no creation-time shortcut exists.

- [ ] **Step 3: Implement the shared-state shortcut**

Import `sessionSort` from `sessionsToolbar` and `IconSort` from `components/icons` in `SessionsView.vue`.

Add these computed values and handler near the existing project-header selection helpers:

```ts
const creationSortActive = computed(
  () => sessionSort.value === 'createdRecent' || sessionSort.value === 'createdOldest',
)
const creationSortTooltip = computed(() => {
  if (sessionSort.value === 'createdRecent') return t('list.tb.sortCreatedRecentTip')
  if (sessionSort.value === 'createdOldest') return t('list.tb.sortCreatedOldestTip')
  return t('list.tb.sortCreated')
})
function toggleCreationSort() {
  sessionSort.value =
    sessionSort.value === 'createdRecent' ? 'createdOldest' : 'createdRecent'
}
```

Insert this as the first button in the normal-mode `.list-head-actions` template, before the select-mode entry:

```vue
<button
  v-if="sessions.length > 1"
  class="icon-btn"
  :class="{ active: creationSortActive }"
  v-tooltip="creationSortTooltip"
  @click="toggleCreationSort"
>
  <IconSort />
</button>
```

- [ ] **Step 4: Run the focused view test and verify GREEN**

Run the same focused `SessionsView.test.ts` command. Expected: all cases pass.

- [ ] **Step 5: Commit the shortcut**

```powershell
git add test/views/SessionsView.test.ts src/views/SessionsView.vue
git commit -m "feat: add creation sort shortcut"
```

### Task 4: Full verification and visual confirmation

**Files:**
- No source changes expected.

- [ ] **Step 1: Run all affected tests together**

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run test\sessionsToolbar.test.ts test\components\SessionsTopbar.test.ts test\views\SessionsView.test.ts test\i18n.test.ts
```

Expected: all selected files pass with zero failed tests.

- [ ] **Step 2: Run the complete frontend suite**

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run
```

Expected: all test files and tests pass; existing jsdom canvas warnings may remain.

- [ ] **Step 3: Run the production build**

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run build
```

Expected: `vue-tsc --noEmit` and `vite build` exit with code 0.

- [ ] **Step 4: Review the complete branch diff**

```powershell
git diff main...HEAD --check
git diff main...HEAD --stat
git status --short
```

Expected: no whitespace errors, only planned files changed, and a clean worktree.

- [ ] **Step 5: Merge the feature branch into `main` after review**

From the primary worktree, merge `feature/session-created-sort`, then confirm the already-running Tauri dev app hot-reloads the new project-header icon.
