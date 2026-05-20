// 轻量文本格式化：把会话内容渲染成可读的 HTML（无第三方依赖）。
import { t } from './i18n'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function inline(text: string): string {
  let s = escapeHtml(text)
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
  s = s.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
  s = s.replace(/^#\s+(.+)$/gm, '<h3>$1</h3>')
  s = s.replace(/\n/g, '<br>')
  return s
}

// Claude Code / Codex inject slash-command markup into the user message as
// pseudo-XML: <command-name>/init</command-name>, <command-message>init</…>,
// <command-args>foo bar</…>. Rendering them literally is ugly.
//
// <command-message> is just the slash command name without the leading "/" —
// fully redundant with <command-name>. We drop it. <command-name> and
// <command-args> get re-emitted as inline <code> chips via a placeholder pass
// so the inner text still goes through escapeHtml safely.
const COMMAND_MESSAGE_RE = /\s*<command-message>[\s\S]*?<\/command-message>\s*/g
const COMMAND_TAG_RE = /<(command-(?:name|args))>([\s\S]*?)<\/\1>/g
function extractCommandTags(raw: string): { text: string; codes: string[] } {
  const codes: string[] = []
  const stripped = raw.replace(COMMAND_MESSAGE_RE, '')
  const text = stripped.replace(COMMAND_TAG_RE, (_m, _tag, inner) => {
    const idx = codes.push(inner) - 1
    return `CMD${idx}`
  })
  return { text, codes }
}

/** 渲染 Markdown 子集：围栏代码块 + 行内强调。 */
export function renderText(raw: string): string {
  const { text: pre, codes } = extractCommandTags(raw)
  const parts = pre.split('```')
  let html = ''
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n')
      const code = nl >= 0 ? part.slice(nl + 1) : part
      html += `<pre class="code-block"><code>${escapeHtml(
        code.replace(/\n$/, ''),
      )}</code></pre>`
    } else if (part) {
      html += `<div class="text-run">${inline(part)}</div>`
    }
  })
  if (codes.length) {
    html = html.replace(
      /CMD(\d+)/g,
      (_m, n) => `<code class="cmd-tag">${escapeHtml(codes[Number(n)])}</code>`,
    )
  }
  return html
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** 把毫秒时间戳或 ISO 字符串格式化为本地时间。 */
export function formatTime(input: number | string | undefined): string {
  if (input === undefined || input === '') return '—'
  const d = new Date(input)
  if (isNaN(d.getTime())) return '—'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  // 也判断"昨天"，让相对日期更有用
  const ms = 24 * 60 * 60 * 1000
  const yesterday = new Date(now.getTime() - ms)
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay) return `${t('time.today')} ${hm}`
  if (isYesterday) return `${t('time.yesterday')} ${hm}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** 从完整路径取最后一段，作为项目短名。 */
export function shortName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}
