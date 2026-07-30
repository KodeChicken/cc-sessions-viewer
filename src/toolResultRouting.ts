import type { Block } from './types'
import { looksLikeDiff } from './diffHighlight'

export const FILE_MUTATING_TOOL_NAMES = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'edit',
  'write',
  'fileChange',
  'file_change',
])

export function isFileMutatingToolName(name?: string): boolean {
  return !!name && FILE_MUTATING_TOOL_NAMES.has(name)
}

export function isFileChangeResult(b?: Block): boolean {
  if (!b || b.kind !== 'tool_result') return false
  if (isFileMutatingToolName(b.toolName)) return true
  if (b.filePath) return true
  if (b.diff && b.diff.length > 0) return true
  return looksLikeDiff(b.text ?? '')
}

export function shouldAttachToolResult(toolUse: Block, result?: Block): boolean {
  return isFileMutatingToolName(toolUse.toolName) || isFileChangeResult(result)
}

export function shouldPreferToolResult(next: Block, previous?: Block): boolean {
  if (!previous) return true
  if (next.isError && !previous.isError) return true
  if (!next.isError && previous.isError) return false
  const nextIsFileChange = isFileChangeResult(next)
  const previousIsFileChange = isFileChangeResult(previous)
  if (nextIsFileChange !== previousIsFileChange) return nextIsFileChange
  if ((next.diff?.length ?? 0) !== (previous.diff?.length ?? 0)) return (next.diff?.length ?? 0) > 0
  if (!!next.filePath !== !!previous.filePath) return !!next.filePath
  return true
}
