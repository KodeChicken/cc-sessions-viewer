import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const { gitDiffFileMock, gitDiffFilesMock, gitLogMock, gitStatusMock } = vi.hoisted(() => ({
  gitDiffFileMock: vi.fn(),
  gitDiffFilesMock: vi.fn(),
  gitLogMock: vi.fn(),
  gitStatusMock: vi.fn(),
}))

vi.mock('../../src/api', () => ({
  gitDiffFile: gitDiffFileMock,
  gitDiffFiles: gitDiffFilesMock,
  gitLog: gitLogMock,
  gitStatus: gitStatusMock,
}))

import GitChangesView from '../../src/views/GitChangesView.vue'
import { vTooltip } from '../../src/tooltip'

enableAutoUnmount(afterEach)

const factory = () => mount(GitChangesView, {
  props: { cwd: '/work/project', gitRef: 'working' },
  global: {
    directives: { tooltip: vTooltip },
    stubs: { DiffBlock: true },
  },
})

describe('GitChangesView', () => {
  beforeEach(() => {
    gitDiffFileMock.mockReset()
    gitDiffFilesMock.mockReset()
    gitLogMock.mockReset()
    gitStatusMock.mockReset()
    gitDiffFileMock.mockResolvedValue([])
    gitLogMock.mockResolvedValue([])
    gitStatusMock.mockResolvedValue([])
  })

  it('automatically selects the only changed file', async () => {
    gitDiffFilesMock.mockResolvedValue([
      { path: 'docs/new.md', additions: 2, deletions: 0, status: 'A' },
    ])

    const wrapper = factory()
    await flushPromises()

    expect(gitDiffFileMock).toHaveBeenCalledWith('/work/project', 'working', 'docs/new.md')
    expect(wrapper.emitted('pathChange')).toEqual([['docs/new.md']])
  })

  it('does not choose a file automatically when several files changed', async () => {
    gitDiffFilesMock.mockResolvedValue([
      { path: 'a.ts', additions: 1, deletions: 0, status: 'A' },
      { path: 'b.ts', additions: 1, deletions: 0, status: 'A' },
    ])

    const wrapper = factory()
    await flushPromises()

    expect(gitDiffFileMock).not.toHaveBeenCalled()
    expect(wrapper.emitted('pathChange')).toBeUndefined()
  })
})
