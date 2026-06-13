<script setup lang="ts">
// 全局搜索模态 —— Algolia 风格的浮层：输入 / 结果分组 / 底部快捷键提示。
//
// 数据流：
//   - 父级（App.vue）通过 v-model:show / @open 控制显隐和打开命中
//   - 本组件自己管 input + debounce + api 调用 + 键盘导航
//   - 命中按 projectDisplay 分组，组内按 session.modified 倒序
//   - 通过 globalSearch.ts 的 pushRecent 在每次「成功打开」后写最近搜索

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Agent, SearchField, SearchHit, SessionMeta } from '../types'
import { searchSessions, cancelSearch, nextSearchRequestId } from '../api'
import { t } from '../i18n'
import { shortName, highlightSegments } from '../format'
import {
  recentSearches,
  pushRecent,
  clearRecents,
  removeRecent,
} from '../globalSearch'
import {
  IconSearch,
  IconClose,
  IconCornerDownLeft,
  IconArrowUp,
  IconArrowDown,
  IconHistory,
} from '../components/icons'

const props = defineProps<{
  show: boolean
  agent: Agent
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'open', hit: SearchHit): void
}>()

const inputEl = ref<HTMLInputElement>()
const listEl = ref<HTMLElement>()
const query = ref('')
const hits = ref<SearchHit[]>([])
const loading = ref(false)
const selectedIdx = ref(0)
// IME 组合中 —— `compositionstart..end` 之间不要触发搜索；Vue v-model 对原生 input
// 已经会跳过 input 事件，但我们用的是 `:value + @input + @composition*`，需要手动盯。
const composing = ref(false)

// 全局搜索是「重操作」（跨项目 / 跨会话 / 全文）—— 防抖给得保守一点：
//   - 输入到正式 fire 之间至少 450ms 静止
//   - 单字符不打（命中量大噪声多，也省得每个键都跑一次）
//   - "Searching…" 状态也防抖 220ms 才显示，避免每个键都闪烁
const DEBOUNCE_MS = 900
const MIN_QUERY_LEN = 2
// 命中很多时只渲染前 RENDER_CAP 条（后端最多返 200）—— 渲染 100+ 行的高亮 + 分组
// 在低端机上是几十 ms 的开销，会让输入框感知到「卡」。
const RENDER_CAP = 80

let debounceTimer = 0
let loadingTimer = 0
let reqSeq = 0
// 当前有没有正在 round-trip 的 search_sessions —— 用来决定是否需要先 cancel_search。
// 单纯的标志位即可，因为 reqSeq 已经能在前端层把过期结果丢掉，这个只用来省 RPC。
let inFlight = false

/** 输入打断在跑的搜索：通过 Tauri 调用 cancel_search 让后端循环 bail，
 *  释放 CPU / 磁盘给打字。失败也无所谓 —— reqSeq 守卫保证结果不会污染 UI。 */
function abortInFlight() {
  if (!inFlight) return
  inFlight = false
  cancelSearch().catch(() => {})
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      // 打开时清空上次的状态，把焦点抢到 input 上。
      query.value = ''
      hits.value = []
      selectedIdx.value = 0
      loading.value = false
      composing.value = false
      window.clearTimeout(debounceTimer)
      window.clearTimeout(loadingTimer)
      nextTick(() => {
        inputEl.value?.focus()
      })
    }
  },
)

function scheduleSearch(q: string) {
  selectedIdx.value = 0
  window.clearTimeout(debounceTimer)
  window.clearTimeout(loadingTimer)
  // 进入「新输入」状态 —— 把可能还在跑的旧搜索掐掉（React Fiber 式可中断）。
  abortInFlight()
  const trimmed = q.trim()
  if (trimmed.length < MIN_QUERY_LEN) {
    hits.value = []
    loading.value = false
    return
  }
  hits.value = []
  loading.value = true
  debounceTimer = window.setTimeout(async () => {
    const seq = ++reqSeq
    const reqId = nextSearchRequestId()
    inFlight = true
    try {
      const res = await searchSessions(props.agent, trimmed, reqId)
      if (seq !== reqSeq) return
      hits.value = res
    } catch {
      if (seq !== reqSeq) return
      hits.value = []
    } finally {
      // 只有「最后一次发起的搜索」才把状态归位；旧搜索的 finally 不要踩到。
      if (seq === reqSeq) {
        inFlight = false
        window.clearTimeout(loadingTimer)
        loading.value = false
      }
    }
  }, DEBOUNCE_MS)
}

