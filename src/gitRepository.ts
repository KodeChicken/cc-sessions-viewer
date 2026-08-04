import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { gitCreateBranch, gitDeleteBranch, gitRepositoryState, gitSwitchBranch } from './api'
import type { GitRepositoryState } from './types'

type RepositoryStore = GitRepositoryState & { loading: boolean; pending?: Promise<void> }

const stores = new Map<string, RepositoryStore>()

function storeFor(cwd: string): RepositoryStore {
  let store = stores.get(cwd)
  if (!store) {
    store = reactive({ branch: null, branches: [], changeCount: 0, loading: false }) as RepositoryStore
    stores.set(cwd, store)
  }
  return store
}

export async function refreshGitRepository(cwd: string) {
  const store = storeFor(cwd)
  if (store.pending) return store.pending
  store.loading = true
  store.pending = gitRepositoryState(cwd)
    .then((state) => {
      Object.assign(store, state)
    })
    .finally(() => {
      store.loading = false
      store.pending = undefined
    })
  return store.pending
}

export function useGitRepository(getCwd: () => string | undefined) {
  const repository = ref<RepositoryStore | null>(null)

  async function refresh() {
    const cwd = getCwd()
    if (!cwd) {
      repository.value = null
      return
    }
    const store = storeFor(cwd)
    repository.value = store
    try {
      await refreshGitRepository(cwd)
    } catch {
      Object.assign(store, { branch: null, branches: [], changeCount: 0 })
    }
  }

  async function switchBranch(branch: string) {
    const cwd = getCwd()
    if (!cwd) return
    const state = await gitSwitchBranch(cwd, branch)
    Object.assign(storeFor(cwd), state)
  }

  async function deleteBranch(branch: string) {
    const cwd = getCwd()
    if (!cwd) return
    const state = await gitDeleteBranch(cwd, branch)
    Object.assign(storeFor(cwd), state)
  }

  async function createBranch(branch: string) {
    const cwd = getCwd()
    if (!cwd) return
    const state = await gitCreateBranch(cwd, branch)
    Object.assign(storeFor(cwd), state)
  }

  let timer: ReturnType<typeof setInterval> | undefined
  const refreshOnFocus = () => { void refresh() }
  onMounted(() => {
    window.addEventListener('focus', refreshOnFocus)
    timer = setInterval(refreshOnFocus, 5000)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('focus', refreshOnFocus)
    if (timer) clearInterval(timer)
  })

  watch(getCwd, refresh, { immediate: true })

  return {
    repository: computed(() => repository.value),
    refresh,
    switchBranch,
    deleteBranch,
    createBranch,
  }
}
