<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { useGitRepository } from '../gitRepository'
import { refreshGitWorkingChanges } from '../gitWorkingChanges'
import { PaneActionsKey } from '../paneActions'
import ConfirmModal from '../modals/ConfirmModal.vue'
import { IconCheck, IconChevronDown, IconClose, IconFileDiff, IconGitBranch, IconPlus, IconRefresh, IconTrash } from './icons'

const props = withDefaults(defineProps<{
  cwd?: string
  disabled?: boolean
  menuPlacement?: 'above' | 'below'
}>(), {
  disabled: false,
  menuPlacement: 'below',
})

const paneActions = inject(PaneActionsKey, null)

const menuEl = ref<HTMLElement>()
const menuOpen = ref(false)
const switching = ref(false)
const refreshing = ref(false)
const deleting = ref(false)
const creating = ref(false)
const deleteTarget = ref<string | null>(null)
const newBranchName = ref('')
const creatingBranch = ref(false)
const createInput = ref<HTMLInputElement>()
const error = ref('')
const { repository, refresh, switchBranch, deleteBranch, createBranch } = useGitRepository(() => props.cwd)

const hasChanges = computed(() => (repository.value?.changeCount ?? 0) > 0)
const canSwitch = computed(() => !props.disabled && !hasChanges.value && !switching.value)
const changeLabel = computed(() => t('chat.branchChanges', { n: repository.value?.changeCount ?? 0 }))
const tooltip = computed(() => {
  if (props.disabled) return t('chat.branchSwitchRunning')
  if (hasChanges.value) return t('chat.branchDirty')
  return t('chat.branchSwitch')
})
const refreshTooltip = computed(() => {
  if (refreshing.value) return t('chat.branchRefreshing')
  return t('chat.branchRefresh')
})

function toggleMenu() {
  if (props.disabled) return
  error.value = ''
  menuOpen.value = !menuOpen.value
}

function openWorkingChanges() {
  if (props.cwd) paneActions?.openGitChanges(props.cwd)
}

async function refreshRepository() {
  if (refreshing.value) return
  refreshing.value = true
  error.value = ''
  try {
    await Promise.all([
      refresh(),
      new Promise((resolve) => setTimeout(resolve, 360)),
    ])
    if (props.cwd) refreshGitWorkingChanges(props.cwd)
  } finally {
    refreshing.value = false
  }
}

async function selectBranch(branch: string) {
  if (!repository.value || branch === repository.value.branch || !canSwitch.value) return
  switching.value = true
  error.value = ''
  try {
    await switchBranch(branch)
    menuOpen.value = false
  } catch (cause) {
    error.value = t('chat.branchSwitchFailed', { e: String(cause) })
  } finally {
    switching.value = false
  }
}

async function openCreateBranch() {
  creatingBranch.value = true
  error.value = ''
  await nextTick()
  createInput.value?.focus()
}

function cancelCreateBranch() {
  creatingBranch.value = false
  newBranchName.value = ''
  error.value = ''
}

async function submitCreateBranch() {
  const branch = newBranchName.value.trim()
  if (!branch) {
    error.value = t('chat.branchCreateInvalid')
    createInput.value?.focus()
    return
  }
  if (creating.value || props.disabled) return
  creating.value = true
  error.value = ''
  try {
    await createBranch(branch)
    newBranchName.value = ''
    creatingBranch.value = false
  } catch (cause) {
    error.value = t('chat.branchCreateFailed', { e: String(cause) })
    createInput.value?.focus()
  } finally {
    creating.value = false
  }
}

function requestDelete(branch: string) {
  if (!repository.value || branch === repository.value.branch || props.disabled) return
  error.value = ''
  deleteTarget.value = branch
}

async function confirmDelete() {
  const branch = deleteTarget.value
  if (!branch || deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    await deleteBranch(branch)
    deleteTarget.value = null
    menuOpen.value = false
  } catch (cause) {
    deleteTarget.value = null
    menuOpen.value = true
    error.value = t('chat.branchDeleteFailed', { e: String(cause) })
  } finally {
    deleting.value = false
  }
}

function closeOnOutsidePointer(event: PointerEvent) {
  if (!menuEl.value?.contains(event.target as Node)) menuOpen.value = false
}

onMounted(() => document.addEventListener('pointerdown', closeOnOutsidePointer))
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeOnOutsidePointer)
})
</script>

