<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { t } from '../i18n'
import {
  codexShowArchivedSessions,
  codexShowInternalSessions,
  lang,
  setCodexShowArchivedSessions,
  setCodexShowInternalSessions,
  setLang,
  setTheme,
  setFontScale,
  setUseExternalTerminal,
  setTerminalApp,
  applyTerminalDefault,
  launchArgs,
  setLaunchArgs,
  theme,
  fontScale,
  useExternalTerminal,
  terminalApp,
  type Lang,
  type Theme,
  type FontScale,
  type TerminalApp,
} from '../settings'
import { formatSize } from '../format'
import {
  IconClose,
  IconLanguages,
  IconPalette,
  IconTerminal,
  IconDatabase,
  IconInfo,
  IconRefresh,
  IconExternalLink,
  IconCheck,
  IconChevronDown,
  agentIcons,
  terminalIcons,
} from './icons'
import * as api from '../api'
import {
  latestVersion,
  openReleasePage,
  syncFromManualCheck,
  updateAvailable,
} from '../updateCheck'

type SettingsTab = 'general' | 'advanced' | 'shortcuts'

const isMac = /Mac/i.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl'
const shift = isMac ? '⇧' : 'Shift'
const sep = isMac ? '' : '+'
const k = (parts: string[]) => parts.join(sep)
const shortcuts = [
  { key: k([mod, shift, 'F']), label: 'settings.shortcut.globalSearch' },
  { key: k([mod, 'F']), label: 'settings.shortcut.findInSession' },
  { key: k([mod, 'G']), label: 'settings.shortcut.findNext' },
  { key: k([mod, shift, 'G']), label: 'settings.shortcut.findPrev' },
  { key: k([mod, 'N']), label: 'settings.shortcut.newSession' },
  { key: k([mod, 'O']), label: 'settings.shortcut.addFolder' },
  { key: k([mod, 'E']), label: 'settings.shortcut.exportSession' },
  { key: k([mod, 'B']), label: 'settings.shortcut.toggleSidebar' },
  { key: k([mod, shift, 'S']), label: 'settings.shortcut.stats' },
  { key: k([mod, shift, 'T']), label: 'settings.shortcut.trash' },
  { key: k([mod, ',']), label: 'settings.shortcut.settings' },
  { key: k([mod, '/']), label: 'settings.shortcut.shortcuts' },
  { key: 'Esc', label: 'settings.shortcut.escape' },
]

const props = defineProps<{ cacheBytes: number; initialTab?: SettingsTab }>()
const emit = defineEmits<{ close: []; clearCache: [] }>()

const activeTab = ref<SettingsTab>(props.initialTab ?? 'general')

const cacheLabel = computed(() =>
  props.cacheBytes > 0 ? formatSize(props.cacheBytes) : '0 B',
)

const version = ref('—')
const updateMsg = ref('')
const checking = ref(false)
const installingClaudeHooks = ref(false)
const claudeHooksMsg = ref('')

// custom dropdown state
const langMenuOpen = ref(false)
const themeMenuOpen = ref(false)
const terminalMenuOpen = ref(false)
const langWrapEl = ref<HTMLElement>()
const themeWrapEl = ref<HTMLElement>()
const terminalWrapEl = ref<HTMLElement>()

const isMacOS = /Mac/i.test(navigator.platform)
const availableTerminals = ref<string[]>([])
type TermOpt = { v: TerminalApp; key: string }
const terminalOptions = computed<TermOpt[]>(() => {
  const base: TermOpt[] = [{ v: 'terminal', key: 'settings.terminalApp.terminal' }]
  if (availableTerminals.value.includes('cmux'))
    base.push({ v: 'cmux', key: 'settings.terminalApp.cmux' })
  if (availableTerminals.value.includes('iterm2'))
    base.push({ v: 'iterm2', key: 'settings.terminalApp.iterm2' })
  if (availableTerminals.value.includes('ghostty'))
    base.push({ v: 'ghostty', key: 'settings.terminalApp.ghostty' })
  if (availableTerminals.value.includes('warp'))
    base.push({ v: 'warp', key: 'settings.terminalApp.warp' })
  return base
})
const currentTerminalLabel = computed(() => {
  const o = terminalOptions.value.find(o => o.v === terminalApp.value)
  return o ? t(o.key) : terminalApp.value
})

