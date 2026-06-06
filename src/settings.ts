import { ref, watch, watchEffect } from 'vue'
import type { StatsRange, StatsScope } from './types'

export type Lang = 'en' | 'zh' | 'zh-TW' | 'ja'
export type Theme = 'light' | 'dark' | 'system' | 'codex' | 'dracula'

const LANG_KEY = 'lang'
const THEME_KEY = 'theme'
const PREFS_KEY = 'projPrefs:v1'
const STATS_SCOPE_KEY = 'statsScope:v1'
const STATS_RANGE_KEY = 'statsRange:v1'
const EXTERNAL_TERMINAL_KEY = 'useExternalTerminal:v1'
const TERMINAL_APP_KEY = 'terminalApp:v1'
const CODEX_SHOW_INTERNAL_KEY = 'codexShowInternalSessions:v1'
const CODEX_SHOW_ARCHIVED_KEY = 'codexShowArchivedSessions:v1'
const LAUNCH_ARGS_KEY = 'launchArgs:v1'

/**
 * 根据浏览器/系统语言探测默认语言。
 * 匹配优先级：zh-Hant / zh-TW / zh-HK → zh-TW；其他 zh-* → zh；ja* → ja；其余 → en。
 * 仅在用户未显式设置（localStorage 无值）时生效。
 */
function detectSystemLang(): Lang {
  const candidates = (navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language]) as string[]
  for (const raw of candidates) {
    if (!raw) continue
    const tag = raw.toLowerCase()
    if (tag.startsWith('zh')) {
      if (tag.includes('hant') || tag.includes('-tw') || tag.includes('-hk') || tag.includes('-mo')) {
        return 'zh-TW'
      }
      return 'zh'
    }
    if (tag.startsWith('ja')) return 'ja'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

export const lang = ref<Lang>(
  (localStorage.getItem(LANG_KEY) as Lang | null) ?? detectSystemLang(),
)
function readTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' || v === 'system' || v === 'codex' || v === 'dracula'
    ? v
    : 'system'
}
export const theme = ref<Theme>(readTheme())
export type TerminalApp = 'terminal' | 'iterm2' | 'ghostty' | 'cmux' | 'warp'

export const useExternalTerminal = ref(localStorage.getItem(EXTERNAL_TERMINAL_KEY) === '1')
export const terminalApp = ref<TerminalApp>(
  (localStorage.getItem(TERMINAL_APP_KEY) as TerminalApp | null) ?? 'terminal',
)
export const codexShowInternalSessions = ref(localStorage.getItem(CODEX_SHOW_INTERNAL_KEY) === '1')
export const codexShowArchivedSessions = ref(localStorage.getItem(CODEX_SHOW_ARCHIVED_KEY) !== '0')

export type LaunchArgs = { claude: string; codex: string; gemini: string }
function readLaunchArgs(): LaunchArgs {
  try {
    const v = localStorage.getItem(LAUNCH_ARGS_KEY)
    if (v) return { claude: '', codex: '', gemini: '', ...JSON.parse(v) }
  } catch { /* ignore */ }
  return { claude: '', codex: '', gemini: '' }
}
export const launchArgs = ref<LaunchArgs>(readLaunchArgs())

export function setLaunchArgs(agent: keyof LaunchArgs, args: string) {
  launchArgs.value = { ...launchArgs.value, [agent]: args }
  localStorage.setItem(LAUNCH_ARGS_KEY, JSON.stringify(launchArgs.value))
}

export function setLang(l: Lang) {
  lang.value = l
  localStorage.setItem(LANG_KEY, l)
}

export function setTheme(t: Theme) {
  theme.value = t
  localStorage.setItem(THEME_KEY, t)
}

export function setUseExternalTerminal(v: boolean) {
  useExternalTerminal.value = v
  localStorage.setItem(EXTERNAL_TERMINAL_KEY, v ? '1' : '0')
}

export function setTerminalApp(v: TerminalApp) {
  terminalApp.value = v
  localStorage.setItem(TERMINAL_APP_KEY, v)
}

/** 用户是否手动选过终端应用 */
export function hasTerminalAppPreference(): boolean {
  return localStorage.getItem(TERMINAL_APP_KEY) !== null
}

/** 首次启动时根据检测结果设默认值：有 cmux 就默认 cmux，否则 terminal */
export function applyTerminalDefault(available: string[]) {
  if (hasTerminalAppPreference()) return
  if (available.includes('cmux')) {
    terminalApp.value = 'cmux'
  }
}

export function setCodexShowInternalSessions(v: boolean) {
  codexShowInternalSessions.value = v
  localStorage.setItem(CODEX_SHOW_INTERNAL_KEY, v ? '1' : '0')
}

export function setCodexShowArchivedSessions(v: boolean) {
  codexShowArchivedSessions.value = v
  localStorage.setItem(CODEX_SHOW_ARCHIVED_KEY, v ? '1' : '0')
}

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme() {
  const dark = theme.value === 'dark' || theme.value === 'dracula' || (theme.value === 'system' && systemDark())
  document.documentElement.classList.toggle('theme-dark', dark)
  document.documentElement.classList.toggle('theme-codex', theme.value === 'codex')
  document.documentElement.classList.toggle('theme-dracula', theme.value === 'dracula')
}

// 主题变化或系统外观变化时自动应用
watchEffect(applyTheme)
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => {
    if (theme.value === 'system') applyTheme()
  })

/** 清除应用级缓存（目前只有项目置顶/沉底偏好；会话 rename 直接写 JSONL，不走 cache） */
export function clearAppCache() {
  localStorage.removeItem(PREFS_KEY)
  localStorage.removeItem(TERMINAL_APP_KEY)
  localStorage.removeItem(EXTERNAL_TERMINAL_KEY)
  localStorage.removeItem(LAUNCH_ARGS_KEY)
  terminalApp.value = 'terminal'
  useExternalTerminal.value = false
  launchArgs.value = { claude: '', codex: '', gemini: '' }
}

// ---------- Statistics 页的 scope / range 持久化 ----------
// 默认 all agents + 过去 6 个月；用户改完写回 localStorage，下次进入沿用上次选择。
// （之前默认是 "all"=全部时间，全盘扫成本巨大且基本没人关心 1 年前的；改成
// months6 后默认体验快得多，需要看更老的数据再手动切。）

function readStatsScope(): StatsScope {
  const v = localStorage.getItem(STATS_SCOPE_KEY)
  return v === 'claude' || v === 'codex' || v === 'gemini' || v === 'all' ? v : 'all'
}
function readStatsRange(): StatsRange {
  const v = localStorage.getItem(STATS_RANGE_KEY)
  // 老用户 localStorage 里可能还存着 'all'（已废弃）—— 这里静默回退到 months6，
  // 后端 parse_range 也已经不认 'all'。
  return v === 'today' || v === 'days7' || v === 'days30' || v === 'month' || v === 'months6'
    ? v
    : 'months6'
}

export const statsScope = ref<StatsScope>(readStatsScope())
export const statsRange = ref<StatsRange>(readStatsRange())

watch(statsScope, (v) => localStorage.setItem(STATS_SCOPE_KEY, v))
watch(statsRange, (v) => localStorage.setItem(STATS_RANGE_KEY, v))
