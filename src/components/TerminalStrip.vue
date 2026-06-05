<script setup lang="ts">
// TUI tab 栏 —— main 顶部的横条。左边两个"meta tab"固定描述底层 view：
//   List —— 项目的会话列表（永远显示，前提是处于项目浏览模式）
//   View —— 当前打开的聊天详情（只在 hasOpenSession 时出现）
// 之后是当前 (agent, projectKey) 范围内的所有活跃 PTY tab。
//
// 隐藏的 PTY tab（别的项目 / 别的 agent）不在这里出现，但 PTY 仍在后台跑 ——
// 切回对应项目时它们会再次显示，scrollback 全程不丢。

import { computed } from 'vue'
import type { Agent } from '../types'
import { tabs, activeUiId, setActive, closeTab } from '../terminals'
import { IconClose, IconChat, IconList, agentIcons } from './icons'
import { t } from '../i18n'

const props = defineProps<{
  /** 当前侧栏选中的 agent */
  agent: Agent
  /** 当前选中的项目 dirName；null = 没选项目（欢迎页 / 回收站 / 统计页） */
  projectKey: string | null
  /** 当前是否处于"项目浏览"模式（活动项目 + 非回收站/统计） */
  inProjectBrowse: boolean
  /** 当前是否打开了某个会话 —— 用来决定要不要显示 View tab */
  hasOpenSession: boolean
}>()

const emit = defineEmits<{
  /** List —— 关闭当前会话 + 退出 TUI，回到项目会话列表 */
  listClick: []
  /** View —— 保留当前会话，仅退出 TUI，回到聊天详情 */
  viewClick: []
}>()

const visibleTabs = computed(() =>
  tabs.value.filter(
    (t) => t.agent === props.agent && t.projectKey === (props.projectKey ?? ''),
  ),
)
// strip 只在有可见 PTY tab 时出现 —— 没 TUI 的时候这条只剩个孤零零的 List 按钮没意义
// （此时主区已经显示列表 / 聊天，按钮的语义和现状重复）。
const visible = computed(() => visibleTabs.value.length > 0)
const listActive = computed(
  () => activeUiId.value === null && !props.hasOpenSession,
)
const viewActive = computed(
  () => activeUiId.value === null && props.hasOpenSession,
)

function shortTitle(title: string): string {
  if (!title) return t('chat.tui.untitled')
  if (title.length > 22) return title.slice(0, 20) + '…'
  return title
}

function onTabClick(uiId: number) {
  // 点已激活的 tab 不做切换 —— 避免和"× 关闭"的视觉位置混淆。要回 view 用左侧的 meta tab。
  if (activeUiId.value === uiId) return
  setActive(uiId)
}

function onListClick() {
  emit('listClick')
}
function onViewClick() {
  emit('viewClick')
}

function onClose(uiId: number, ev: Event) {
  ev.stopPropagation()
  closeTab(uiId)
}
</script>

<template>
  <div v-if="visible" class="terminal-strip" data-tauri-drag-region="false">
    <!-- List —— 项目浏览模式下永久显示 -->
    <div
      v-if="inProjectBrowse"
      class="term-tab view-tab"
      :class="{ active: listActive }"
      v-tooltip:bottom="t('chat.tui.listTabTooltip')"
      role="button"
      tabindex="0"
      @click="onListClick"
      @keydown.enter.prevent="onListClick"
      @keydown.space.prevent="onListClick"
    >
      <IconList class="term-tab-agent" />
      <span class="term-tab-title">{{ t('chat.tui.listTab') }}</span>
    </div>

    <!-- View —— 仅当用户已经打开了某个会话时显示 -->
    <div
      v-if="inProjectBrowse && hasOpenSession"
      class="term-tab view-tab"
      :class="{ active: viewActive }"
      v-tooltip:bottom="t('chat.tui.viewTabTooltip')"
      role="button"
      tabindex="0"
      @click="onViewClick"
      @keydown.enter.prevent="onViewClick"
      @keydown.space.prevent="onViewClick"
    >
      <IconChat class="term-tab-agent" />
      <span class="term-tab-title">{{ t('chat.tui.viewTab') }}</span>
    </div>

    <div
      v-if="inProjectBrowse && visibleTabs.length > 0"
      class="term-tab-sep"
      aria-hidden="true"
    />

    <div
      v-for="tab in visibleTabs"
      :key="tab.uiId"
      class="term-tab"
      :class="{
        active: activeUiId === tab.uiId,
        exited: tab.status === 'exited' || tab.status === 'error',
      }"
      v-tooltip:bottom="tab.title"
      role="button"
      tabindex="0"
      @click="onTabClick(tab.uiId)"
      @keydown.enter.prevent="onTabClick(tab.uiId)"
      @keydown.space.prevent="onTabClick(tab.uiId)"
    >
      <component :is="agentIcons[tab.agent]" class="term-tab-agent" :class="tab.agent" />
      <span class="term-tab-title">{{ shortTitle(tab.title) }}</span>
      <span
        v-if="tab.status === 'spawning'"
        class="term-tab-spinner"
        aria-hidden="true"
      />
      <span
        v-else-if="tab.status === 'exited' || tab.status === 'error'"
        class="term-tab-exited-dot"
        aria-hidden="true"
      />
      <span
        class="term-tab-close"
        v-tooltip:bottom="t('chat.tui.tabClose')"
        role="button"
        tabindex="0"
        @click="onClose(tab.uiId, $event)"
        @keydown.enter.prevent="onClose(tab.uiId, $event)"
      >
        <IconClose />
      </span>
    </div>
  </div>
</template>
