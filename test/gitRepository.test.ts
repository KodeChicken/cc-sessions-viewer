import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'

const { gitCreateBranchMock, gitDeleteBranchMock, gitRepositoryStateMock, gitSwitchBranchMock } = vi.hoisted(() => ({
  gitCreateBranchMock: vi.fn(),
  gitDeleteBranchMock: vi.fn(),
  gitRepositoryStateMock: vi.fn(),
  gitSwitchBranchMock: vi.fn(),
}))
vi.mock('../src/api', () => ({
  gitCreateBranch: gitCreateBranchMock,
  gitDeleteBranch: gitDeleteBranchMock,
  gitRepositoryState: gitRepositoryStateMock,
  gitSwitchBranch: gitSwitchBranchMock,
}))

import { useGitRepository } from '../src/gitRepository'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function host(cwd: string) {
  return defineComponent({
    setup() {
      const cwdRef = ref(cwd)
      return useGitRepository(() => cwdRef.value)
    },
    render() {
      return h('div')
    },
  })
}

describe('useGitRepository', () => {
  beforeEach(() => {
    gitCreateBranchMock.mockReset()
    gitDeleteBranchMock.mockReset()
    gitRepositoryStateMock.mockReset()
    gitSwitchBranchMock.mockReset()
  })

  it('loads the current branch, local branches, and change count together', async () => {
    gitRepositoryStateMock.mockResolvedValue({
      branch: 'main', branches: ['develop', 'main'], changeCount: 3,
    })
    const wrapper = mount(host('/git-repository-state'))
    await flush()

    const vm = wrapper.vm as unknown as { repository: { branch: string; changeCount: number } }
    expect(gitRepositoryStateMock).toHaveBeenCalledWith('/git-repository-state')
    expect(vm.repository.branch).toBe('main')
    expect(vm.repository.changeCount).toBe(3)
    wrapper.unmount()
  })

  it('updates the shared repository state after a successful branch switch', async () => {
    gitRepositoryStateMock.mockResolvedValue({
      branch: 'main', branches: ['develop', 'main'], changeCount: 0,
    })
    gitSwitchBranchMock.mockResolvedValue({
      branch: 'develop', branches: ['develop', 'main'], changeCount: 0,
    })
    const wrapper = mount(host('/git-repository-switch'))
    await flush()

    const vm = wrapper.vm as unknown as {
      repository: { branch: string }
      switchBranch: (branch: string) => Promise<void>
    }
    await vm.switchBranch('develop')

    expect(gitSwitchBranchMock).toHaveBeenCalledWith('/git-repository-switch', 'develop')
    expect(vm.repository.branch).toBe('develop')
    wrapper.unmount()
  })

  it('updates the shared repository state after deleting a local branch', async () => {
    gitRepositoryStateMock.mockResolvedValue({
      branch: 'main', branches: ['develop', 'main'], changeCount: 0,
    })
    gitDeleteBranchMock.mockResolvedValue({
      branch: 'main', branches: ['main'], changeCount: 0,
    })
    const wrapper = mount(host('/git-repository-delete'))
    await flush()

    const vm = wrapper.vm as unknown as {
      repository: { branches: string[] }
      deleteBranch: (branch: string) => Promise<void>
    }
    await vm.deleteBranch('develop')

    expect(gitDeleteBranchMock).toHaveBeenCalledWith('/git-repository-delete', 'develop')
    expect(vm.repository.branches).toEqual(['main'])
    wrapper.unmount()
  })

  it('updates the shared repository state after creating a local branch', async () => {
    gitRepositoryStateMock.mockResolvedValue({
      branch: 'main', branches: ['main'], changeCount: 0,
    })
    gitCreateBranchMock.mockResolvedValue({
      branch: 'main', branches: ['feature/local-only', 'main'], changeCount: 0,
    })
    const wrapper = mount(host('/git-repository-create'))
    await flush()

    const vm = wrapper.vm as unknown as {
      repository: { branch: string; branches: string[] }
      createBranch: (branch: string) => Promise<void>
    }
    await vm.createBranch('feature/local-only')

    expect(gitCreateBranchMock).toHaveBeenCalledWith('/git-repository-create', 'feature/local-only')
    expect(vm.repository.branch).toBe('main')
    expect(vm.repository.branches).toEqual(['feature/local-only', 'main'])
    wrapper.unmount()
  })
})