// 直接监听 `query` —— composition 中我们不会写 query，所以 watch 不会误触发；
// commit/clear 也是写 query，watch 自然接住。
watch(query, (q) => {
  if (composing.value) return
  scheduleSearch(q)
})

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (composing.value) {
    // 组合中：让原生 input 自己维护显示的中间态，但不要把它写进 query —— 否则
    // watch 会触发一次「半成品」搜索。组合结束时再统一同步。
    return
  }
  query.value = v
}
function onCompositionStart() {
  composing.value = true
  window.clearTimeout(debounceTimer)
  window.clearTimeout(loadingTimer)
  abortInFlight()
}
function onCompositionEnd(e: Event) {
  composing.value = false
  // 组合刚结束 —— 把最终值写进 query，让防抖正常排队。
  query.value = (e.target as HTMLInputElement).value
}

// 命中分组：保留出现顺序（后端已经按项目 last_modified → 会话 modified 排序）。
// 渲染时切 RENDER_CAP 条，余量做计数提示——避免一次性渲染上百行卡输入框。
const renderedHits = computed<SearchHit[]>(() => hits.value.slice(0, RENDER_CAP))
const moreHidden = computed<number>(() =>
  Math.max(0, hits.value.length - renderedHits.value.length),
)
type Group = { project: string; items: SearchHit[] }
const groups = computed<Group[]>(() => {
  const out: Group[] = []
  const byProject = new Map<string, Group>()
  for (const h of renderedHits.value) {
    let g = byProject.get(h.projectDisplay)
    if (!g) {
      g = { project: h.projectDisplay, items: [] }
      byProject.set(h.projectDisplay, g)
      out.push(g)
    }
    g.items.push(h)
  }
  return out
})

// 扁平索引 —— 上下键导航只看扁平顺序，与 groups 渲染顺序一致。
const flatHits = computed<SearchHit[]>(() => groups.value.flatMap((g) => g.items))

function close() {
  // 关闭也算「输入释放」—— 如果还有搜索在跑，让它退出。
  abortInFlight()
  emit('update:show', false)
}

function chooseHit(hit: SearchHit) {
  pushRecent(query.value)
  emit('open', hit)
  close()
}

function onSelect() {
  if (loading.value) return
  const hit = flatHits.value[selectedIdx.value]
  if (hit) chooseHit(hit)
}

function moveSelection(delta: number) {
  const n = flatHits.value.length
  if (!n) return
  selectedIdx.value = (selectedIdx.value + delta + n) % n
  nextTick(() => scrollSelectedIntoView())
}

function scrollSelectedIntoView() {
  const list = listEl.value
  if (!list) return
  const el = list.querySelector<HTMLElement>(`.gs-row[data-idx="${selectedIdx.value}"]`)
  // 测试环境下的 jsdom 没有 scrollIntoView；判一下避免 unhandled rejection。
  el?.scrollIntoView?.({ block: 'nearest' })
}

function onKeydown(e: KeyboardEvent) {
  if (!props.show) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    onSelect()
  }
}

function pickRecent(r: string) {
  query.value = r
  nextTick(() => inputEl.value?.focus())
}

// 字段标签 —— 跟随 i18n，给结果行右上角的小 chip 用。
function fieldLabel(f: SearchField): string {
  return t(`search.global.field.${f}`)
}

// 当前组内每一项的扁平索引（用于 selectedIdx 关联）。
function indexOf(hit: SearchHit): number {
  return flatHits.value.indexOf(hit)
}

// 标题 / snippet 上的关键词高亮 —— 复用列表里的 highlightSegments。
function segs(text: string) {
  return highlightSegments(text, query.value)
}

