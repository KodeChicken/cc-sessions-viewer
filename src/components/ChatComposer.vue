<script setup lang="ts">
// GUI chat 输入框 —— 视觉 / 交互参考 Claude 桌面客户端。
//   · 大号圆角多行输入，右侧内嵌 发送(↵)/停止(□) 按钮
//   · 图片：粘贴(⌘V) / 拖拽 / "+" 选择 → 上方缩略图附件行，可单独移除
//   · 行首 "/" 调出可过滤的指令浮层（MVP 内置一份常用命令）
//   · 底栏：左 权限模式 chip + "+" 附件；右 模型名 + running spinner
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import * as api from '../api'
import { sendPrompt, interruptChat, now, type ChatSession } from '../chatSessions'
import type { ChatImageAttachment, SlashCommand } from '../types'
import { IconPlus, IconSend, IconStop, IconClose } from './icons'
import ChatModeMenu from './ChatModeMenu.vue'
import ChatModelMenu from './ChatModelMenu.vue'
import ChatEffortSlider from './ChatEffortSlider.vue'
import AutoModeConfirmModal from './AutoModeConfirmModal.vue'
import {
  hasModelChoice,
  modelSupportsEffort,
  fallbackPermissionMode,
  fallbackEffort,
  type ModelMenuOptions,
} from '../chatComposerOptions'
import { isAutoModeConfirmed, rememberAutoModeConfirmed } from '../autoMode'
import {
  usedContextTokens,
  contextWindowFor,
  contextPercent,
  formatTokensShort,
} from '../chatContext'
import {
  usage,
  usageWindows,
  usageLevel,
  formatRemaining,
  nowMs,
  startUsagePolling,
  stopUsagePolling,
} from '../usage'

const props = defineProps<{ session: ChatSession }>()
const claudeHasCustomBaseUrl = ref(false)
const claudeAliasTargets = ref<Record<string, string | undefined>>({})
// init 事件回来前对鉴权方式的预判（后端 runtime_info 判：钥匙串有订阅凭证 → 'none'）。
// 进会话即拿，让官方订阅用户立刻看到 effort + 限额，而不是等首轮 init 才显形。
const claudeRuntimeApiKeySource = ref<string | undefined>(undefined)

// 进入 live chat 即订阅账号额度轮询，离开退订（引用计数，多个 composer 共享一个定时器）。
onMounted(() => {
  startUsagePolling()
  if (props.session.agent === 'claude') {
    void api
      .claudeRuntimeInfo()
      .then((info) => {
        claudeHasCustomBaseUrl.value = !!info.hasCustomBaseUrl
        claudeAliasTargets.value = info.aliasTargets ?? {}
        claudeRuntimeApiKeySource.value = info.apiKeySource || undefined
      })
      .catch(() => {
        claudeHasCustomBaseUrl.value = false
        claudeAliasTargets.value = {}
        claudeRuntimeApiKeySource.value = undefined
      })
  }
})
onBeforeUnmount(stopUsagePolling)

const text = ref('')
const images = ref<ChatImageAttachment[]>([])
const taEl = ref<HTMLTextAreaElement>()
const fileEl = ref<HTMLInputElement>()
const previewSrc = ref('') // 点击缩略图后的大图预览（空 = 不显示）

const running = computed(() => props.session.turnState === 'running')
const ended = computed(
  () => props.session.status === 'exited' || props.session.status === 'error',
)
const canSend = computed(
  () => !running.value && !ended.value && (!!text.value.trim() || images.value.length > 0),
)

/** running 时的耗时秒数（读模块时钟 now 驱动）。 */
const elapsedSec = computed(() => {
  if (!running.value) return 0
  return Math.max(0, Math.floor((now.value - props.session.turnStartedAt) / 1000))
})

