export type ToolSummaryKind =
  | 'search'
  | 'read'
  | 'git'
  | 'buildFrontend'
  | 'test'
  | 'checkRust'
  | 'editFile'
  | 'callTool'
  | 'runCommand'

export interface ToolSummary {
  kind: ToolSummaryKind
  target?: string
}

const MAX_TARGET_LENGTH = 56
const SHELL_TOOLS = new Set(['bash', 'shell', 'command', 'commandexecution', 'exec'])
const SEARCH_TOOLS = new Set(['glob', 'grep', 'rg', 'search', 'file_search'])
const READ_TOOLS = new Set(['read', 'read_file', 'cat', 'sed'])
const EDIT_TOOLS = new Set(['edit', 'write', 'write_file', 'multiedit', 'apply_patch', 'filechange', 'file_change'])

function shortTarget(value: string): string | undefined {
  const normalized = value
    .replace(/^['"]|['"]$/g, '')
    .replace(/^file:\/\//, '')
    .trim()
  if (!normalized || normalized.startsWith('-')) return undefined
  if (normalized.length <= MAX_TARGET_LENGTH) return normalized
  return `…${normalized.slice(-(MAX_TARGET_LENGTH - 1))}`
}

function parseInput(input: string | undefined): Record<string, unknown> | null {
  if (!input?.trim()) return null
  try {
    const parsed: unknown = JSON.parse(input)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function inputTarget(input: string | undefined, keys: string[]): string | undefined {
  const parsed = parseInput(input)
  if (!parsed) return undefined
  for (const key of keys) {
    const value = shortTarget(valueAsString(parsed[key]) ?? '')
    if (value) return value
  }
  return undefined
}

function commandFromInput(input: string | undefined): string {
  const parsed = parseInput(input)
  return valueAsString(parsed?.command)
    ?? valueAsString(parsed?.cmd)
    ?? valueAsString(parsed?.script)
    ?? input?.trim()
    ?? ''
}

function commandTokens(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g) ?? []
}

function commandTarget(command: string, kind: ToolSummaryKind): string | undefined {
  const tokens = commandTokens(command)
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
    .filter((token) => token && !token.startsWith('-'))
  const pathLike = tokens.filter((token) =>
    token.includes('/')
    || token.includes('\\')
    || /\.(?:[cm]?[jt]sx?|vue|rs|json|md|css|html|toml|yaml|yml)$/i.test(token),
  )
  if (pathLike.length) return shortTarget(pathLike[pathLike.length - 1])
  if (kind === 'search') {
    const commandName = tokens.findIndex((token) => /^(rg|grep|find|fd|ag)$/i.test(token))
    const pattern = commandName >= 0 ? tokens[commandName + 1] : undefined
    return shortTarget(pattern ?? '')
  }
  return undefined
}

function shellSummary(command: string): ToolSummary {
  const lower = command.toLowerCase()
  let kind: ToolSummaryKind = 'runCommand'

  if (/\b(?:rg|grep|find|fd|ag)\b/.test(lower)) {
    kind = 'search'
  } else if (/\b(?:cat|sed|head|tail|less|more)\b/.test(lower)) {
    kind = 'read'
  } else if (/\bgit\s+(?:status|diff|log|show|branch|grep)\b/.test(lower)) {
    kind = 'git'
  } else if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)\b/.test(lower)
    || /\bvite\s+build\b/.test(lower)
    || /\btsc(?:\s|$)/.test(lower)
  ) {
    kind = 'buildFrontend'
  } else if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest)\b/.test(lower)
    || /\b(?:vitest|jest|pytest)\b/.test(lower)
    || /\bcargo\s+test\b/.test(lower)
  ) {
    kind = 'test'
  } else if (/\bcargo\s+(?:build|check|clippy|fmt)\b/.test(lower)) {
    kind = 'checkRust'
  } else if (/\b(?:apply_patch|patch)\b/.test(lower)) {
    kind = 'editFile'
  }

  return { kind, target: commandTarget(command, kind) }
}

function toolNameKey(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

export function summarizeTool(
  toolName = '',
  toolInput?: string,
  filePath?: string,
): ToolSummary {
  const name = toolName.trim() || 'Tool'
  const key = toolNameKey(name)
  const target = shortTarget(filePath ?? '')

  if (target || EDIT_TOOLS.has(key)) {
    return { kind: 'editFile', target: target ?? inputTarget(toolInput, ['filePath', 'file_path', 'path', 'filename']) }
  }
  if (SHELL_TOOLS.has(key)) return shellSummary(commandFromInput(toolInput))
  if (SEARCH_TOOLS.has(key)) {
    return { kind: 'search', target: inputTarget(toolInput, ['path', 'pattern', 'query', 'file']) }
  }
  if (READ_TOOLS.has(key)) {
    return { kind: 'read', target: inputTarget(toolInput, ['file_path', 'filePath', 'path', 'file']) }
  }
  if (/^(?:git|git_)/.test(key)) return { kind: 'git', target }

  return { kind: 'callTool', target: shortTarget(name) }
}
