# Session creation-time sort shortcut

## Context

The current sessions topbar already exposes a sort menu. Its `Newest first` and `Oldest first` choices sort by `SessionMeta.modified`, while the requested shortcut must sort by `SessionMeta.created`. The shortcut belongs in the project header action row shown in the supplied screenshot.

## Interaction design

- Add one icon-only button to the normal (non-selection) project header actions when the project has at least two sessions.
- Reuse the existing `IconSort` (`lucide/arrow-down-up`) already used by the trash view; do not add another icon asset or CSS treatment.
- The first click from any non-creation sort selects creation time, newest first. Subsequent clicks toggle between creation time newest first and oldest first.
- Mark the button active while either creation-time order is selected.
- Use the existing custom tooltip directive. The tooltip states the current creation-time order and the result of clicking, so the fixed bidirectional icon remains unambiguous.
- Keep a single shared sort state. Add both creation-time choices to the existing topbar sort menu so the shortcut and menu always describe and control the same order.

## Sorting behavior

- Extend `SessionSort` with two explicit creation-time values.
- Parse `SessionMeta.created` as an ISO timestamp. If it is absent or invalid, use `modified` as the fallback timestamp.
- Break equal creation timestamps by most recently modified first, preserving a deterministic and useful order.
- Preserve the existing pinned, normal, and sunk grouping; creation-time sorting only controls order inside each group.
- Treat creation-time ordering as a non-default filter state, so the existing full-list loading behavior applies instead of sorting only the currently paginated window.

## Scope

- Frontend state, sorting, project-header button, topbar menu options, tooltips, and all four locale files are in scope.
- Backend parsing, persisted preferences, card metadata display, and the existing update-time/size/message-count sorts are unchanged.

## Verification

- Unit-test newest and oldest creation-time order, invalid/missing creation-time fallback, tie-breaking, active-state detection, and reset behavior.
- Component-test button visibility, first-click behavior, toggle behavior, active state, and selection-mode exclusion.
- Update the topbar component test for the expanded sort menu and creation-time selection.
- Run the focused Vitest files, then the full frontend test suite and production build.