<template>
  <div v-if="repository?.branch" class="git-branch-wrap">
    <span ref="menuEl" class="git-branch-menu-wrap">
      <button
        type="button"
        class="git-branch git-branch-button"
        :class="{ open: menuOpen }"
        :disabled="disabled"
        :aria-expanded="menuOpen"
        aria-haspopup="menu"
        v-tooltip="tooltip"
        @click="toggleMenu"
      >
        <IconGitBranch class="git-branch-ic" />
        <span class="git-branch-name">{{ repository.branch }}</span>
        <IconChevronDown class="git-branch-chevron" />
      </button>
      <button
        type="button"
        class="git-branch-refresh"
        :class="{ 'is-branch-refresh-loading': refreshing }"
        :disabled="refreshing"
        :aria-label="refreshTooltip"
        v-tooltip="refreshTooltip"
        @click.stop="refreshRepository"
      >
        <span v-if="refreshing" class="git-branch-spinner" aria-hidden="true" />
        <IconRefresh v-else />
      </button>
      <div v-if="menuOpen" class="git-branch-menu" :class="menuPlacement" role="menu">
        <div
          v-for="branch in repository.branches"
          :key="branch"
          class="git-branch-menu-row"
        >
          <button
            type="button"
            class="git-branch-menu-item"
            :class="{ current: branch === repository.branch }"
            :disabled="branch === repository.branch || !canSwitch"
            role="menuitemradio"
            :aria-checked="branch === repository.branch"
            @click="selectBranch(branch)"
          >
            <IconGitBranch class="git-branch-menu-icon" />
            <span class="git-branch-menu-name">{{ branch }}</span>
            <span class="git-branch-menu-check"><IconCheck v-if="branch === repository.branch" /></span>
          </button>
          <button
            v-if="branch !== repository.branch"
            type="button"
            class="git-branch-delete"
            :disabled="disabled || deleting"
            :aria-label="t('chat.branchDelete')"
            v-tooltip="t('chat.branchDelete')"
            role="menuitem"
            @click="requestDelete(branch)"
          >
            <IconTrash />
          </button>
        </div>
        <div class="git-branch-create">
          <div v-if="creatingBranch" class="git-branch-create-input-row">
            <input
              ref="createInput"
              v-model="newBranchName"
              class="git-branch-create-input"
              type="text"
              :placeholder="t('chat.branchCreatePlaceholder')"
              :disabled="creating"
              @keydown.enter.prevent="submitCreateBranch"
              @keydown.esc.prevent="cancelCreateBranch"
            />
            <button
              type="button"
              class="git-branch-create-action primary"
              :disabled="creating"
              :aria-label="t('chat.branchCreate')"
              v-tooltip="t('chat.branchCreate')"
              @click="submitCreateBranch"
            >
              <IconCheck />
            </button>
            <button
              type="button"
              class="git-branch-create-action"
              :disabled="creating"
              :aria-label="t('common.cancel')"
              v-tooltip="t('common.cancel')"
              @click="cancelCreateBranch"
            >
              <IconClose />
            </button>
          </div>
          <button
            v-else
            type="button"
            class="git-branch-create-toggle"
            :disabled="disabled"
            @click="openCreateBranch"
          >
            <IconPlus />
            <span>{{ t('chat.branchCreate') }}</span>
          </button>
        </div>
        <div v-if="error" class="git-branch-menu-hint error git-branch-menu-error" role="alert">
          <span>{{ error }}</span>
          <button
            type="button"
            class="git-branch-menu-error-close"
            :aria-label="t('common.close')"
            v-tooltip="t('common.close')"
            @click="error = ''"
          >
            <IconClose />
          </button>
        </div>
        <p v-else-if="hasChanges" class="git-branch-menu-hint">{{ t('chat.branchDirty') }}</p>
      </div>
    </span>
    <button
      v-if="hasChanges"
      type="button"
      class="git-branch-change-count"
      v-tooltip="t('chat.branchOpenChanges')"
      @click="openWorkingChanges"
    >
      <IconFileDiff />
      <span>{{ changeLabel }}</span>
    </button>
    <ConfirmModal
      :show="!!deleteTarget"
      :title="t('chat.branchDeleteTitle', { branch: deleteTarget ?? '' })"
      :message="t('chat.branchDeleteBody')"
      :ok-text="t('chat.branchDelete')"
      danger
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>
