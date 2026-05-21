import { ref, watchEffect } from 'vue'

export type Lang = 'en' | 'zh' | 'zh-TW' | 'ja'
export type Theme = 'light' | 'dark' | 'system'

const LANG_KEY = 'lang'
const THEME_KEY = 'theme'
const PREFS_KEY = 'projPrefs:v1'

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
export const theme = ref<Theme>(
  (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system',
)

export function setLang(l: Lang) {
  lang.value = l
  localStorage.setItem(LANG_KEY, l)
}

export function setTheme(t: Theme) {
  theme.value = t
  localStorage.setItem(THEME_KEY, t)
}

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme() {
  const dark = theme.value === 'dark' || (theme.value === 'system' && systemDark())
  document.documentElement.classList.toggle('theme-dark', dark)
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
}