// ---------- §10.2/10.3/10.4 底栏切换器 ----------
// 改的只是 session 上的当前选择（懒生效）：one-shot（Codex）下一轮带新 flag 即生效；
// 长驻（Claude）由下一次 sendPrompt 检测到变更后 restart-with-resume。t() 让 label 随
// 语言 / session 选择响应式刷新。
const agent = computed(() => props.session.agent)
// 权威值（init 给的 session.apiKeySource）优先；没来之前用 runtime 预判兜底。
const effectiveApiKeySource = computed(
  () => props.session.apiKeySource ?? claudeRuntimeApiKeySource.value,
)
const usingApiKey = computed(() => {
  const src = effectiveApiKeySource.value
  return typeof src === 'string' && src !== '' && src !== 'none'
})
const usingCustomClaudeEndpoint = computed(
  () => props.session.agent === 'claude' && claudeHasCustomBaseUrl.value,
)
const claudeAliasMode = computed(
  () =>
    agent.value === 'claude' &&
    (effectiveApiKeySource.value !== 'none' || usingCustomClaudeEndpoint.value),
)
const modelMenuOptions = computed<ModelMenuOptions>(() => ({
  claudeAliasMode: claudeAliasMode.value,
  claudeAliasTargets: claudeAliasTargets.value,
}))
const showModelPicker = computed(() => hasModelChoice(agent.value, modelMenuOptions.value))
// effort 是「按模型」的能力：Haiku 不支持 effort，选中它就不展示滑杆（对齐 Claude 客户端）。
const showEffortPicker = computed(() =>
  (agent.value !== 'claude' || effectiveApiKeySource.value === 'none') &&
  !usingCustomClaudeEndpoint.value &&
  !usingApiKey.value &&
  modelSupportsEffort(agent.value, props.session.model),
)

// 切到 auto（自动）模式前的二次确认门控：本工作区还没确认过就先弹框，确认后才真正生效
// 并记住该工作区（之后不再追问）。其它模式直接切。
const askAutoMode = ref(false)
function onPickPermission(v: string) {
  if (
    v === 'auto' &&
    props.session.permissionMode !== 'auto' &&
    !isAutoModeConfirmed(props.session.cwd)
  ) {
    askAutoMode.value = true
    return
  }
  props.session.permissionMode = v
}
function confirmAutoMode() {
  rememberAutoModeConfirmed(props.session.cwd)
  props.session.permissionMode = 'auto'
  askAutoMode.value = false
}
function cancelAutoMode() {
  askAutoMode.value = false
}
function onPickModel(v: string) {
  const model = v || undefined
  props.session.model = model
  // 新模型若不支持当前权限模式（如 Haiku 不支持 auto），自动回退到可用模式。
  props.session.permissionMode = fallbackPermissionMode(props.session.permissionMode, model)
  // 当前 effort 档在新模型下不存在（如从 4.8 的 ultracode 切到 Sonnet）→ 退到最高可用档。
  props.session.effort = fallbackEffort(props.session.effort, props.session.agent, model)
}
function onPickEffort(v: string) {
  props.session.effort = v || undefined
}

// ---------- §10.5 上下文窗口 + 限额指示 ----------
const ctxUsed = computed(() => usedContextTokens(props.session.usage))
const ctxWindow = computed(() =>
  contextWindowFor(
    props.session.agent,
    props.session.lastModel ?? props.session.model,
    ctxUsed.value,
  ),
)
const ctxPercent = computed(() => contextPercent(ctxUsed.value, ctxWindow.value))
// 常驻显示：只要有已知窗口就一直显示（首轮前为 0%），不再随 usage 有无而闪烁。
const showContext = computed(() => ctxWindow.value > 0)
const ctxTooltip = computed(
  () =>
    `${t('chat.composer.context.label')}: ${formatTokensShort(ctxUsed.value)} / ${formatTokensShort(
      ctxWindow.value,
    )} (${ctxPercent.value}%)`,
)

// 限额：走 OAuth 用量接口（src/usage.ts 轮询），每个窗口带精确利用率 + 重置时间，不受
// 「越过阈值才上报」限制，故 5h / 周能随时精确显示（context 在外层最先 → 5h → 周）。
// Claude 的 5h/周额度只对订阅/OAuth（apiKeySource === 'none'）成立。API key 计费一律不显示，
// 避免把第三方/API-key 会话误判成订阅。init 没回来前用 runtime 预判兜底（effectiveApiKeySource），
// 官方订阅一进会话即显示；真判不出（预判也未知）时仍保守隐藏。
const showRateLimits = computed(
  () =>
    props.session.agent === 'claude' &&
    effectiveApiKeySource.value === 'none' &&
    !usingCustomClaudeEndpoint.value,
)
function rlResetText(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  // 重置往往隔天（尤其周限额）→ 跨天则带上 月/日。
  return d.toDateString() === now.toDateString()
    ? `${hh}:${mm}`
    : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}
