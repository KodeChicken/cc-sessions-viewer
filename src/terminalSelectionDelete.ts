import type { TerminalInputState } from './tabStatus'

type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
>

export interface TerminalSelectionRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

const CURSOR_LEFT = '\x1b[D'
const CURSOR_RIGHT = '\x1b[C'
const DELETE_FORWARD = '\x1b[3~'

export function shouldHandleTerminalSelectionDelete(
  event: TerminalKeyEvent,
  hasSelection: boolean,
  platform = navigator.platform,
): boolean {
  const isSelectionDeletionKey =
    event.key === 'Delete' || event.key === 'Backspace'

  return (
    /Win/i.test(platform) &&
    hasSelection &&
    event.type === 'keydown' &&
    isSelectionDeletionKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  )
}

function findSelectionStart(text: string[], selection: string[]): number | null {
  let found: number | null = null
  for (let start = 0; start <= text.length - selection.length; start += 1) {
    if (selection.every((value, offset) => text[start + offset] === value)) {
      if (found !== null) return null
      found = start
    }
  }
  return found
}

export function buildTerminalSelectionDeleteSequence(
  state: TerminalInputState,
  selectedText: string,
  position: TerminalSelectionRange | undefined,
  activeCursorRow: number,
): string | null {
  if (
    !state.reliable ||
    !selectedText ||
    /[\r\n]/.test(selectedText) ||
    !position ||
    position.start.y !== activeCursorRow ||
    position.end.y !== activeCursorRow
  ) {
    return null
  }

  const text = Array.from(state.text)
  const selection = Array.from(selectedText)
  const selectionStart = findSelectionStart(text, selection)
  if (selectionStart === null) return null

  const cursor = Math.min(state.cursor, text.length)
  const movement =
    selectionStart < cursor
      ? CURSOR_LEFT.repeat(cursor - selectionStart)
      : CURSOR_RIGHT.repeat(selectionStart - cursor)

  return movement + DELETE_FORWARD.repeat(selection.length)
}
