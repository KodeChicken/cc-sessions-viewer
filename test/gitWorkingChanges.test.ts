import { computed, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import { gitWorkingChangesRefreshVersion, refreshGitWorkingChanges } from '../src/gitWorkingChanges'

describe('gitWorkingChanges', () => {
  it('updates only the refreshed repository revision', async () => {
    const cwd = '/git-working-changes-test'
    const otherCwd = '/git-working-changes-other'
    const revision = computed(() => gitWorkingChangesRefreshVersion(cwd))

    const before = revision.value
    refreshGitWorkingChanges(cwd)
    await nextTick()

    expect(revision.value).toBe(before + 1)
    expect(gitWorkingChangesRefreshVersion(otherCwd)).toBe(0)
  })
})