function rlTypeLabel(key: 'five_hour' | 'seven_day'): string {
  return key === 'five_hour' ? t('chat.composer.limit.fiveHour') : t('chat.composer.limit.weekly')
}
const rateBadges = computed(() => {
  if (!showRateLimits.value || usingApiKey.value) return []
  const now = nowMs.value // 读响应式心跳 → 倒计时每跳重算（纯前端，零网络）。
  return usageWindows(usage.value).map((w) => {
    const label = rlTypeLabel(w.key)
    const remaining = formatRemaining(w.resetsAt, now) // 紧凑倒计时：4h30m / 2d6h / 45m
    const reset = rlResetText(w.resetsAt)
    return {
      key: w.key,
      // 「<窗口> <百分比>% · <倒计时>」，对齐 claude-hud；倒计时缺失则省略。
      text: remaining ? `${label} ${w.percent}% · ${remaining}` : `${label} ${w.percent}%`,
      level: usageLevel(w.percent),
      // 悬浮显示绝对重置时刻（与行内相对倒计时互补）。
      tooltip: reset ? t('chat.composer.limit.resets', { time: reset }) : `${label} ${w.percent}%`,
    }
  })
})

// 点击输入框空白处（非按钮/缩略图）→ 聚焦文本框，像原生输入框一样。
function onWrapClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('button')) return
  if ((e.target as HTMLElement).closest('.cc-thumb')) return
  if (!ended.value) taEl.value?.focus()
}

// 大图预览：Esc 关闭。
function onPreviewKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && previewSrc.value) previewSrc.value = ''
}
window.addEventListener('keydown', onPreviewKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKey))

