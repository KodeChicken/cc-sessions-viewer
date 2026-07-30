export type CodexPluginMentionIcon =
  | 'pdf'
  | 'template'
  | 'chrome'
  | 'computer'
  | 'visualize'

export interface CodexPluginMention {
  id: string
  name: string
  description: string
  insertText: string
  icon: CodexPluginMentionIcon
  uri: string
  promptLabel: string
}

export interface CodexPluginMentionRange {
  start: number
  end: number
  plugin: CodexPluginMention
}

export interface CodexPluginLink {
  name: string
  description: string
  icon: CodexPluginMentionIcon
}

export interface CodexPluginTextElement {
  type: 'mention'
  byteRange: {
    start: number
    end: number
  }
  path: string
  name: string
  placeholder?: string
}

export const CODEX_PLUGIN_MENTIONS: CodexPluginMention[] = [
  { id: 'PDF', name: 'PDF', description: 'Read, create, and verify PDF files', insertText: '@PDF ', icon: 'pdf', uri: 'plugin://pdf@openai-primary-runtime', promptLabel: 'pdf' },
  { id: 'Template Creator', name: 'Template Creator', description: 'Create reusable templates from reference content', insertText: '@Template Creator ', icon: 'template', uri: 'plugin://template-creator@openai-primary-runtime', promptLabel: 'template-creator' },
  { id: 'Chrome', name: 'Chrome', description: 'Control Chrome tabs and signed-in sessions', insertText: '@Chrome ', icon: 'chrome', uri: 'plugin://chrome@openai-bundled', promptLabel: 'Chrome' },
  { id: 'Computer', name: 'Computer', description: 'Control Mac apps from ChatGPT', insertText: '@Computer ', icon: 'computer', uri: 'plugin://computer-use@openai-bundled', promptLabel: 'Computer' },
  { id: 'Visualize', name: 'Visualize', description: 'Turn ideas and data into interactive visuals', insertText: '@Visualize ', icon: 'visualize', uri: 'plugin://visualize@openai-bundled', promptLabel: 'visualize' },
]

const SORTED_CODEX_PLUGIN_MENTIONS = [...CODEX_PLUGIN_MENTIONS]
  .sort((a, b) => b.name.length - a.name.length)

export function filterCodexPluginMentions(query: string): CodexPluginMention[] {
  const q = query.trim().toLowerCase()
  if (!q) return CODEX_PLUGIN_MENTIONS
  return CODEX_PLUGIN_MENTIONS.filter((item) => {
    const haystack = `${item.name} ${item.description}`.toLowerCase()
    return haystack.includes(q)
  })
}

export function codexPluginMentionRanges(text: string): CodexPluginMentionRange[] {
  const ranges: CodexPluginMentionRange[] = []
  const lower = text.toLowerCase()
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue
    const before = i > 0 ? text[i - 1] : ''
    if (before && !/\s/.test(before)) continue
    const match = SORTED_CODEX_PLUGIN_MENTIONS.find((plugin) => {
      const token = `@${plugin.name}`
      if (lower.slice(i, i + token.length) !== token.toLowerCase()) return false
      return isMentionBoundary(text[i + token.length] ?? '')
    })
    if (!match) continue
    const end = i + match.name.length + 1
    ranges.push({ start: i, end, plugin: match })
    i = end - 1
  }
  return ranges
}

export function highlightCodexPluginMentionHtmlText(html: string): string {
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => part.startsWith('<') ? part : highlightTextSegment(part))
    .join('')
}

export function renderCodexPluginMentionHtmlText(html: string): string {
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => part.startsWith('<') ? part : renderTextSegment(part))
    .join('')
}

export function expandCodexPluginMentionsForPrompt(text: string): string {
  const ranges = codexPluginMentionRanges(text)
  if (!ranges.length) return text
  let out = ''
  let last = 0
  for (const range of ranges) {
    if (isInsideMarkdownLinkLabel(text, range.start, range.end)) continue
    out += text.slice(last, range.start)
    out += `[@${range.plugin.promptLabel}](${range.plugin.uri})`
    last = range.end
  }
  out += text.slice(last)
  return out
}

