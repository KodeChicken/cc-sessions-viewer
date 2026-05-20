<script setup lang="ts">
import { computed } from 'vue'
import type { Block } from '../types'
import { t } from '../i18n'
import DiffBlock from './DiffBlock.vue'
import CollapsibleBox from './CollapsibleBox.vue'
import { IconChevronRight } from './icons'

const props = defineProps<{ block: Block; inUser?: boolean }>()

function baseName(p?: string): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

const label = computed(() => {
  if (props.block.diff)
    return t('tool.resultDiff', { file: baseName(props.block.filePath) })
  return props.block.isError ? t('tool.resultError') : t('tool.result')
})

const diffStat = computed(() => {
  if (!props.block.diff) return ''
  let add = 0
  let del = 0
  for (const h of props.block.diff)
    for (const l of h.lines) {
      if (l.kind === 'add') add++
      else if (l.kind === 'del') del++
    }
  return `+${add} −${del}`
})
</script>

<template>
  <details class="block-card" :class="{ 'in-user': inUser }" :open="!!block.diff">
    <summary class="block-summary">
      <span class="chev"><IconChevronRight /></span>
      <span class="label" :class="{ error: block.isError }">{{ label }}</span>
      <span v-if="diffStat" class="diff-stat">{{ diffStat }}</span>
    </summary>
    <div class="block-body">
      <CollapsibleBox :max-height="400">
        <DiffBlock v-if="block.diff" :hunks="block.diff" />
        <pre v-else>{{ block.text }}</pre>
      </CollapsibleBox>
    </div>
  </details>
</template>
