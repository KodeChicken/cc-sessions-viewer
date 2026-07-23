# Integrated TUI Selection Delete Design

## Goal

Make the Windows integrated agent terminal behave like a normal editor for the
specific case shown by the user:

1. Type a single-line prompt in the Codex/Claude TUI.
2. Drag across part of that current, unsubmitted prompt.
3. Press plain `Delete` once.
4. Remove the selected text and leave the input cursor at the selection start.

The native GUI `ChatComposer` is out of scope because its `<textarea>` already
supports native selection deletion.

## Current Behavior

xterm's mouse highlight is a terminal-buffer selection used for copying. It
does not move or select text in the child TUI's editor. Consequently, pressing
`Delete` sends one delete key to the PTY and removes only one character at the
TUI cursor.

`src/terminals.ts` currently inspects xterm selections only for Windows
`Ctrl+C`. It also records `currentInputLine`, but the tracker only models
append, backspace, clear-line, and submit. It does not retain the logical input
cursor, so it cannot safely translate a highlighted substring into TUI editing
keystrokes.

## Selected Approach

Implement a conservative translation layer for plain `Delete` in agent TUI
tabs only.

The feature will:

- track the current unsubmitted single-line input text and logical cursor;
- verify that the xterm selection is on the active input row;
- require the selected text to map to exactly one substring of the tracked
  input;
- synthesize left/right cursor movement followed by repeated terminal Delete
  sequences;
- route the synthesized sequence through `term.input(...)`, so the existing
  xterm-to-PTY path and local input tracker observe the same bytes;
- clear the xterm selection only after a valid delete plan is accepted.

If any check fails, the handler consumes the Delete key without modifying the
TUI input. This prevents a history-output selection from unexpectedly deleting
an unrelated character at the live cursor.

## Input State Model

Replace the string-only input tracker with a small value object:

```ts
interface TerminalInputState {
  text: string
  cursor: number
  reliable: boolean
}
```

The pure state reducer will support:

- printable insertion at the current cursor;
- Backspace and Delete;
- left/right, Home, and End;
- clear-line;
- bracketed paste markers;
- submit/reset.

Control sequences that can change the editable line but cannot be interpreted
reliably, such as history navigation, mark the state unreliable. Submission
resets it to a reliable empty state. Selection deletion is disabled while the
state is unreliable.

Cursor and deletion counts use Unicode code points rather than UTF-16 code
units, which covers ordinary Chinese text without double-counting each
character.

## Delete Planning

A pure helper receives:

- the tracked input state;
- `term.getSelection()`;
- `term.getSelectionPosition()`;
- the active terminal cursor row.

It returns either a terminal input sequence or `null`.

A plan is valid only when:

- the event is a plain Windows `Delete` keydown;
- the PTY is alive;
- the tracked state is reliable and non-empty;
- the selection is non-empty and contains no logical newline;
- the selection starts and ends on the active terminal cursor row;
- the selected text occurs exactly once in the tracked input.

For a unique selection starting at `selectionStart`:

1. Move from the tracked logical cursor to `selectionStart`.
2. Send one terminal Delete sequence per selected code point.
3. Let the normal xterm `onData` path update the state and write to the PTY.

The resulting logical cursor is the original selection start, matching native
editor behavior.

## Scope and Safety Boundaries

Supported:

- Windows integrated Codex/Claude TUI tabs;
- plain `Delete`;
- a unique selection within the current unsubmitted single-line prompt;
- ordinary ASCII and Chinese text.

Not supported in this change:

- shell tabs;
- native GUI chat input;
- selections in historical terminal output;
- selections spanning terminal rows, including visually wrapped input;
- multiline prompts;
- ambiguous repeated selected text;
- modified Delete shortcuts.

Unsupported selections are a safe no-op and remain highlighted.

## Tests

Add regression coverage before implementation:

- input-state reducer tracks cursor movement, insertion, Backspace, and Delete;
- unknown/history control sequences invalidate the state;
- submit resets reliability;
- a unique middle selection produces the expected movement/delete sequence;
- selection before or after the logical cursor produces the correct direction;
- empty, multiline, repeated, historical-row, wrapped-row, or unreliable
  selections return no plan;
- plain Delete with no selection retains the existing one-character behavior;
- `Ctrl+C` selection copy remains unchanged.

Verification:

- focused Vitest files for terminal input state and terminal key handling;
- full Vitest suite;
- production frontend build;
- manual Tauri check using the user's numeric selection scenario.