export function codexPluginMentionTextElements(text: string, byteOffset = 0): CodexPluginTextElement[] {
  const ranges = codexPluginMentionRanges(text)
  if (!ranges.length) return []
  return ranges
    .filter((range) => !isInsideMarkdownLinkLabel(text, range.start, range.end))
    .map((range) => ({
      type: 'mention',
      byteRange: {
        start: byteOffset + utf8ByteLength(text.slice(0, range.start)),
        end: byteOffset + utf8ByteLength(text.slice(0, range.end)),
      },
      path: range.plugin.uri,
      name: range.plugin.name,
      placeholder: `@${range.plugin.name}`,
    }))
}

export function codexPluginLinkForUri(uri: string, label = ''): CodexPluginLink | null {
  const normalized = normalizeCodexPluginUri(uri)
  if (!normalized) return null
  const known = CODEX_PLUGIN_MENTIONS.find((plugin) => plugin.uri === normalized)
  if (known) {
    return { name: known.name, description: known.description, icon: known.icon }
  }
  const fallback = label.replace(/^@/, '').trim() || normalized.slice('plugin://'.length)
  return { name: fallback, description: normalized, icon: 'template' }
}

export function renderCodexPluginLinkHtml(label: string, uri: string, escape: (s: string) => string): string | null {
  const plugin = codexPluginLinkForUri(uri, label)
  if (!plugin) return null
  return (
    `<span class="codex-plugin-ref cmd-name" data-cmd-desc="${escapeAttr(plugin.description)}">` +
    `<span class="codex-plugin-ref-ic codex-plugin-ref-ic--${plugin.icon}" aria-hidden="true">${pluginIconSvg(plugin.icon)}</span>` +
    `<span class="codex-plugin-ref-name">${escape(plugin.name)}</span>` +
    `</span>`
  )
}

function highlightTextSegment(text: string): string {
  const ranges = codexPluginMentionRanges(text)
  if (!ranges.length) return text
  let out = ''
  let last = 0
  for (const range of ranges) {
    out += text.slice(last, range.start)
    out += `<span class="cmd-name codex-plugin-name" data-cmd-desc="${escapeAttr(range.plugin.description)}">${text.slice(range.start, range.end)}</span>`
    last = range.end
  }
  out += text.slice(last)
  return out
}

function renderTextSegment(text: string): string {
  const ranges = codexPluginMentionRanges(text)
  if (!ranges.length) return text
  let out = ''
  let last = 0
  for (const range of ranges) {
    out += text.slice(last, range.start)
    out += renderCodexPluginLinkHtml(`@${range.plugin.promptLabel}`, range.plugin.uri, escapeHtml) ?? text.slice(range.start, range.end)
    last = range.end
  }
  out += text.slice(last)
  return out
}

function isMentionBoundary(ch: string): boolean {
  return !ch || /[\s.,!?;:()[\]{}"'，。！？；：（）【】]/.test(ch)
}

function isInsideMarkdownLinkLabel(text: string, start: number, end: number): boolean {
  return text[start - 1] === '[' && text[end] === ']' && text[end + 1] === '('
}

function normalizeCodexPluginUri(raw: string): string | null {
  const fromUri = raw.match(/plugin:\/\/[A-Za-z0-9._-]+@openai-[A-Za-z0-9._-]+/)
  if (fromUri) return fromUri[0]
  const bare = raw.match(/^([A-Za-z0-9._-]+)@(openai-[A-Za-z0-9._-]+)\)?$/)
  return bare ? `plugin://${bare[1]}@${bare[2]}` : null
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

function pluginIconSvg(icon: CodexPluginMentionIcon): string {
  switch (icon) {
    case 'pdf':
      return '<svg viewBox="0 0 16 16" fill="none"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'
    case 'template':
      return '<svg viewBox="0 0 16 16" fill="none"><path d="m8 2 5 3v6l-5 3-5-3V5z"/><path d="M8 8 3.3 5.2M8 8l4.7-2.8M8 8v5.5"/></svg>'
    case 'chrome':
    case 'computer':
      return '<svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3" width="11" height="8" rx="1.2"/><path d="M6 13h4M8 11v2"/></svg>'
    case 'visualize':
      return '<svg viewBox="0 0 16 16" fill="none"><path d="M1.8 8s2.3-4 6.2-4 6.2 4 6.2 4-2.3 4-6.2 4-6.2-4-6.2-4Z"/><circle cx="8" cy="8" r="1.8"/></svg>'
    default:
      return '<svg viewBox="0 0 16 16" fill="none"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'
  }
}
