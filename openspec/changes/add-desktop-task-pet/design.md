## Context

Session state already enters the application through Claude Code, Codex, and Antigravity Hook adapters. Rust validates those signals and emits `terminal-turn://state`, while the main Vue window consumes the event for tab status. Users currently have to keep that main window visible.

This change crosses the Hook signal pipeline, Tauri window lifecycle, Vue settings, and session navigation. It must preserve the existing Hook-based status behavior and the user's unrelated worktree changes. The desktop pet is optional and is available only when all session-status Hooks are installed.

## Goals / Non-Goals

**Goals:**

- Maintain one current task state per agent session from validated Hook signals.
- Present those states in a small draggable, transparent, always-on-top pet window.
- Keep the idle presentation to the character alone, reveal progress details on hover or focus, and navigate directly to a session.
- Briefly animate the character when a new completed Hook event arrives.
- Persist the enabled preference and one of three selectable original pet appearances.
- Keep the feature unavailable when session-status Hooks are incomplete.

**Non-Goals:**

- Persisting or reporting task history across application restarts.
- Replacing the main Session Viewer, terminal tabs, or existing Hook installer.
- Adding another file watcher or restoring JSONL session parsing.
- Supporting arbitrary user-supplied pet packages or animations.

## Decisions

### Keep the latest state in a Rust process-level repository

After `emit_turn_signal` validates a Hook payload, Rust stores a compact task snapshot in a mutex-protected map keyed by normalized `agent + session path`, then broadcasts the existing event. A new `started` signal overwrites any previous completed, failed, or blocked state for that session. Completed, failed, and blocked states remain visible for the rest of the application run until another signal for that session arrives.

This makes the Rust Hook intake the single source of truth shared by both windows and avoids duplicate aggregation logic. Disk persistence was considered but rejected because it would turn a current-state widget into an unbounded or stale history view.

### Create and destroy a dedicated Tauri window from Rust

The backend exposes a command that creates a single `desktop-pet` window on enable and closes it on disable. The window loads `index.html?desktop-pet=1`, is transparent, frameless, always on top, skipped from the taskbar, non-resizable, and initially placed near the bottom-right of the primary monitor. Repeated enable calls reuse and focus the existing window.

Rust-owned lifecycle avoids requiring broad window-creation permissions in the webview. A statically configured always-created window was rejected because disabled users would still pay its startup cost and could see a flash.

### Use a separate lightweight Vue root

`src/main.ts` chooses `DesktopPet.vue` when the pet query parameter is present and otherwise loads the existing application. The pet root fetches the current snapshot once and then listens to the existing turn-state event for refreshes. At rest it renders only the character. Hover or keyboard focus reveals one compact progress panel containing the four counts and current task list.

The initial snapshot never triggers a completion animation. Terminal-state notices are derived from the current snapshot, so completed, approval-waiting, and failed notices remain visible across frontend refreshes for the lifetime of the Rust process. Only a new real-time `completed` event starts the short character celebration.

Running tasks alternate the character's hands over an enlarged laptop while two low-opacity, blurred SVG trapezoids spread outward from the screen toward the lower face; the laptop shell itself has no neon outline and no circular face overlay. Approval-waiting tasks raise one hand, failed tasks animate the head, ears, and laptop screen, and new completions raise both hands while swapping to a happy mouth. These part animations can coexist for different current states, except the short completion celebration temporarily owns both hands and the expression.

Compact notices use the latest task in each terminal state and sit beside the character while the full task panel is closed. The full panel temporarily replaces those notices on hover or focus, avoiding overlap inside the fixed pet window without discarding notice state.

Loading the full main application in the pet window was rejected because it would duplicate session loading, settings initialization, and listeners.

### Persist only user preferences in frontend storage

The enabled flag and selected character are stored with versioned local-storage keys alongside existing frontend preferences. On main-window startup, the application first resolves Hook installation status and then asks Rust to show the pet only when both the preference and complete Hook installation are true. If Hooks later become incomplete, the feature is disabled and the stored enabled flag is cleared.

No new persistence dependency is required. Character changes are broadcast to an already-open pet window so selection updates immediately.

Desktop-pet controls live in their own Settings navigation section. The Hooks section remains responsible only for Hook installation status and Hook configuration files; the pet section reads that status solely as an enablement prerequisite.

### Navigate through an explicit main-window event

Clicking a task calls a Rust command that shows and focuses the main window and emits `desktop-pet://open-session` only to `main`. The main app handles the event by first activating or restoring an existing terminal tab for the same agent/path, then falling back to an existing Session Viewer tab, and only creating a new Session Viewer tab when neither exists. Task labels use the agent's normal human-readable session-title parser rather than the transcript filename.

After completed-task navigation succeeds, the pet records the exact `agent + path + updatedAt` event as dismissed and filters it from later snapshots. Including the update timestamp allows a later completion from the same session to appear normally.

This preserves the main window as the owner of navigation state. Directly manipulating main-window frontend state from the pet webview was rejected because Vue state is isolated per webview.

### Use three project-owned transparent vector characters

The project ships three original compact SVG character cutouts: a peach fox, a star cat, and a cloud dragon. Each SVG exposes only the existing movable character parts (head, ears, eyes, tail, paws, or wings) for CSS animation. Hover and completion responses animate those parts while the outer character stage stays fixed, avoiding sticker-like whole-image motion. SVG keeps the silhouette crisp at desktop-widget size, avoids background-removal artifacts, and embeds no text.

## Risks / Trade-offs

- [Hook events can arrive concurrently] → Serialize map updates behind a mutex and expose cloned snapshots only.
- [A stale enabled preference can survive Hook removal] → Recheck Hook completeness on startup and after Hook settings refresh; close and disable the pet when incomplete.
- [Transparent windows differ by platform/compositor] → Keep the window rectangular for interaction, disable shadow/decorations, and validate in the real Windows Tauri client.
- [Hover panels can extend outside the small window] → Reserve panel space inside the fixed pet window instead of spawning another window.
- [Completed and failed counts can grow during a long run] → Bound storage to one record per session; a new start replaces the prior terminal state.
- [Dragging can conflict with progress interaction] → Keep drag initiation on character pointer-down while using ordinary hover events for the character response and progress panel; keep panel/list items interactive.

## Migration Plan

1. Add the in-memory task repository and commands without changing the existing Hook event contract.
2. Add the pet webview entry, settings controls, preferences, and assets behind the disabled-by-default preference.
3. Add main-window event navigation and Hook-gated startup synchronization.
4. Validate Rust tests, frontend tests/build, and the real Tauri client.

Rollback removes the pet window commands, Vue root, settings controls, and assets. The existing Hook signal event remains unchanged, so rollback does not require data migration.

## Open Questions

None. The state lifetime, Hook prerequisite, character set, and navigation behavior have been confirmed for this iteration.