// 显示用：会话标题 & 项目短名。
function sessionLabel(s: SessionMeta): string {
  return s.title || (s.id ? s.id.slice(0, 8) : '—')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearTimeout(debounceTimer)
  window.clearTimeout(loadingTimer)
  // 组件卸载也算「输入释放」—— 把后端循环放出来。
  abortInFlight()
})
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="overlay gs-overlay" @click.self="close">
      <div class="gs-modal" role="dialog" aria-modal="true">
        <!-- 顶部：放大镜 + 输入框 -->
        <div class="gs-head">
          <span class="gs-head-ic"><IconSearch /></span>
          <input
            ref="inputEl"
            :value="query"
            type="text"
            class="gs-input"
            :placeholder="t('search.global.placeholder')"
            spellcheck="false"
            autocomplete="off"
            @input="onInput"
            @compositionstart="onCompositionStart"
            @compositionend="onCompositionEnd"
          />
          <button class="gs-clear" v-tooltip="t('chat.tb.search.clear')" @click="close">
            <IconClose />
          </button>
        </div>

        <!-- 中部：结果 / 最近搜索 / 空态 -->
        <div ref="listEl" class="gs-body">
          <template v-if="!query.trim()">
            <div v-if="recentSearches.length" class="gs-recent">
              <div class="gs-section">
                <span class="gs-section-label">
                  <IconHistory />
                  <span>{{ t('search.global.recent') }}</span>
                </span>
                <button class="gs-section-clear" @click="clearRecents">
                  {{ t('search.global.clearRecent') }}
                </button>
              </div>
              <div
                v-for="r in recentSearches"
                :key="r"
                class="gs-recent-row"
                role="button"
                tabindex="0"
                @click="pickRecent(r)"
                @keydown.enter.prevent="pickRecent(r)"
              >
                <IconHistory class="gs-recent-ic" />
                <span class="gs-recent-text">{{ r }}</span>
                <button
                  class="gs-recent-remove"
                  v-tooltip="t('search.global.removeRecent')"
                  :aria-label="t('search.global.removeRecent')"
                  @click.stop="removeRecent(r)"
                >
                  <IconClose />
                </button>
              </div>
            </div>
            <div v-else class="gs-empty">
              <div class="gs-empty-title">{{ t('search.global.empty') }}</div>
              <div class="gs-empty-hint">{{ t('search.global.emptyHint') }}</div>
            </div>
          </template>

          <template v-else>
            <div v-if="loading && !hits.length" class="gs-status">
              {{ t('search.global.searching') }}
            </div>
            <div v-else-if="!hits.length" class="gs-empty">
              <div class="gs-empty-title">{{ t('search.global.noMatch') }}</div>
            </div>
            <div v-else class="gs-results">
              <div v-for="g in groups" :key="g.project" class="gs-group">
                <div class="gs-group-head">{{ shortName(g.project) }}</div>
                <button
                  v-for="h in g.items"
                  :key="h.session.path"
                  class="gs-row"
                  :class="{ active: selectedIdx === indexOf(h) }"
                  :data-idx="indexOf(h)"
                  @click="chooseHit(h)"
                  @mouseenter="selectedIdx = indexOf(h)"
                >
                  <div class="gs-row-main">
                    <div class="gs-row-title">
                      <span v-for="(seg, i) in segs(sessionLabel(h.session))" :key="i" :class="{ 'kw-hit': seg.hit }">{{ seg.text }}</span>
                    </div>
                    <div v-if="h.matchedField === 'text' || h.matchedField === 'path'" class="gs-row-snippet">
                      <span v-for="(seg, i) in segs(h.snippet)" :key="i" :class="{ 'kw-hit': seg.hit }">{{ seg.text }}</span>
                    </div>
                  </div>
                  <span class="gs-row-field">{{ fieldLabel(h.matchedField) }}</span>
                </button>
              </div>
              <!-- 后端最多返 200 条，前端为了让列表保持流畅只渲染前 80 条；
                   余下的提示用户继续打字以缩窄搜索。 -->
              <div v-if="moreHidden > 0" class="gs-more">
                {{ t('search.global.moreHidden', { n: moreHidden }) }}
              </div>
            </div>
          </template>
        </div>

        <!-- 底部：键盘提示 -->
        <div class="gs-foot">
          <span class="gs-foot-item">
            <kbd class="gs-kbd"><IconCornerDownLeft /></kbd>
            {{ t('search.global.hint.select') }}
          </span>
          <span class="gs-foot-item">
            <kbd class="gs-kbd"><IconArrowDown /></kbd>
            <kbd class="gs-kbd"><IconArrowUp /></kbd>
            {{ t('search.global.hint.navigate') }}
          </span>
          <span class="gs-foot-item">
            <kbd class="gs-kbd gs-kbd-esc">esc</kbd>
            {{ t('search.global.hint.close') }}
          </span>
        </div>
      </div>
    </div>
  </Transition>
</template>
