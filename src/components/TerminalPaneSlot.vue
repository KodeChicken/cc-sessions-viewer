<script setup lang="ts">
// 当前 active tab 的"挂载位"。
// 不持有自己的 Terminal —— Terminal 实例由 terminals.ts 全局保管；这里只是把 tab
// 的 container 元素 append 进自己的 hostEl，切 tab 时再换一个 container。这样 xterm
// 的 scrollback / 选区 / 光标位置在切换之间不丢。

import { onMounted, onUnmounted, ref, watch } from 'vue'
import { tabs, activeUiId, refit } from '../terminals'

const hostEl = ref<HTMLDivElement>()
let ro: ResizeObserver | null = null

function attachActive() {
  const root = hostEl.value
  if (!root) return
  // 先清空当前挂载点：把已经在 host 里的子节点（容器们）摘出去 —— 它们仍存活在
  // 对应 tab 上，下次激活会再 append 回来。
  while (root.firstChild) {
    root.removeChild(root.firstChild)
  }
  const id = activeUiId.value
  if (id === null) return
  const tab = tabs.value.find((t) => t.uiId === id)
  if (!tab) return
  root.appendChild(tab.container)
  // 等浏览器把新节点布局完再 fit + focus，否则 fitAddon 拿到的可能还是 0。
  requestAnimationFrame(() => {
    refit(id)
    try {
      tab.term.focus()
    } catch {
      /* term 已被 dispose（罕见 race） */
    }
  })
}

watch(activeUiId, attachActive)
// tabs 数量变化也可能要重挂（关闭当前 active 时 activeUiId 已经在 closeTab 里换好了）
watch(() => tabs.value.length, attachActive)

onMounted(() => {
  attachActive()
  // 容器尺寸变化（侧栏开合 / 窗口 resize）→ refit 当前 active
  ro = new ResizeObserver(() => refit())
  if (hostEl.value) ro.observe(hostEl.value)
})

onUnmounted(() => {
  ro?.disconnect()
  ro = null
  // 不 dispose Terminal —— 那是 terminals.closeTab 的职责。仅把容器从 host 摘走。
  if (hostEl.value) {
    while (hostEl.value.firstChild) {
      hostEl.value.removeChild(hostEl.value.firstChild)
    }
  }
})
</script>

<template>
  <div ref="hostEl" class="terminal-slot" />
</template>
