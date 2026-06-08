import { createHighlighter, type Highlighter } from 'shiki'

let highlighterPromise: Promise<Highlighter> | null = null

const BUNDLED_LANGS = [
  'javascript', 'typescript', 'jsx', 'tsx',
  'python', 'rust', 'go', 'java', 'c', 'cpp',
  'html', 'css', 'scss', 'vue', 'svelte',
  'json', 'yaml', 'toml', 'xml',
  'bash', 'shell', 'zsh', 'powershell',
  'sql', 'graphql',
  'markdown', 'diff',
  'ruby', 'php', 'swift', 'kotlin', 'dart',
  'dockerfile', 'lua', 'zig',
] as const

const THEMES = ['github-light', 'github-dark', 'dracula'] as const

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...THEMES],
      langs: [...BUNDLED_LANGS],
    })
  }
  return highlighterPromise
}

function currentTheme(): typeof THEMES[number] {
  const el = document.documentElement
  if (el.classList.contains('theme-dracula')) return 'dracula'
  if (el.classList.contains('theme-dark')) return 'github-dark'
  return 'github-light'
}

async function tryLoadLang(hl: Highlighter, lang: string): Promise<boolean> {
  if (hl.getLoadedLanguages().includes(lang as any)) return true
  try {
    await hl.loadLanguage(lang as any)
    return true
  } catch {
    return false
  }
}

function replaceWithShiki(
  pre: HTMLPreElement,
  html: string,
  lang: string,
  source: string,
  extraClass?: string,
): void {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = html
  const shikiPre = wrapper.querySelector('pre')
  if (!shikiPre) return
  shikiPre.className = (extraClass ? extraClass + ' ' : '') + 'shiki'
  shikiPre.dataset.shiki = 'done'
  shikiPre.dataset.lang = lang
  shikiPre.dataset.source = encodeURIComponent(source)
  pre.replaceWith(shikiPre)
}

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  jsx: 'jsx', tsx: 'tsx',
  vue: 'vue', svelte: 'svelte',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml', svg: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'zsh',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  dart: 'dart',
  lua: 'lua',
  zig: 'zig',
  md: 'markdown', mdx: 'markdown',
  graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile',
}