function pickLang(v: Lang) {
  setLang(v)
  langMenuOpen.value = false
}
function pickTheme(v: Theme) {
  setTheme(v)
  themeMenuOpen.value = false
}
function pickTerminal(v: TerminalApp) {
  setTerminalApp(v)
  terminalMenuOpen.value = false
}
function onDocClick(e: MouseEvent) {
  if (langMenuOpen.value && langWrapEl.value && !langWrapEl.value.contains(e.target as Node))
    langMenuOpen.value = false
  if (themeMenuOpen.value && themeWrapEl.value && !themeWrapEl.value.contains(e.target as Node))
    themeMenuOpen.value = false
  if (terminalMenuOpen.value && terminalWrapEl.value && !terminalWrapEl.value.contains(e.target as Node))
    terminalMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', onDocClick, true))
onUnmounted(() => document.removeEventListener('click', onDocClick, true))

onMounted(async () => {
  try {
    version.value = await api.appVersion()
  } catch {
    /* ignore */
  }
  if (isMacOS) {
    try {
      const detected = await api.detectTerminals()
      availableTerminals.value = detected
      applyTerminalDefault(detected)
    } catch {
      /* ignore */
    }
  }
  if (updateAvailable.value && latestVersion.value) {
    updateMsg.value = t('settings.updateAvailable', {
      v: latestVersion.value,
      cur: version.value,
    })
  }
})

const langOptions: { v: Lang; key: string }[] = [
  { v: 'en', key: 'settings.lang.en' },
  { v: 'zh', key: 'settings.lang.zh' },
  { v: 'zh-TW', key: 'settings.lang.zhTw' },
  { v: 'ja', key: 'settings.lang.ja' },
]
type ThemeOpt = { v: Theme; key: string }
const themeOptions: ThemeOpt[] = [
  { v: 'light', key: 'settings.theme.light' },
  { v: 'dark', key: 'settings.theme.dark' },
  { v: 'system', key: 'settings.theme.system' },
  { v: 'codex', key: 'settings.theme.codex' },
  { v: 'dracula', key: 'settings.theme.dracula' },
]

type FontScaleOpt = { v: FontScale; key: string }
const fontScaleOptions: FontScaleOpt[] = [
  { v: 'small', key: 'settings.fontSize.small' },
  { v: 'normal', key: 'settings.fontSize.normal' },
  { v: 'large', key: 'settings.fontSize.large' },
]

const currentLangLabel = computed(() => {
  const o = langOptions.find(o => o.v === lang.value)
  return o ? t(o.key) : lang.value
})
const currentThemeLabel = computed(() => {
  const o = themeOptions.find(o => o.v === theme.value)
  return o ? t(o.key) : theme.value
})

async function doCheck() {
  if (checking.value) return
  checking.value = true
  updateMsg.value = t('settings.checking')
  try {
    const r = await api.checkUpdate()
    updateMsg.value = r.hasUpdate
      ? t('settings.updateAvailable', { v: r.latest, cur: r.current })
      : t('settings.upToDate', { v: r.current })
    syncFromManualCheck(r)
  } catch (e) {
    updateMsg.value = t('settings.updateFail', { e: String(e) })
  } finally {
    checking.value = false
  }
}

async function installClaudeHooks() {
  if (installingClaudeHooks.value) return
  installingClaudeHooks.value = true
  claudeHooksMsg.value = t('settings.turnStatus.installing')
  try {
    const path = await api.installClaudeTurnHooks()
    claudeHooksMsg.value = t('settings.turnStatus.installed', { path })
  } catch (e) {
    claudeHooksMsg.value = t('settings.turnStatus.installFail', { e: String(e) })
  } finally {
    installingClaudeHooks.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal settings-modal">
      <div class="modal-head">
        <h3>{{ t('settings.title') }}</h3>
        <button
          class="modal-close"
          v-tooltip="t('common.close')"
          @click="emit('close')"
        >
          <IconClose />
        </button>
      </div>

      <div class="set-tabs segmented">
        <button
          :class="{ active: activeTab === 'general' }"
          @click="activeTab = 'general'"
        >
          {{ t('settings.tab.general') }}
        </button>
        <button
          :class="{ active: activeTab === 'advanced' }"
          @click="activeTab = 'advanced'"
        >
          {{ t('settings.tab.advanced') }}
        </button>
        <button
          :class="{ active: activeTab === 'shortcuts' }"
          @click="activeTab = 'shortcuts'"
        >
          {{ t('settings.tab.shortcuts') }}
        </button>
      </div>

      <div class="set-body">
        <template v-if="activeTab === 'general'">
          <!-- 语言 -->
          <section class="set-section">
            <header class="set-section-head">
              <IconLanguages />
              <span class="set-section-title">{{ t('settings.section.lang') }}</span>
              <div ref="langWrapEl" class="set-dropdown-wrap">
                <button
                  class="set-dropdown-btn"
                  :class="{ active: langMenuOpen }"
                  @click.stop="langMenuOpen = !langMenuOpen; themeMenuOpen = false"
                >
                  <span>{{ currentLangLabel }}</span>
                  <IconChevronDown class="set-dropdown-chev" />
                </button>
                <div v-if="langMenuOpen" class="set-dropdown-menu" role="menu">
                  <button
                    v-for="o in langOptions"
                    :key="o.v"
                    class="set-dropdown-item"
                    :class="{ active: lang === o.v }"
                    role="menuitem"
                    @click.stop="pickLang(o.v)"
                  >
                    <span class="set-dropdown-check"><IconCheck v-if="lang === o.v" /></span>
                    <span>{{ t(o.key) }}</span>
                  </button>
                </div>
              </div>
            </header>
          </section>

          <!-- 主题 -->
          <section class="set-section">
            <header class="set-section-head">
              <IconPalette />
              <span class="set-section-title">{{ t('settings.section.theme') }}</span>
              <div ref="themeWrapEl" class="set-dropdown-wrap">
                <button
                  class="set-dropdown-btn"
                  :class="{ active: themeMenuOpen }"
                  @click.stop="themeMenuOpen = !themeMenuOpen; langMenuOpen = false"
                >
                  <span class="theme-swatch theme-swatch-sm" :class="`theme-swatch-${theme}`">Aa</span>
                  <span>{{ currentThemeLabel }}</span>
                  <IconChevronDown class="set-dropdown-chev" />
                </button>
                <div v-if="themeMenuOpen" class="set-dropdown-menu" role="menu">
                  <button
                    v-for="o in themeOptions"
                    :key="o.v"
                    class="set-dropdown-item"
                    :class="{ active: theme === o.v }"
                    role="menuitem"
                    @click.stop="pickTheme(o.v)"
                  >
                    <span class="set-dropdown-check"><IconCheck v-if="theme === o.v" /></span>
                    <span class="theme-swatch theme-swatch-sm" :class="`theme-swatch-${o.v}`">Aa</span>
                    <span>{{ t(o.key) }}</span>
                  </button>
                </div>
              </div>
            </header>
          </section>

          <!-- 字体大小 -->
          <section class="set-section">
            <header class="set-section-head">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
              <span class="set-section-title">{{ t('settings.section.fontSize') }}</span>
              <div class="set-segment">
                <button
                  v-for="o in fontScaleOptions"
                  :key="o.v"
                  class="set-segment-btn"
                  :class="{ active: fontScale === o.v }"
                  @click="setFontScale(o.v)"
                >
                  <span class="set-segment-icon" :class="`set-segment-icon-${o.v}`">A</span>
                  {{ t(o.key) }}
                </button>
              </div>
            </header>
          </section>

          <!-- 数据 -->
          <section class="set-section">
            <header class="set-section-head">
              <IconDatabase />
              <span class="set-section-title">{{ t('settings.section.data') }}</span>
              <IconInfo class="set-hint-icon" v-tooltip="t('settings.clearCacheDesc')" />
              <span class="set-section-tail">{{ cacheLabel }}</span>
            </header>
            <button
              class="btn danger"
              :disabled="false"
              @click="emit('clearCache')"
            >
              {{ t('settings.clearCache') }}
            </button>
          </section>

          <!-- 关于 -->
          <section class="set-section">
            <header class="set-section-head">
              <IconInfo />
              <span class="set-section-title">{{ t('settings.section.about') }}</span>
              <span class="set-section-tail mono">v{{ version }}</span>
            </header>
            <p v-if="updateMsg" class="set-section-desc">{{ updateMsg }}</p>
            <div class="set-update-actions">
              <button class="btn" :disabled="checking" @click="doCheck">
                <IconRefresh v-if="!checking" />
                {{ checking ? t('settings.checking') : t('settings.checkUpdate') }}
              </button>
              <button
                v-if="updateAvailable"
                class="btn primary"
                @click="openReleasePage()"
              >
                <IconExternalLink />
                {{ t('settings.viewRelease', { v: latestVersion ?? '' }) }}
              </button>
            </div>
          </section>
        </template>

        <template v-else-if="activeTab === 'advanced'">
          <!-- 终端 -->
          <section class="set-section">
            <header class="set-section-head">
              <IconTerminal />
              <span class="set-section-title">{{ t('settings.section.terminal') }}</span>
            </header>
            <label class="set-toggle-row" @click.prevent="setUseExternalTerminal(!useExternalTerminal)">
              <span class="set-toggle-label">{{ t('settings.useExternalTerminal') }} <IconInfo class="set-hint-icon" v-tooltip="t('settings.terminalDesc')" /></span>
              <span class="set-toggle-track" :class="{ on: useExternalTerminal }">
                <span class="set-toggle-thumb" />
              </span>
            </label>

            <div v-if="useExternalTerminal && isMacOS && terminalOptions.length > 1" class="set-terminal-app-row">
              <span class="set-toggle-label">{{ t('settings.terminalApp.label') }}</span>
              <div ref="terminalWrapEl" class="set-dropdown-wrap">
                <button
                  class="set-dropdown-btn"
                  :class="{ active: terminalMenuOpen }"
                  @click.stop="terminalMenuOpen = !terminalMenuOpen; langMenuOpen = false; themeMenuOpen = false"
                >
                  <component :is="terminalIcons[terminalApp]" class="set-terminal-icon" />
                  <span>{{ currentTerminalLabel }}</span>
                  <IconChevronDown class="set-dropdown-chev" />
                </button>
                <div v-if="terminalMenuOpen" class="set-dropdown-menu" role="menu">
                  <button
                    v-for="o in terminalOptions"
                    :key="o.v"
                    class="set-dropdown-item"
                    :class="{ active: terminalApp === o.v }"
                    role="menuitem"
                    @click.stop="pickTerminal(o.v)"
                  >
                    <span class="set-dropdown-check"><IconCheck v-if="terminalApp === o.v" /></span>
                    <component :is="terminalIcons[o.v]" class="set-terminal-icon" />
                    <span>{{ t(o.key) }}</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="set-launch-args">
              <label class="set-launch-args-label">{{ t('settings.launchArgs') }} <IconInfo class="set-hint-icon" v-tooltip="t('settings.launchArgsDesc')" /></label>
              <div class="set-launch-args-row" v-for="a in (['claude', 'codex', 'gemini'] as const)" :key="a">
                <component :is="agentIcons[a]" class="set-launch-args-icon" />
                <input
                  class="set-launch-args-input"
                  :value="launchArgs[a]"
                  @input="setLaunchArgs(a, ($event.target as HTMLInputElement).value)"
                  :placeholder="{ claude: '--dangerously-skip-permissions', codex: '--yolo', gemini: '--yolo' }[a]"
                  spellcheck="false"
                />
                <button
                  v-if="!launchArgs[a]"
                  class="set-launch-args-fill"
                  v-tooltip="t('settings.launchArgsFill')"
                  @click="setLaunchArgs(a, { claude: '--dangerously-skip-permissions', codex: '--yolo', gemini: '--yolo' }[a])"
                >↵</button>
              </div>
            </div>
          </section>

          <!-- 状态跟踪 -->
          <section class="set-section">
            <header class="set-section-head">
              <span class="set-section-title">{{ t('settings.section.turnStatus') }}</span>
              <span class="set-section-subtitle">{{ t('settings.turnStatus.brief') }}</span>
              <IconInfo class="set-hint-icon" v-tooltip="t('settings.turnStatus.desc')" />
            </header>
            <div class="set-update-actions">
              <button
                class="btn"
                :disabled="installingClaudeHooks"
                @click="installClaudeHooks"
              >
                {{ installingClaudeHooks ? t('settings.turnStatus.installing') : t('settings.turnStatus.installClaude') }}
              </button>
            </div>
            <p v-if="claudeHooksMsg" class="set-section-desc set-toggle-hint">{{ claudeHooksMsg }}</p>
          </section>

          <!-- Codex -->
          <section class="set-section">
            <header class="set-section-head">
              <span class="set-section-title">Codex</span>
              <span class="set-section-subtitle">{{ t('settings.codex.brief') }}</span>
              <IconInfo class="set-hint-icon" v-tooltip="t('settings.codexVisibilityDesc')" />
            </header>
            <label class="set-toggle-row" @click.prevent="setCodexShowInternalSessions(!codexShowInternalSessions)">
              <span class="set-toggle-label">{{ t('settings.codex.showInternal') }}</span>
              <span class="set-toggle-track" :class="{ on: codexShowInternalSessions }">
                <span class="set-toggle-thumb" />
              </span>
            </label>
            <label class="set-toggle-row" @click.prevent="setCodexShowArchivedSessions(!codexShowArchivedSessions)">
              <span class="set-toggle-label">{{ t('settings.codex.showArchived') }}</span>
              <span class="set-toggle-track" :class="{ on: codexShowArchivedSessions }">
                <span class="set-toggle-thumb" />
              </span>
            </label>
          </section>
        </template>

        <template v-else>
          <div class="set-shortcuts">
            <div class="set-shortcut-row" v-for="s in shortcuts" :key="s.key">
              <span class="set-shortcut-label">{{ t(s.label) }}</span>
              <kbd class="set-shortcut-key">{{ s.key }}</kbd>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
