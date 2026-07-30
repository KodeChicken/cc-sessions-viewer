import { describe, expect, it } from 'vitest'
import type { Block } from '../src/types'
import { isFileChangeResult, shouldAttachToolResult, shouldPreferToolResult } from '../src/toolResultRouting'

function toolUse(name: string): Block {
  return { kind: 'tool_use', toolName: name, isError: false }
}

function toolResult(partial: Partial<Block>): Block {
  return { kind: 'tool_result', isError: false, ...partial }
}

describe('toolResultRouting', () => {
  it('treats structured file results as file changes', () => {
    expect(isFileChangeResult(toolResult({ filePath: 'README.md' }))).toBe(true)
    expect(
      isFileChangeResult(
        toolResult({
          diff: [
            {
              oldStart: 1,
              newStart: 1,
              lines: [{ kind: 'add', text: 'new', oldNo: null, newNo: 1 }],
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  it('keeps textual unified diffs visible outside collapsed tool calls', () => {
    const result = toolResult({
      text: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new',
    })

    expect(isFileChangeResult(result)).toBe(true)
    expect(shouldAttachToolResult(toolUse('shell'), result)).toBe(true)
  })

  it('does not attach ordinary shell output', () => {
    expect(shouldAttachToolResult(toolUse('shell'), toolResult({ text: 'ok' }))).toBe(false)
  })

  it('attaches explicit file mutation tools even without a structured diff', () => {
    expect(shouldAttachToolResult(toolUse('fileChange'), toolResult({ text: 'Updated README.md' }))).toBe(true)
    expect(shouldAttachToolResult(toolUse('Edit'), toolResult({ text: 'done' }))).toBe(true)
    expect(isFileChangeResult(toolResult({ toolName: 'edit', text: 'done' }))).toBe(true)
  })

  it('prefers structured file changes over ordinary tool output for the same tool id', () => {
    const ordinary = toolResult({ toolId: 'call-1', text: 'Success. Updated the following files:\nA hello.md' })
    const fileChange = toolResult({
      toolId: 'call-1',
      filePath: 'hello.md',
      diff: [
        {
          oldStart: 0,
          newStart: 1,
          lines: [{ kind: 'add', text: 'hello', oldNo: null, newNo: 1 }],
        },
      ],
    })

    expect(shouldPreferToolResult(fileChange, ordinary)).toBe(true)
    expect(shouldPreferToolResult(ordinary, fileChange)).toBe(false)
  })
})
