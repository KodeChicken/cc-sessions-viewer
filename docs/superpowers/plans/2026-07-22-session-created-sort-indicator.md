# Creation Sort Direction Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the creation-sort tooltip and show the active ascending or descending direction by coloring only that half of the bidirectional arrow blue.

**Architecture:** Add a focused `CreationSortIcon` component whose two SVG arrow groups expose stable direction classes and accept `asc`, `desc`, or `null`. `SessionsView` continues to own the shared sort-state toggle, maps that state to the icon direction and a non-visible accessible label, and no longer binds the tooltip or whole-button active class.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, scoped CSS using existing design tokens, Vitest, Vue Test Utils.

---

### Task 1: Lock the desired header-button behavior with a regression test

**Files:**
- Modify: `test/views/SessionsView.test.ts:286-310`

- [ ] **Step 1: Replace the old active-button/tooltip expectations with direction-specific assertions**

```ts
it('colors only the active creation-time direction without an active button background', async () => {
  const wrapper = factory([session(), session({ path: '/work/proj/b.jsonl' })])
  const button = findByLabel(wrapper, 'Sort by creation time')

  expect(button.classes()).not.toContain('active')
  expect(button.find('.creation-sort-icon__arrow--up').classes()).not.toContain('is-active')
  expect(button.find('.creation-sort-icon__arrow--down').classes()).not.toContain('is-active')

  await button.trigger('click')
  expect(sessionSort.value).toBe('createdRecent')
  expect(button.attributes('aria-label')).toBe('Created: newest first')
  expect(button.find('.creation-sort-icon__arrow--down').classes()).toContain('is-active')
  expect(button.find('.creation-sort-icon__arrow--up').classes()).not.toContain('is-active')

  await button.trigger('click')
  expect(sessionSort.value).toBe('createdOldest')
  expect(button.attributes('aria-label')).toBe('Created: oldest first')
  expect(button.find('.creation-sort-icon__arrow--up').classes()).toContain('is-active')
  expect(button.find('.creation-sort-icon__arrow--down').classes()).not.toContain('is-active')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run test/views/SessionsView.test.ts
```

Expected: FAIL because the current icon has no direction classes and the button still receives `active` plus tooltip-derived labels.

### Task 2: Render and style independently colored arrow directions

**Files:**
- Create: `src/components/CreationSortIcon.vue`
- Modify: `src/views/SessionsView.vue:31-40,333-343,701-709`
- Modify: `src/locales/en.ts:117-121`
- Modify: `src/locales/ja.ts:117-121`
- Modify: `src/locales/zh-TW.ts:117-121`
- Modify: `src/locales/zh.ts:117-121`

- [ ] **Step 1: Create the focused bidirectional icon component**

```vue
<script setup lang="ts">
defineProps<{ direction: 'asc' | 'desc' | null }>()
</script>

<template>
  <svg class="creation-sort-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <g
      class="creation-sort-icon__arrow creation-sort-icon__arrow--down"
      :class="{ 'is-active': direction === 'desc' }"
    >
      <path d="m3 16 4 4 4-4" />
      <path d="M7 20V4" />
    </g>
    <g
      class="creation-sort-icon__arrow creation-sort-icon__arrow--up"
      :class="{ 'is-active': direction === 'asc' }"
    >
      <path d="m21 8-4-4-4 4" />
      <path d="M17 4v16" />
    </g>
  </svg>
</template>

<style scoped>
.creation-sort-icon {
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.creation-sort-icon__arrow {
  stroke: var(--text-mute);
  transition: stroke 0.12s ease;
}
.creation-sort-icon__arrow.is-active {
  stroke: var(--link);
}
@media (prefers-reduced-motion: reduce) {
  .creation-sort-icon__arrow { transition: none; }
}
</style>
```

- [ ] **Step 2: Map shared sort state to direction and accessible label in `SessionsView`**

```ts
const creationSortDirection = computed<'asc' | 'desc' | null>(() => {
  if (sessionSort.value === 'createdOldest') return 'asc'
  if (sessionSort.value === 'createdRecent') return 'desc'
  return null
})
const creationSortLabel = computed(() => {
  if (sessionSort.value === 'createdOldest') return t('list.tb.sortCreatedOldest')
  if (sessionSort.value === 'createdRecent') return t('list.tb.sortCreatedRecent')
  return t('list.tb.sortCreated')
})
```

Import `CreationSortIcon`, remove the unused `IconSort` import, and render:

```vue
<button
  v-if="sessions.length > 1"
  class="icon-btn creation-sort-button"
  :aria-label="creationSortLabel"
  @click="toggleCreationSort"
>
  <CreationSortIcon :direction="creationSortDirection" />
</button>
```

This deliberately removes both `:class="{ active: ... }"` and `v-tooltip`.

- [ ] **Step 3: Delete the now-unused `sortCreatedRecentTip` and `sortCreatedOldestTip` entries from all four locale files**

Keep `sortCreated`, `sortCreatedRecent`, and `sortCreatedOldest`; they serve the accessible button label and topbar menu.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused Vitest command from Task 1.

Expected: `test/views/SessionsView.test.ts` passes.

- [ ] **Step 5: Commit the implementation**

```powershell
git add src/components/CreationSortIcon.vue src/views/SessionsView.vue src/locales test/views/SessionsView.test.ts
git commit -m "fix: clarify creation sort direction"
```

### Task 3: Verify the integrated change

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run affected component tests**

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run test/views/SessionsView.test.ts test/components/SessionsTopbar.test.ts
```

Expected: both files pass.

- [ ] **Step 2: Run the complete frontend suite**

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node .\node_modules\vitest\vitest.mjs run
```

Expected: 58 files and all tests pass; the existing jsdom canvas warning may remain.

- [ ] **Step 3: Run the production build**

```powershell
npm run build
```

Expected: `vue-tsc --noEmit` and Vite finish with exit code 0; existing chunk-size warnings may remain.

- [ ] **Step 4: Review the final diff and commit any plan progress updates**

```powershell
git diff main...HEAD --check
git diff main...HEAD --stat
git status --short
```

Expected: no whitespace errors, only the scoped indicator/test/docs changes, and a clean worktree after commits.
