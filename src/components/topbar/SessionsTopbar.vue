<script setup lang="ts">
import type { ProjectInfo } from '../../types'

defineProps<{
  project: ProjectInfo
}>()
</script>

<template>
  <div class="page-topbar-slot">
    TODO: 会话列表工具栏（搜索 / 排序：时间 ↑↓ · 大小 · 消息数 / 仅显示有 ID 的）
  </div>
</template>
