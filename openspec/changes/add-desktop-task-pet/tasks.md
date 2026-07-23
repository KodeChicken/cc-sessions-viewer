## 1. Hook task state and Tauri window

- [x] 1.1 Add the latest-per-session Hook task repository, snapshot command, and Rust unit tests
- [x] 1.2 Add idempotent desktop-pet window lifecycle commands and focused main-window navigation events

## 2. Pet preferences and presentation

- [x] 2.1 Add versioned desktop-pet preference helpers and frontend unit tests
- [x] 2.2 Create and visually validate three original transparent pet character assets
- [x] 2.3 Add the lightweight desktop-pet Vue entry and component with draggable chrome, four status counts, hover task lists, and live updates
- [x] 2.4 Add focused component tests for status grouping, character selection updates, and task navigation
- [x] 2.5 Move desktop-pet controls into a dedicated Settings section and keep Hooks focused on Hook configuration
- [x] 2.6 Hide progress details until pet hover/focus and add a real-time completed-task reminder with focused tests
- [x] 2.7 Reduce the idle pet size and add state-driven head, ear, eye, tail, hand, wing, expression, and laptop animations without whole-character motion
- [x] 2.8 Add clearly visible running screen lighting and persistent completed, approval, and failure notices with focused tests
- [x] 2.9 Replace the whole-laptop glow with an upward screen-light cast on each character's face and verify it in the real client
- [x] 2.10 Refine the face lighting into a soft trapezoidal beam that widens upward from the laptop screen

## 3. Main application integration

- [x] 3.1 Add the Hook-gated desktop-pet switch and three-character selector to Settings with localized labels and tests
- [x] 3.2 Synchronize pet startup/disable behavior with Hook installation status
- [x] 3.3 Handle pet task navigation in the main window by activating an existing session tab or loading a new one
- [x] 3.4 Use human-readable session titles and prefer an existing matching live terminal tab during pet navigation
- [x] 3.5 Dismiss an exact completed event after successful pet navigation without hiding a later completion for the same session

## 4. Verification

- [x] 4.1 Run Rust tests/checks and focused frontend tests, fixing any regressions in scope
- [x] 4.2 Run the production frontend build and whitespace checks
- [x] 4.3 Start and verify the real Tauri development client with the main and pet windows
