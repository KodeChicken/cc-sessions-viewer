## Why

The current desktop-pet implementation grew around Session Viewer task counters, Hook prerequisites, custom notices, and bespoke animations. That is not the requested product. The desktop pet should instead match the locally installed Codex Desktop avatar overlay and its interaction model.

## What Changes

- Remove the existing task-count cards, bespoke notices, and custom character animations, while reusing the existing tab-status Hook pipeline for Codex-style pet activity states and navigation.
- Rebuild the pet as a transparent, frameless, always-on-top Codex-style avatar overlay with the same sprite-atlas playback, hover response, 16-direction pointer look, drag-running feedback, release-point positioning, sizing, and wake/tuck behavior.
- Discover the locally installed Codex pet assets at runtime without bundling them, and support Codex-compatible custom packages in `~/.codex/pets` through `pet.json`.
- Match the Codex Settings controls for enabling the overlay, selecting and refreshing pets, opening the custom-pet directory, and choosing the avatar size.
- Keep avatar availability independent of Session Viewer Hooks, while showing Hook-backed activity when status tracking is installed.

## Capabilities

### New Capabilities

- `desktop-task-pet`: A Codex-compatible desktop avatar overlay, sprite package catalog, animation state machine, pointer interaction, direct dragging, and Settings controls.

### Modified Capabilities

None.

## Impact

- Tauri desktop-pet window lifecycle, positioning, and asset catalog commands.
- The lightweight desktop-pet Vue root, atlas player, preferences, Settings UI, localization, and focused tests.
- Existing Hook-based tab status remains the single task-state source shared by tabs and the desktop pet.
