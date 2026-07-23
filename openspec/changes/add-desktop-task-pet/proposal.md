## Why

Users currently need to keep the main Session Viewer window visible to know whether agent tasks are running, waiting for approval, completed, or failed. A lightweight anime-style desktop pet can surface those states at a glance and provide a direct path back to the relevant session without turning status monitoring into another full application window.

## What Changes

- Add an optional transparent, frameless, always-on-top desktop pet window that can be dragged and kept visible independently of the main window.
- Keep the pet compact at rest, show persistent notices for completed, waiting-for-approval, and failed tasks, then reveal counts and full task details when the user hovers or focuses it.
- Animate the pet when a new completed Hook event arrives; let users click a task or persistent notice to navigate to that Session Viewer session.
- Add three original anime-style pet appearances and allow switching the active pet from Settings.
- Add a dedicated desktop-pet section in Settings, separate from Hooks. Its switch is disabled until all Session Viewer session-status Hooks are installed.
- Preserve the desktop pet preference and selected appearance across application restarts.
- Keep task state bounded to one latest record per session; a new started event replaces that session's previous completed, failed, or approval-waiting state.

## Capabilities

### New Capabilities

- `desktop-task-pet`: Desktop pet window lifecycle, latest-per-session task aggregation, status hover lists, session navigation, Hook-gated settings, and switchable pet appearances.

### Modified Capabilities

None. The repository has no existing OpenSpec capability specifications for this behavior.

## Impact

- Tauri window configuration and Rust application state for pet-window lifecycle and Hook-derived task snapshots.
- Turn Hook event handling and application events used to synchronize the main and pet windows.
- Main-window session navigation so an external pet-window action can focus a session by agent and session path.
- Settings persistence, Settings UI, localization, and frontend routing for a dedicated pet-window entry point.
- New project-owned transparent assets for three pet appearances plus component, state, Rust, and integration tests.
