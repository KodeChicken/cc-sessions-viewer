import { describe, expect, it } from 'vitest'
import {
  buildTerminalSelectionDeleteSequence,
  shouldHandleTerminalSelectionDelete,
} from '../src/terminalSelectionDelete'

const state = (
  text: string,
  cursor = Array.from(text).length,
  reliable = true,
) => ({ text, cursor, reliable })

const range = (startY = 10, endY = 10) => ({
  start: { x: 2, y: startY },
  end: { x: 5, y: endY },
})

const key = (over: Partial<KeyboardEvent> = {}) =>
  ({
    type: 'keydown',
    key: 'Delete',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  }) as KeyboardEvent

describe('shouldHandleTerminalSelectionDelete', () => {
  it('accepts only plain Windows selection deletion keys with a selection', () => {
    expect(shouldHandleTerminalSelectionDelete(key(), true, 'Win32')).toBe(true)
    expect(shouldHandleTerminalSelectionDelete(key(), false, 'Win32')).toBe(false)
    expect(shouldHandleTerminalSelectionDelete(key(), true, 'MacIntel')).toBe(false)
    expect(
      shouldHandleTerminalSelectionDelete(key({ ctrlKey: true }), true, 'Win32'),
    ).toBe(false)
    expect(
      shouldHandleTerminalSelectionDelete(
        key({ key: 'Backspace' }),
        true,
        'Win32',
      ),
    ).toBe(true)
    expect(
      shouldHandleTerminalSelectionDelete(
        key({ key: 'Backspace', ctrlKey: true }),
        true,
        'Win32',
      ),
    ).toBe(false)
    expect(
      shouldHandleTerminalSelectionDelete(
        key({ key: 'Backspace' }),
        false,
        'Win32',
      ),
    ).toBe(false)
  })
})

describe('buildTerminalSelectionDeleteSequence', () => {
  it('moves left and deletes a unique middle selection', () => {
    expect(
      buildTerminalSelectionDeleteSequence(
        state('353545353434535453543534', 24),
        '343453',
        range(),
        10,
      ),
    ).toBe('\x1b[D'.repeat(16) + '\x1b[3~'.repeat(6))
  })

  it('moves right when the selection starts after the logical cursor', () => {
    expect(
      buildTerminalSelectionDeleteSequence(
        state('abcdef', 1),
        'de',
        range(),
        10,
      ),
    ).toBe('\x1b[C'.repeat(2) + '\x1b[3~'.repeat(2))
  })

  it('counts Chinese text by code point', () => {
    expect(
      buildTerminalSelectionDeleteSequence(
        state('甲乙丙丁', 4),
        '乙丙',
        range(),
        10,
      ),
    ).toBe('\x1b[D'.repeat(3) + '\x1b[3~'.repeat(2))
  })

  it.each([
    ['unreliable state', state('abcdef', 6, false), 'bc', range(), 10],
    ['empty selection', state('abcdef'), '', range(), 10],
    ['multiline selection', state('abcdef'), 'b\nc', range(), 10],
    ['repeated selection', state('abcabc'), 'abc', range(), 10],
    ['history row', state('abcdef'), 'bc', range(8, 8), 10],
    ['wrapped rows', state('abcdef'), 'bc', range(10, 11), 10],
  ])('rejects %s', (_name, input, selection, position, cursorRow) => {
    expect(
      buildTerminalSelectionDeleteSequence(
        input as ReturnType<typeof state>,
        selection as string,
        position,
        cursorRow as number,
      ),
    ).toBeNull()
  })
})
