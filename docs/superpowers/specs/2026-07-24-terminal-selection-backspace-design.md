# Terminal Selection Backspace Design

## Context

The integrated Codex terminal currently deletes a selected portion of the active
input when the user presses the forward `Delete` key. Real-event diagnostics
showed that the reported failure used `Backspace`: xterm cleared the visual
selection and forwarded the key to Codex, which removed only one character.

## Desired Behavior

When a valid selection belongs to the active editable Codex input line:

- plain `Delete` deletes the whole selection;
- plain `Backspace` deletes the whole selection;
- either key keeps its normal single-character behavior when no selection exists;
- modified key combinations are not intercepted.

The existing safety rules remain unchanged: the tracked input must be reliable,
the selection must be single-line on the active cursor row, and its text must
identify one unambiguous range in the tracked input.

## Design

Extend the terminal-selection key predicate to accept either `Delete` or
`Backspace`. Both keys will use the existing selection deletion planner:

1. move the Codex cursor to the selected range start;
2. send one forward-delete sequence per selected code point;
3. clear the xterm selection.

Reusing one planner avoids separate Backspace cursor semantics and preserves the
already verified handling of ASCII and full-width Chinese input.

## Testing

Add regression coverage at two boundaries:

- the key predicate accepts plain `Backspace` with a selection and rejects it
  without a selection or with modifiers;
- the terminal handler consumes `Backspace`, clears the selection, and emits the
  same deletion sequence used for `Delete`.

Existing `Delete`, unsafe-selection, and normal no-selection tests must remain
green.

## Scope

This change affects only the integrated agent TUI selection behavior. It does
not change native textareas, shell tabs, terminal copy behavior, UI labels, or
settings.
