## 1. Remove the superseded pet implementation

- [x] 1.1 Remove pet-only Hook task aggregation, task navigation, counters, notices, and bespoke character UI while preserving the existing tab-status Hook pipeline
- [x] 1.2 Remove Hook-gated pet startup and Settings behavior and replace the old preference surface with avatar-only state

## 2. Match Codex assets and animation

- [x] 2.1 Implement Codex-compatible v1/v2 PNG/WebP package discovery and manifest defaults for installed and custom pets
- [x] 2.2 Implement the exact Codex atlas row timings, three-cycle transient playback, slow idle fallback, look-frame override, and reduced-motion behavior

## 3. Match Codex overlay interaction

- [x] 3.1 Rebuild the lightweight avatar overlay with hover jumping and 16-direction global pointer look
- [x] 3.2 Implement the four-pixel drag threshold, directional running feedback, and settled-position persistence
- [x] 3.3 Match the reference window dimensions, avatar size range, wake/tuck lifecycle, and live pet/size synchronization

## 4. Match Codex Settings and verify

- [x] 4.1 Add avatar selection, refresh, open-directory, size, and wake/tuck controls without Hook prerequisites
- [x] 4.2 Update focused Rust and frontend tests for the replacement behavior
- [x] 4.3 Run focused tests, frontend build, Rust checks, and verify the real Tauri development client
- [x] 4.4 Show a newly created pet window from the Rust lifecycle after positioning and verify it in the development client
- [x] 4.5 Grant the avatar window position permission and verify mouse dragging in the real Windows development client
- [x] 4.6 Remove post-release inertia and verify the avatar remains at the mouse release position

## 5. Add Codex-style task activity

- [x] 5.1 Add a central latest-per-session Hook activity snapshot and expose snapshot/acknowledgement commands
- [x] 5.2 Connect the current avatar animations and compact activity tray using Codex state priority and persistence rules
- [x] 5.3 Add exact cross-window navigation by agent and session path, acknowledging terminal activity only after a successful open
- [x] 5.4 Add focused Rust and frontend tests for snapshot, priority, persistence, tray interaction, and navigation
- [x] 5.5 Run focused tests, frontend build, Rust checks, and verify the real Tauri development client
