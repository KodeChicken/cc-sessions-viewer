## Context

The repository contains a Hook-based tab-status pipeline and a rebuilt Codex-style avatar overlay. The locally installed Codex Desktop application provides the requested interaction reference: a transparent avatar overlay rendered from a fixed 8-column sprite atlas, with authored state rows, global pointer look, hover jumping, drag-running feedback, persistent size and position, a custom-pet catalog, and cross-chat activity states. The release behavior intentionally stops at the pointer instead of coasting.

## Goals / Non-Goals

**Goals:**

- Match Codex Desktop's avatar overlay behavior and fixed sprite package contract.
- Remove all prior Session Viewer-specific pet UI and its Hook dependency.
- Keep Codex-owned artwork runtime-local and use the installed application as the source.
- Support Codex-compatible custom pets and the same essential Settings operations.
- Reuse the existing Hook status source to provide Codex-style Running, Needs input, Ready, and Blocked activity without restoring the legacy pet dashboard.

**Non-Goals:**

- Retaining legacy task counters, large task panels, bespoke notices, or custom SVG/CSS gestures.
- Changing the existing Hook-based tab status system.
- Supporting arbitrary sprite layouts or animation editors.
- Shipping Codex-owned artwork inside this repository or installer.

## Decisions

### Keep the rebuilt pet root and add only Codex activity interaction

`DesktopPet.vue` remains the lightweight avatar overlay. It consumes a shared Hook activity snapshot and realtime updates, exposes a compact Codex-style activity tray, and navigates by exact agent plus session path. It does not restore legacy counters, cards, or bespoke notices.

### Use one central activity state for tabs and the pet

The Rust turn pipeline keeps the latest state for each normalized agent and session path before broadcasting `terminal-turn://state`. Both the main tab UI and the separate pet webview consume this source. The pet requests a snapshot when it mounts so window creation after a Hook event does not lose activity.

Hook states map to Codex semantics as `started` to Running, `blocked` to Needs input, `completed` to Ready, and `failed` to Blocked. Aggregate priority is Needs input, Blocked, Ready, then Running. Ready and Blocked remain unread until their session opens successfully; Needs input remains until a later Hook state replaces it.

### Use the Codex fixed atlas contract

The atlas has eight columns of 192-by-208 cells. Version 1 packages contain nine rows (1536 by 1872); version 2 packages contain eleven rows (1536 by 2288) and add two rows containing 16 pointer-look frames. PNG and WebP files are accepted. `pet.json` supports optional `id`, `displayName`, and `description`, defaults `spriteVersionNumber` to 1, and defaults `spritesheetPath` to `spritesheet.webp`.

Animation rows and timings match Codex: idle, running-right, running-left, waving, jumping, failed, waiting, running, and review. Idle frames play at six times their authored durations. A non-idle animation plays three cycles and then falls back to slow idle. Reduced-motion mode renders a stable first frame.

### Match pointer, hover, and drag interaction

The avatar uses global cursor coordinates and 16 sectors of 22.5 degrees with a one-pixel center dead zone. Look frames apply only to idle, running, and waving states on version 2 sheets. Pointer enter plays jumping; pointer leave restores the base state.

A left-button gesture becomes a drag after four pixels. Horizontal deltas select the running-right or running-left row. Releasing the button places the window at the release point, persists that position, and performs no post-release movement.

### Keep window availability independent of Hooks

The window remains singleton, transparent, frameless, always on top, taskbar-hidden, and non-resizable. Its reference size is 356 by 320, with an avatar display size from 80 to 224 pixels and a default of 112 by 121. Enabled state, selected pet, avatar size, and last window position are restored without consulting Hook installation status. Without Hooks the avatar stays usable but has no external CLI activity to display.

### Use runtime-local Codex assets and compatible custom packages

The backend discovers valid pet atlases from the installed Codex Desktop application and exposes them in the same catalog as `~/.codex/pets/<folder>/pet.json`. Runtime imports are copied only into application data. Catalog refresh and open-directory actions do not modify custom packages.

## Risks / Trade-offs

- [Installed Codex packaging changes] -> Treat discovery as best-effort and keep custom packages usable independently.
- [Transparent-window pointer behavior differs by platform] -> Drive movement from global cursor position and Tauri window APIs, then verify the real Windows client without changing macOS-specific behavior.
- [High-frequency position updates are noisy] -> Update only during active drag and persist the release position.
- [Reduced motion is enabled] -> Show stable authored frames and disable decorative animation while keeping drag positioning functional.

## Migration Plan

1. Remove legacy pet task aggregation, UI, navigation, and Hook gating.
2. Replace catalog validation and atlas playback with the Codex package and timing contracts.
3. Add Codex pointer, hover, direct drag, size, and position behavior.
4. Replace Settings controls and verify focused tests, builds, and the real Tauri client.
5. Reuse the tab-status Hook pipeline for a shared activity snapshot, Codex priority, compact tray, and exact session navigation.

## Open Questions

None. The local Codex Desktop installation is the behavioral reference for this change.
