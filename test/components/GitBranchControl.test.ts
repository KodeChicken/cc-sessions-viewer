import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { gitCreateBranchMock, gitDeleteBranchMock, gitRepositoryStateMock, gitSwitchBranchMock, openGitChangesMock } = vi.hoisted(() => ({
  gitCreateBranchMock: vi.fn(),
  gitDeleteBranchMock: vi.fn(),
  gitRepositoryStateMock: vi.fn(),
  gitSwitchBranchMock: vi.fn(),
  openGitChangesMock: vi.fn(),
}))
vi.mock('../../src/api', () => ({
  gitCreateBranch: gitCreateBranchMock,
  gitDeleteBranch: gitDeleteBranchMock,
  gitRepositoryState: gitRepositoryStateMock,
  gitSwitchBranch: gitSwitchBranchMock,
}))

import GitBranchControl from '../../src/components/GitBranchControl.vue'
import { PaneActionsKey } from '../../src/paneActions'
import { vTooltip } from '../../src/tooltip'

const state = (branch: string, changeCount = 0) => ({
  branch,
  branches: ['develop', 'main'],
  changeCount,
})

const factory = (cwd: string) => mount(GitBranchControl, {
  props: { cwd },
  global: {
    directives: { tooltip: vTooltip },
    provide: { [PaneActionsKey as symbol]: { openGitChanges: openGitChangesMock } },
  },
})

describe('GitBranchControl', () => {
  beforeEach(() => {
    gitCreateBranchMock.mockReset()
    gitDeleteBranchMock.mockReset()
    gitRepositoryStateMock.mockReset()
    gitSwitchBranchMock.mockReset()
    openGitChangesMock.mockReset()
  })

  it('shows the uncommitted count and disables branch choices on a dirty worktree', async () => {
    gitRepositoryStateMock.mockResolvedValue(state('main', 3))
    const wrapper = factory('/branch-control-dirty')
    await flushPromises()
    await wrapper.get('.git-branch-button').trigger('click')

    expect(wrapper.text()).toContain('3 uncommitted changes')
    expect(wrapper.text()).toContain('Commit or stash changes before switching branches.')
    expect(wrapper.findAll('.git-branch-menu-item')[0].attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('opens the current session working changes tab from the change count', async () => {
    gitRepositoryStateMock.mockResolvedValue(state('main', 3))
    const wrapper = factory('/branch-control-working-changes')
    await flushPromises()
    await wrapper.get('.git-branch-change-count').trigger('click')

    expect(openGitChangesMock).toHaveBeenCalledWith('/branch-control-working-changes')
    wrapper.unmount()
  })

  it('switches a clean worktree and updates the rendered branch', async () => {
    gitRepositoryStateMock.mockResolvedValue(state('main'))
    gitSwitchBranchMock.mockResolvedValue(state('develop'))
    const wrapper = factory('/branch-control-clean')
    await flushPromises()
    await wrapper.get('.git-branch-button').trigger('click')
    await wrapper.findAll('.git-branch-menu-item')[0].trigger('click')
    await flushPromises()

    expect(gitSwitchBranchMock).toHaveBeenCalledWith('/branch-control-clean', 'develop')
    expect(wrapper.find('.git-branch-name').text()).toBe('develop')
    wrapper.unmount()
  })

  it('refreshes the local branch state on demand', async () => {
    gitRepositoryStateMock.mockResolvedValue(state('main'))
    const wrapper = factory('/branch-control-refresh')
    await flushPromises()
    await wrapper.get('.git-branch-refresh').trigger('click')
    await flushPromises()

    expect(gitRepositoryStateMock).toHaveBeenCalledTimes(2)
    expect(gitRepositoryStateMock).toHaveBeenLastCalledWith('/branch-control-refresh')
    wrapper.unmount()
  })

  it('confirms and deletes a non-current local branch', async () => {
    gitRepositoryStateMock.mockResolvedValue(state('main'))
    gitDeleteBranchMock.mockResolvedValue({
      branch: 'main', branches: ['main'], changeCount: 0,
    })
    const wrapper = factory('/branch-control-delete')
    await flushPromises()
    await wrapper.get('.git-branch-button').trigger('click')

    expect(wrapper.findAll('.git-branch-delete')).toHaveLength(1)
    await wrapper.get('.git-branch-delete').trigger('click')
    expect(wrapper.text()).toContain('Delete "develop"?')
    await wrapper.get('.modal-actions .danger').trigger('click')
    await flushPromises()

    expect(gitDeleteBranchMock).toHaveBeenCalledWith('/branch-control-delete', 'develop')
    expect(wrapper.findAll('.git-branch-menu-item')).toHaveLength(0)
    wrapper.unmount()
  })

  it('allows a branch operation error to be dismissed', async () => {
    gitRepositoryStateMock.mockResolvedValue(state('main'))
    gitDeleteBranchMock.mockRejectedValue(new Error('branch is not fully merged'))
    const wrapper = factory('/branch-control-delete-error')
    await flushPromises()
    await wrapper.get('.git-branch-button').trigger('click')
    await wrapper.get('.git-branch-delete').trigger('click')
    await wrapper.get('.modal-actions .danger').trigger('click')
    await flushPromises()

    expect(wrapper.find('.git-branch-menu-error').text()).toContain('branch is not fully merged')
    await wrapper.get('.git-branch-menu-error-close').trigger('click')
    expect(wrapper.find('.git-branch-menu-error').exists()).toBe(false)
    wrapper.unmount()
  })

  it('creates a local branch without switching the current branch', async () => {
    gitRepositoryStateMock.mockResolvedValue(state('main'))
    gitCreateBranchMock.mockResolvedValue({
      branch: 'main', branches: ['develop', 'feature/new-menu', 'main'], changeCount: 0,
    })
    const wrapper = factory('/branch-control-create')
    await flushPromises()
    await wrapper.get('.git-branch-button').trigger('click')
    await wrapper.get('.git-branch-create-toggle').trigger('click')
    await wrapper.get('.git-branch-create-input').setValue('feature/new-menu')
    await wrapper.get('.git-branch-create-action.primary').trigger('click')
    await flushPromises()

    expect(gitCreateBranchMock).toHaveBeenCalledWith('/branch-control-create', 'feature/new-menu')
    expect(wrapper.find('.git-branch-name').text()).toBe('main')
    expect(wrapper.findAll('.git-branch-menu-item')).toHaveLength(3)
    wrapper.unmount()
  })
})