function langFromPath(filePath: string): string | null {
  const name = filePath.split('/').pop() || ''
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return EXT_TO_LANG[ext] || null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function applyTokensToSpans(
  textSpans: NodeListOf<HTMLSpanElement>,
  hl: Highlighter,
  lang: string,
  themeName: string,
): void {
  const lines = [...textSpans].map(s => s.textContent ?? '')
  const code = lines.join('\n')
  const result = hl.codeToTokens(code, { lang: lang as any, theme: themeName })
  for (let i = 0; i < textSpans.length && i < result.tokens.length; i++) {
    const tokens = result.tokens[i]
    let html = ''
    for (const t of tokens) {
      const style = t.color ? ` style="color:${t.color}"` : ''
      html += `<span${style}>${escapeHtml(t.content)}</span>`
    }
    textSpans[i].innerHTML = html
  }
}

const DIFF_TARGETS: { selector: string; textSelector: string; getFilePath: (el: HTMLElement) => string }[] = [
  {
    selector: '.diff:not([data-shiki])',
    textSelector: '.diff-text',
    getFilePath: (el) => el.dataset.file || '',
  },
  {
    selector: '.codex-patch-file:not([data-shiki])',
    textSelector: '.codex-patch-text',
    getFilePath: (el) => {
      const link = el.querySelector<HTMLAnchorElement>('.codex-patch-path')
      return link?.dataset.localTarget || link?.textContent || ''
    },
  },
]

async function highlightDiffBlocks(root: HTMLElement, hl: Highlighter, themeName: string): Promise<void> {
  for (const target of DIFF_TARGETS) {
    const diffs = root.querySelectorAll<HTMLElement>(target.selector)
    for (const diffEl of diffs) {
      const filePath = target.getFilePath(diffEl)
      const lang = langFromPath(filePath)
      if (!lang) { diffEl.dataset.shiki = 'skip'; continue }
      if (!(await tryLoadLang(hl, lang))) { diffEl.dataset.shiki = 'skip'; continue }

      const textSpans = diffEl.querySelectorAll<HTMLSpanElement>(target.textSelector)
      if (!textSpans.length) { diffEl.dataset.shiki = 'skip'; continue }

      applyTokensToSpans(textSpans, hl, lang, themeName)
      diffEl.dataset.shiki = 'done'
      diffEl.dataset.lang = lang
    }
  }
}

async function rehighlightDiffBlocks(root: HTMLElement, hl: Highlighter, themeName: string): Promise<void> {
  for (const target of DIFF_TARGETS) {
    const done = target.selector.replace(':not([data-shiki])', '[data-shiki="done"]')
    const diffs = root.querySelectorAll<HTMLElement>(done)
    for (const diffEl of diffs) {
      const lang = diffEl.dataset.lang || ''
      if (!lang) continue
      const textSpans = diffEl.querySelectorAll<HTMLSpanElement>(target.textSelector)
      if (!textSpans.length) continue
      applyTokensToSpans(textSpans, hl, lang, themeName)
    }
  }
}

export async function highlightAllCodeBlocks(root: HTMLElement | null): Promise<void> {
  if (!root) return

  const fenced = root.querySelectorAll<HTMLPreElement>('pre.code-block:not([data-shiki])')
  const toolJson = root.querySelectorAll<HTMLPreElement>('pre.lang-json:not([data-shiki])')
  const toolDiff = root.querySelectorAll<HTMLPreElement>('pre.lang-diff:not([data-shiki])')
  const diffBlocks = root.querySelectorAll<HTMLElement>('.diff:not([data-shiki]), .codex-patch-file:not([data-shiki])')

  if (!fenced.length && !toolJson.length && !toolDiff.length && !diffBlocks.length) return
  const hl = await getHighlighter()
  const themeName = currentTheme()

  for (const pre of fenced) {
    const lang = pre.dataset.lang || ''
    if (!lang) { pre.dataset.shiki = 'skip'; continue }
    const code = pre.querySelector('code')?.textContent ?? ''
    if (!code) { pre.dataset.shiki = 'skip'; continue }
    if (!(await tryLoadLang(hl, lang))) { pre.dataset.shiki = 'skip'; continue }
    const html = hl.codeToHtml(code, { lang, theme: themeName })
    replaceWithShiki(pre, html, lang, code, 'code-block')
  }

  for (const pre of toolJson) {
    const code = pre.textContent ?? ''
    if (!code.trim()) { pre.dataset.shiki = 'skip'; continue }
    const html = hl.codeToHtml(code, { lang: 'json', theme: themeName })
    replaceWithShiki(pre, html, 'json', code, 'lang-json')
  }

  for (const pre of toolDiff) {
    const code = pre.textContent ?? ''
    if (!code.trim()) { pre.dataset.shiki = 'skip'; continue }
    const html = hl.codeToHtml(code, { lang: 'diff', theme: themeName })
    replaceWithShiki(pre, html, 'diff', code, 'lang-diff')
  }

  if (diffBlocks.length) {
    await highlightDiffBlocks(root, hl, themeName)
  }
}

export async function rehighlightAllCodeBlocks(root: HTMLElement | null): Promise<void> {
  if (!root) return
  const blocks = root.querySelectorAll<HTMLPreElement>('pre[data-shiki="done"]')
  const diffBlocks = root.querySelectorAll<HTMLElement>('.diff[data-shiki="done"], .codex-patch-file[data-shiki="done"]')
  if (!blocks.length && !diffBlocks.length) return
  const hl = await getHighlighter()
  const themeName = currentTheme()

  for (const pre of blocks) {
    const lang = pre.dataset.lang || ''
    const code = decodeURIComponent(pre.dataset.source || '')
    if (!lang || !code) continue
    const origClass = pre.className.replace(/\bshiki\b/, '').trim()
    const html = hl.codeToHtml(code, { lang, theme: themeName })
    replaceWithShiki(pre, html, lang, code, origClass)
  }

  if (diffBlocks.length) {
    await rehighlightDiffBlocks(root, hl, themeName)
  }
}
