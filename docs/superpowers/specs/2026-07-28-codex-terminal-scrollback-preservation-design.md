# Preserve Codex Terminal Scrollback

## Problem

The embedded Codex TUI can unexpectedly show the beginning of a conversation while
the user is working at the bottom. The application does not call
`Terminal.scrollToTop()`. Its only explicit terminal viewport navigation is the
search result navigation in `tuiToolbar.ts`.

Runtime diagnostics established the destructive path:

1. Codex writes `CSI 3 J` (`Erase in Display`, parameter 3) to the PTY.
2. xterm handles parameter 3 by trimming all scrollback outside the viewport.
3. xterm reduces `baseY` and `viewportY` to zero or one.
4. Codex redraws the transcript, producing the visible jump/rebuild.

A resize reliably triggers this path, but it is not the only trigger. The
diagnostic log recorded another `CSI 3 J` at `2026-07-27T10:28:02Z`
(`2026-07-27 18:28:02` Asia/Shanghai) without a new resize after the preceding
clear. Therefore the fix must not depend on a resize timer.

The event reported in the installed 0.3.4 application on 2026-07-28 at about
14:02 Asia/Shanghai was not instrumented. It is treated as the same symptom, not
claimed as the exact diagnostic event above.

## Scope

Preserve scrollback for embedded Codex conversation TUI tabs when Codex emits
`CSI 3 J`.

The change must not affect:

- normal screen erases such as `CSI 0 J`, `CSI 1 J`, or `CSI 2 J`;
- terminal search navigation;
- user scrolling with the mouse, scrollbar, PageUp, or PageDown;
- embedded shell tabs;
- Claude, agy, or OpenCode terminal tabs.

No general-purpose "always follow the bottom" behavior will be added. Users must
remain free to inspect older output without the application pulling them back.

## Design

Add a small pure predicate that decides whether an erase-in-display sequence
should be consumed:

- the tab is a non-shell Codex TUI tab; and
- the CSI final byte is `J`; and
- the first numeric parameter is `3`.

When constructing an embedded terminal, register a public xterm CSI parser
handler for `J`. If the predicate matches, return `true` so xterm considers the
sequence handled and does not execute its default scrollback-trimming behavior.
For every other sequence, return `false` so xterm continues to its built-in
handler.

This parser-level interception is deterministic and handles split PTY byte
chunks correctly because xterm performs the ANSI parsing. It avoids timing
windows and does not rewrite ordinary terminal output.

## Lifecycle and Error Handling

The parser handler belongs to the terminal instance. Closing the tab disposes the
terminal and its parser state through the existing `closeTab` lifecycle. The
handler performs no asynchronous work and has no failure path.

Temporary runtime diagnostics used to establish the cause will be removed before
the implementation is committed.

## Tests

Add regression coverage for:

1. `CSI 3 J` is consumed for a non-shell Codex TUI tab.
2. `CSI 0/1/2 J` continues to xterm's default handler.
3. `CSI 3 J` continues normally for shell and non-Codex tabs.
4. A terminal with populated scrollback retains its history and viewport state
   after the intercepted Codex sequence.
5. Existing terminal selection deletion and input behavior remains passing.

Run the focused terminal tests first, followed by the complete frontend test
suite, production build, and `git diff --check`.

## Success Criteria

- Codex redraws no longer delete embedded terminal scrollback.
- Resizing the window reproducer no longer resets `baseY` or `viewportY`.
- Ordinary Codex screen redraw remains visually correct.
- User-directed terminal navigation remains unchanged.
