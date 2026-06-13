<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Agent, ProjectInfo } from '../types'
import { shortName } from '../format'
import { t } from '../i18n'
import { IconExternalLink, IconRefresh, IconSettings, IconClose, IconCheck, IconTrash, IconSelect, IconGitBranch, agentIcons } from './icons'
import { latestVersion, openReleasePage, updateAvailable } from '../updateCheck'

type ProjState = 'pinned' | 'sunk'

const props = defineProps<{
  agent: Agent
  projects: ProjectInfo[]
  activeDir: string | null
  showTrash: boolean
  projPrefs: Record<string, ProjState>
  refreshing?: boolean
}>()

const emit = defineEmits<{
  (e: 'switch-agent', a: Agent): void
  (e: 'select-project', dir: string): void
  (e: 'context-menu', evt: MouseEvent, p: ProjectInfo): void
  (e: 'open-settings'): void
  (e: 'refresh'): void
  (e: 'add-bookmark'): void
  (e: 'batch-delete', dirs: string[]): void
}>()

const agents: Agent[] = ['claude', 'codex', 'gemini']
const agentLabel = (a: Agent) =>
  a === 'codex' ? 'Codex' : a === 'gemini' ? 'Gemini' : 'Claude'
const agentName = computed(() => agentLabel(props.agent))

function prefKey(p: ProjectInfo): string {
  return `${props.agent}::${p.dirName}`
}
function projStateOf(p: ProjectInfo): ProjState | undefined {
  return props.projPrefs[prefKey(p)]
}

const sortedProjects = computed(() => {
  const rank = (p: ProjectInfo) =>
    projStateOf(p) === 'pinned' ? 0 : p.bookmarked && !p.sessionCount ? 1 : projStateOf(p) === 'sunk' ? 3 : 2
  return [...props.projects].sort((a, b) => rank(a) - rank(b))
})

type SidebarEntry =
  | { kind: 'solo'; project: ProjectInfo }
  | { kind: 'parent'; project: ProjectInfo; children: ProjectInfo[] }
  | { kind: 'child'; project: ProjectInfo; parentDirName: string }

const collapsedWorktrees = ref(new Set<string>())

function toggleWorktreeCollapse(parentDir: string) {
  const next = new Set(collapsedWorktrees.value)
  if (next.has(parentDir)) next.delete(parentDir)
  else next.add(parentDir)
  collapsedWorktrees.value = next
}

const groupedEntries = computed<SidebarEntry[]>(() => {
  const list = sortedProjects.value
  const childrenMap = new Map<string, ProjectInfo[]>()
  const parentDirs = new Set<string>()
  for (const p of list) {
    if (p.parentDirName) {
      parentDirs.add(p.parentDirName)
      const arr = childrenMap.get(p.parentDirName) || []
      arr.push(p)
      childrenMap.set(p.parentDirName, arr)
    }
  }
  const entries: SidebarEntry[] = []
  for (const p of list) {
    if (p.parentDirName) continue
    const children = childrenMap.get(p.dirName)
    if (children?.length) {
      entries.push({ kind: 'parent', project: p, children })
      if (!collapsedWorktrees.value.has(p.dirName)) {
        for (const c of children) {
          entries.push({ kind: 'child', project: c, parentDirName: p.dirName })
        }
      }
    } else {
      entries.push({ kind: 'solo', project: p })
    }
  }
  // orphan worktrees whose parent isn't in the list
  for (const p of list) {
    if (p.parentDirName && !list.some(x => x.dirName === p.parentDirName)) {
      entries.push({ kind: 'solo', project: p })
    }
  }
  return entries
})

function pinColor(p: ProjectInfo): string {
  let h = 0
  const s = p.dirName
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  const hue = ((h % 360) + 360) % 360
  return `hsl(${hue} 72% 52%)`
}

const selecting = ref(false)
const selectedDirs = ref(new Set<string>())
watch(() => props.agent, () => exitSelect())

function exitSelect() {
  selecting.value = false
  selectedDirs.value = new Set()
}

function toggleSelect(dir: string) {
  const next = new Set(selectedDirs.value)
  if (next.has(dir)) next.delete(dir)
  else next.add(dir)
  selectedDirs.value = next
  if (next.size === 0) selecting.value = false
}

const allSelected = computed(() =>
  props.projects.length > 0 && selectedDirs.value.size === props.projects.length,
)

function toggleSelectAll() {
  if (allSelected.value) {
    selectedDirs.value = new Set()
  } else {
    selectedDirs.value = new Set(props.projects.map(p => p.dirName))
  }
}

function onProjClick(p: ProjectInfo) {
  if (selecting.value) {
    toggleSelect(p.dirName)
    return
  }
  emit('select-project', p.dirName)
}

function onProjContextMenu(e: MouseEvent, p: ProjectInfo) {
  if (selecting.value) return
  emit('context-menu', e, p)
}

function doBatchDelete() {
  const dirs = [...selectedDirs.value]
  if (!dirs.length) return
  emit('batch-delete', dirs)
}

defineExpose({ exitSelect })
</script>