// ---------- 自适应高度 ----------
function autosize() {
  const el = taEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`
}

// ---------- slash 指令浮层（§10.1 动态发现）----------
// 列表来自后端磁盘扫描（自定义命令 / user-invocable skills）；**不含 TUI 内置命令**
// （headless 下会报「not available」）。选中后按 `/<name>` 透传，CLI 自己展开。
interface SlashItem { cmd: string; desc: string }
const slashCommands = ref<SlashItem[]>([])

async function loadSlashCommands() {
  try {
    const cmds: SlashCommand[] = await api.agentChatSlashCommands(
      props.session.agent,
      props.session.cwd,
    )
    slashCommands.value = cmds.map((c) => ({ cmd: `/${c.name}`, desc: c.description }))
  } catch {
    slashCommands.value = []
  }
}
// 进入会话 / 切换会话时拉一次。
watch(
  () => [props.session.agent, props.session.cwd],
  () => void loadSlashCommands(),
  { immediate: true },
)

const slashOpen = ref(false)
const slashIdx = ref(0)
const slashMatches = computed<SlashItem[]>(() => {
  const v = text.value
  // 仅行首单条 "/xxx"（无空格）触发。
  if (!v.startsWith('/') || /\s/.test(v)) return []
  const q = v.slice(1).toLowerCase()
  return slashCommands.value.filter((s) => s.cmd.slice(1).toLowerCase().startsWith(q))
})

function refreshSlash() {
  slashOpen.value = slashMatches.value.length > 0
  if (slashIdx.value >= slashMatches.value.length) slashIdx.value = 0
}

function pickSlash(item: SlashItem) {
  text.value = `${item.cmd} `
  slashOpen.value = false
  nextTick(() => {
    taEl.value?.focus()
    autosize()
  })
}

function onInput() {
  autosize()
  refreshSlash()
}

// ---------- 键盘 ----------
function onKeydown(e: KeyboardEvent) {
  if (slashOpen.value && slashMatches.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashIdx.value = (slashIdx.value + 1) % slashMatches.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashIdx.value = (slashIdx.value - 1 + slashMatches.value.length) % slashMatches.value.length
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      pickSlash(slashMatches.value[slashIdx.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashOpen.value = false
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}

// ---------- 图片附件 ----------
function readFile(file: File): Promise<ChatImageAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return resolve(null)
      resolve({
        dataUrl,
        mediaType: file.type || 'image/png',
        data: dataUrl.slice(comma + 1),
        name: file.name || 'image.png',
      })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

async function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('image/')) continue
    const att = await readFile(f)
    if (att) images.value.push(att)
  }
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const imgs = Array.from(items).filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
  if (!imgs.length) return
  e.preventDefault()
  const files = imgs.map((it) => it.getAsFile()).filter((f): f is File => !!f)
  void addFiles(files)
}

function onDrop(e: DragEvent) {
  const files = e.dataTransfer?.files
  if (files && files.length) {
    e.preventDefault()
    void addFiles(files)
  }
}

function pickFiles() {
  fileEl.value?.click()
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) void addFiles(input.files)
  input.value = ''
}
function removeImage(i: number) {
  images.value.splice(i, 1)
}

// ---------- 发送 / 停止 ----------
async function submit() {
  if (running.value) return
  if (!canSend.value) return
  const body = text.value
  const imgs = images.value
  text.value = ''
  images.value = []
  slashOpen.value = false
  nextTick(autosize)
  await sendPrompt(props.session, body, imgs)
}

function onPrimary() {
  if (running.value) {
    void interruptChat(props.session)
  } else {
    void submit()
  }
}
</script>

<template>
  <div class="chat-composer" @drop="onDrop" @dragover.prevent>
    <!-- 大图预览：点缩略图打开，点任意处 / Esc 关闭 -->
    <Teleport to="body">
      <div v-if="previewSrc" class="cc-preview" @click="previewSrc = ''">
        <img :src="previewSrc" alt="" @click.stop />
        <button class="cc-preview-x" v-tooltip="t('common.close')" @click="previewSrc = ''">
          <IconClose />
        </button>
      </div>
    </Teleport>

    <!-- 输入框：单个 div 容器 —— 框内含 slash 浮层 + 图片缩略图 + 文本行（图片在框内、不再单列在框外） -->
    <div class="cc-input-wrap" :class="{ disabled: ended }" @click="onWrapClick">
      <!-- slash 指令浮层 -->
      <div v-if="slashOpen" class="cc-slash" role="listbox">
        <button
          v-for="(s, i) in slashMatches"
          :key="s.cmd"
          class="cc-slash-item"
          :class="{ active: i === slashIdx }"
          role="option"
          @mouseenter="slashIdx = i"
          @click="pickSlash(s)"
        >
          <span class="cc-slash-cmd">{{ s.cmd }}</span>
          <span class="cc-slash-desc">{{ s.desc }}</span>
        </button>
      </div>

      <!-- 图片缩略图（框内顶部）：hover 显示文件名，点击预览 -->
      <div v-if="images.length" class="cc-attachments">
        <div
          v-for="(img, i) in images"
          :key="i"
          class="cc-thumb"
          v-tooltip="img.name || ''"
          @click="previewSrc = img.dataUrl"
        >
          <img :src="img.dataUrl" alt="" />
          <button
            class="cc-thumb-x"
            v-tooltip="t('chat.composer.removeImage')"
            @click.stop="removeImage(i)"
          >
            <IconClose />
          </button>
        </div>
      </div>

      <!-- 文本 + 内嵌发送/停止 -->
      <div class="cc-input-row">
        <textarea
          ref="taEl"
          v-model="text"
          class="cc-textarea"
          rows="1"
          :placeholder="ended ? t('chat.composer.ended') : t('chat.composer.placeholder')"
          :disabled="ended"
          @input="onInput"
          @keydown="onKeydown"
          @paste="onPaste"
        />

        <button
          class="cc-primary"
          :class="{ running }"
          :disabled="!running && !canSend"
          v-tooltip="running ? t('chat.composer.stop') : t('chat.composer.send')"
          @click="onPrimary"
        >
          <component :is="running ? IconStop : IconSend" />
        </button>
      </div>
    </div>

    <!-- 底栏：左 权限 chip + 附件；右 running spinner + 模型 / effort -->
    <div class="cc-footer">
      <div class="cc-footer-left">
        <ChatModeMenu
          :selected="session.permissionMode"
          :model="session.model"
          :disabled="ended"
          @pick="onPickPermission"
        />
        <button class="cc-attach-btn" v-tooltip="t('chat.composer.attach')" @click="pickFiles">
          <IconPlus />
        </button>
        <input
          ref="fileEl"
          type="file"
          accept="image/*"
          multiple
          class="cc-file-hidden"
          @change="onFileChange"
        />
      </div>
      <div class="cc-footer-right">
        <!-- 顺序：context → 5h → 周（用户要求）。context 占用 ≥70% 紫、≥90% 红。 -->
        <span
          v-if="showContext"
          class="cc-ctx"
          :class="{ warn: ctxPercent >= 70 && ctxPercent < 90, danger: ctxPercent >= 90 }"
          v-tooltip="ctxTooltip"
        >{{ ctxPercent }}%</span>
        <span
          v-for="b in rateBadges"
          :key="b.key"
          class="cc-ratelimit"
          :class="{ warn: b.level === 'warn', danger: b.level === 'danger' }"
          v-tooltip="b.tooltip"
        >{{ b.text }}</span>
        <span v-if="running" class="cc-running">
          <span class="cc-star" :class="session.agent">✳</span> {{ elapsedSec }}s
        </span>
        <ChatModelMenu
          v-if="showModelPicker"
          :agent="session.agent"
          :selected="session.model"
          :display-value="session.model ?? session.lastModel"
          :menu-options="modelMenuOptions"
          @pick="onPickModel"
        />
        <ChatEffortSlider
          v-if="showEffortPicker"
          :agent="session.agent"
          :model="session.model"
          :selected="session.effort"
          @pick="onPickEffort"
        />
      </div>
    </div>

    <AutoModeConfirmModal
      :show="askAutoMode"
      :cwd="session.cwd"
      @confirm="confirmAutoMode"
      @cancel="cancelAutoMode"
    />
  </div>
</template>

<style scoped>
.chat-composer {
  background: var(--bg);
  padding: 10px 22px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 附件缩略图 */
.cc-attachments {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.cc-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: zoom-in;
}
.cc-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cc-thumb-x {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: none;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.cc-thumb-x :deep(svg) {
  width: 10px;
  height: 10px;
}

/* 大图预览遮罩（Teleport 到 body；fixed inset:0 在 zoom 下仍铺满视口） */
.cc-preview {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.78);
  cursor: zoom-out;
  padding: 40px;
}
.cc-preview img {
  max-width: 92vw;
  max-height: 88vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  cursor: default;
}
.cc-preview-x {
  position: fixed;
  top: 18px;
  right: 18px;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: none;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.cc-preview-x:hover {
  background: rgba(255, 255, 255, 0.28);
}
.cc-preview-x :deep(svg) {
  width: 16px;
  height: 16px;
}

/* 输入框：div 容器，纵向 [缩略图] + [文本行]；图片在框内 */
.cc-input-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  padding: 10px 10px 10px 14px;
  transition: border-color 0.15s;
  cursor: text;
}
/* focus 边框：用柔和的中性灰（border-strong），别用近黑的 accent */
.cc-input-wrap:focus-within {
  border-color: var(--border-strong);
}
.cc-input-wrap.disabled {
  opacity: 0.7;
  cursor: default;
}
.cc-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.cc-textarea {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
  max-height: 220px;
  padding: 2px 0;
}
.cc-textarea::placeholder {
  color: var(--text-mute);
}
.cc-primary {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
}
/* 无填充背景；仅 hover 时浅灰 */
.cc-primary:hover:not(:disabled) {
  background: var(--surface-hover);
}
.cc-primary:disabled {
  opacity: 0.35;
  cursor: default;
}
.cc-primary.running {
  color: var(--text);
}
.cc-primary :deep(svg) {
  width: 15px;
  height: 15px;
}

/* slash 浮层 */
.cc-slash {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  max-height: 260px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
  padding: 4px;
  z-index: 30;
}
.cc-slash-item {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 10px;
  border: none;
  background: transparent;
  border-radius: 7px;
  cursor: pointer;
  text-align: left;
  color: var(--text);
}
.cc-slash-item.active {
  background: var(--surface-hover);
}
.cc-slash-cmd {
  font-weight: 600;
  font-size: 13px;
}
.cc-slash-desc {
  font-size: 12px;
  color: var(--text-mute);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 底栏 */
.cc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.cc-footer-left,
.cc-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cc-attach-btn {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.cc-attach-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.cc-attach-btn :deep(svg) {
  width: 16px;
  height: 16px;
}
.cc-file-hidden {
  display: none;
}
.cc-running {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
/* §10.5 上下文占用 % */
.cc-ctx {
  font-size: 12px;
  color: var(--text-mute);
  font-variant-numeric: tabular-nums;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: default;
}
/* 占用 ≥70%：紫色提醒（纯文字色，无背景） */
.cc-ctx.warn {
  color: #7c3aed;
}
/* 占用 ≥90%：红色告警（纯文字色，无背景） */
.cc-ctx.danger {
  color: #d92d20;
}
/* 账号额度徽标（5h / 周，OAuth 用量接口）。文本「<窗口> <百分比>%」。
   与 .cc-ctx 同款样式：同字号、同阈值配色、纯文字色不带背景。 */
.cc-ratelimit {
  font-size: 12px;
  color: var(--text-mute);
  font-variant-numeric: tabular-nums;
  cursor: default;
  padding: 2px 4px;
  border-radius: 6px;
}
/* ≥70%：紫色提醒（同 .cc-ctx.warn） */
.cc-ratelimit.warn {
  color: #7c3aed;
}
/* ≥90%：红色告警（同 .cc-ctx.danger） */
.cc-ratelimit.danger {
  color: #d92d20;
}
/* ✳ 是 agent 品牌标记，用 agent 自己的色调，不跟随主题 --brand。 */
.cc-star {
  color: var(--brand-claude, #d97757);
  animation: cc-spin 1.4s linear infinite;
  display: inline-block;
}
.cc-star.codex {
  color: var(--brand-codex);
}
.cc-star.gemini {
  color: var(--brand-gemini);
}
@keyframes cc-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