<template>
  <aside
    class="sidebar"
  >
    <div class="sidebar-top">
      <div class="agent-switch">
        <button
          v-for="a in agents"
          :key="a"
          :class="{ active: agent === a }"
          @click="emit('switch-agent', a)"
        >
          <component :is="agentIcons[a]" />
          <span>{{ agentLabel(a) }}</span>
        </button>
      </div>
      <div class="sidebar-sub">
        <template v-if="selecting">
          <span class="sidebar-sub-label">{{ t('sidebar.selectedCount', { n: selectedDirs.size }) }}</span>
          <button
            type="button"
            class="sidebar-sub-btn"
            v-tooltip="allSelected ? t('list.tb.selectNone') : t('list.tb.selectAll')"
            @click="toggleSelectAll"
          >
            <IconCheck />
          </button>
          <button
            type="button"
            class="sidebar-sub-btn"
            v-tooltip="t('list.tb.selectCancel')"
            @click="exitSelect"
          >
            <IconClose />
          </button>
          <span class="sidebar-sub-divider" />
          <button
            type="button"
            class="sidebar-sub-btn danger"
            :disabled="!selectedDirs.size"
            v-tooltip="t('sidebar.batchDelete')"
            @click="doBatchDelete"
          >
            <IconTrash />
          </button>
        </template>
        <template v-else>
          <span class="sidebar-sub-label">
            {{ agentName }} ·
            {{ t('sidebar.projectsCount', { count: projects.length }) }}
          </span>
          <button
            type="button"
            class="sidebar-sub-btn"
            v-tooltip="t('sidebar.addFolder')"
            @click="emit('add-bookmark')"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z"/></svg>
          </button>
          <button
            v-if="projects.length > 1"
            type="button"
            class="sidebar-sub-btn"
            v-tooltip="t('list.tb.select')"
            @click="selecting = true"
          >
            <IconSelect />
          </button>
          <button
            type="button"
            class="sidebar-sub-btn"
            :class="{ spinning: refreshing }"
            v-tooltip="t('sidebar.refresh')"
            :disabled="refreshing"
            @click="emit('refresh')"
          >
            <IconRefresh />
          </button>
        </template>
      </div>
    </div>

    <div class="proj-list">
      <template v-for="entry in groupedEntries" :key="entry.project.dirName">
        <div
          class="proj-item"
          :class="{
            active: activeDir === entry.project.dirName && !showTrash && !selecting,
            missing: !entry.project.exists,
            pinned: projStateOf(entry.project) === 'pinned',
            sunk: projStateOf(entry.project) === 'sunk',
            selected: selecting && selectedDirs.has(entry.project.dirName),
            'wt-child': entry.kind === 'child',
          }"
          :data-path="entry.project.displayPath"
          v-tooltip:right="entry.project.exists ? entry.project.displayPath : entry.project.displayPath + t('proj.missing')"
          @click="onProjClick(entry.project)"
          @contextmenu="onProjContextMenu($event, entry.project)"
        >
          <span v-if="selecting" class="proj-check" :class="{ checked: selectedDirs.has(entry.project.dirName) }">
            <IconCheck v-if="selectedDirs.has(entry.project.dirName)" />
          </span>
          <span
            v-if="!selecting && projStateOf(entry.project) === 'pinned'"
            class="pin-dot"
            :style="{ background: pinColor(entry.project) }"
            :aria-label="t('proj.pin')"
          />
          <span
            v-if="entry.kind === 'parent' && !selecting"
            class="wt-toggle"
            @click.stop="toggleWorktreeCollapse(entry.project.dirName)"
          >
            <svg
              viewBox="0 0 16 16" width="12" height="12" fill="currentColor"
              :class="{ collapsed: collapsedWorktrees.has(entry.project.dirName) }"
            >
              <path d="M5.5 3.5L10.5 8 5.5 12.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <IconGitBranch v-if="entry.kind === 'child'" class="wt-icon" />
          <span class="proj-name">{{
            entry.kind === 'child' ? entry.project.worktreeName ?? shortName(entry.project.displayPath) : shortName(entry.project.displayPath)
          }}</span>
          <span class="proj-count">{{ entry.project.sessionCount }}</span>
        </div>
      </template>
      <div v-if="!projects.length" class="sidebar-sub" style="padding: 12px">
        {{ t('sidebar.noSessions', { agent: agentName }) }}
      </div>
    </div>

    <div class="sidebar-footer">
      <button
        class="trash-tab"
        :class="{ 'has-update': updateAvailable }"
        v-tooltip="updateAvailable
          ? t('sidebar.updateAvailable', { v: latestVersion ?? '' })
          : t('sidebar.settings')"
        @click="emit('open-settings')"
      >
        <IconSettings /> {{ t('sidebar.settings') }}
        <!-- 有新版本时，行尾多挂一个"打开 release 页"按钮（点它直接去 GitHub）+
             指示红点。@click.stop 防止冒泡到外层 button，否则会顺手把 Settings
             也打开 —— 用户其实只想去 release 页。 -->
        <span
          v-if="updateAvailable"
          class="sidebar-release-btn"
          role="button"
          tabindex="0"
          v-tooltip="t('sidebar.openRelease', { v: latestVersion ?? '' })"
          :aria-label="t('sidebar.openRelease', { v: latestVersion ?? '' })"
          @click.stop="openReleasePage()"
          @keydown.enter.stop.prevent="openReleasePage()"
          @keydown.space.stop.prevent="openReleasePage()"
        >
          <IconExternalLink />
        </span>
        <span v-if="updateAvailable" class="update-dot" aria-hidden="true" />
      </button>
    </div>
  </aside>
</template>
