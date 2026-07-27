## ADDED Requirements

### Requirement: Independent avatar overlay window
The system SHALL provide one optional transparent, frameless, always-on-top, taskbar-hidden desktop avatar window whose lifecycle does not depend on Session Viewer Hooks.

#### Scenario: User wakes the avatar
- **WHEN** the user enables the avatar while no avatar window exists
- **THEN** one avatar window opens near its last saved position or the bottom-right of the active display

#### Scenario: User tucks the avatar
- **WHEN** the user disables the avatar
- **THEN** the avatar window closes and no background avatar webview remains

#### Scenario: Hooks are unavailable
- **WHEN** Session Viewer status Hooks are absent or disabled
- **THEN** the avatar remains available and its enabled preference is not changed

### Requirement: Codex-compatible pet catalog
The system SHALL discover runtime-local Codex pets and custom packages under `~/.codex/pets` using the Codex manifest and atlas contract.

#### Scenario: A version 1 package is scanned
- **WHEN** a package resolves to a PNG or WebP atlas sized 1536 by 1872
- **THEN** it is listed as a nine-row pet without pointer-look frames

#### Scenario: A version 2 package is scanned
- **WHEN** a package resolves to a PNG or WebP atlas sized 1536 by 2288
- **THEN** it is listed as an eleven-row pet with 16 pointer-look frames

#### Scenario: Optional manifest values are omitted
- **WHEN** `pet.json` omits identity, display metadata, sprite version, or sprite path fields
- **THEN** safe directory-derived metadata, version 1, and `spritesheet.webp` defaults are used

#### Scenario: User manages custom pets
- **WHEN** the user refreshes the catalog or opens the pet directory
- **THEN** the system rescans or opens `~/.codex/pets` without restarting the application

### Requirement: Codex atlas state machine
The avatar SHALL use the Codex row mapping, per-frame timing, repetition, and idle fallback behavior.

#### Scenario: A transient animation plays
- **WHEN** waving, jumping, failed, waiting, running, review, running-left, or running-right becomes active
- **THEN** the authored row plays for three cycles and then continues with slow idle frames

#### Scenario: The avatar is idle
- **WHEN** no transient animation or look frame applies
- **THEN** the idle row loops with every authored frame duration multiplied by six

#### Scenario: Reduced motion is preferred
- **WHEN** the operating system requests reduced motion
- **THEN** the avatar shows a stable authored frame instead of cycling frames

### Requirement: Pointer look and hover response
The avatar SHALL match Codex pointer tracking and hover behavior.

#### Scenario: Pointer direction changes around a version 2 avatar
- **WHEN** the pointer is outside the one-pixel center dead zone and the base state supports looking
- **THEN** one of 16 look frames is selected in 22.5-degree sectors from global cursor coordinates

#### Scenario: Pointer enters the avatar
- **WHEN** the avatar is not being dragged and receives pointer enter
- **THEN** it plays the jumping animation

#### Scenario: Pointer leaves the avatar
- **WHEN** the pointer leaves and no drag is active
- **THEN** it restores its base animation state

### Requirement: Drag feedback and release positioning
The avatar SHALL use Codex's drag threshold and directional running feedback, then stop at the pointer release position without coasting.

#### Scenario: A drag begins
- **WHEN** a left-button pointer gesture moves at least four pixels outside a `.no-drag` target
- **THEN** the window follows the pointer and horizontal movement plays the corresponding running direction

#### Scenario: A drag is released
- **WHEN** the user releases the left mouse button after moving the avatar
- **THEN** the window stops at the release position, persists it, and does not move afterward

### Requirement: Avatar preferences and Settings
The system SHALL persist enabled state, selected pet, avatar size from 80 through 224 pixels, and settled window position, and SHALL expose the matching pet selection and management controls in Settings.

#### Scenario: The selected pet changes
- **WHEN** the user selects a catalog pet while the avatar is visible
- **THEN** the open avatar updates without recreating the window

#### Scenario: Avatar size changes
- **WHEN** the user changes the size control
- **THEN** the visible avatar and its pointer hit area update immediately within the supported range

#### Scenario: Application restarts
- **WHEN** the avatar was enabled before shutdown
- **THEN** it reopens with the saved pet, size, and settled position without checking Hooks

### Requirement: Legacy pet behavior is absent
The avatar overlay SHALL NOT expose the superseded Session Viewer-specific task counters, large task panel, bespoke notices, custom SVG gestures, or Hook-gated enablement.

#### Scenario: Session Hook state changes
- **WHEN** a running, completed, approval, or failed Hook event is received
- **THEN** the avatar uses the shared Codex-style activity state without creating the removed task UI or changing its availability

### Requirement: Shared Codex-style activity state
The system SHALL reuse the existing tab-status Hook pipeline as the single source for pet activity, retain the latest state per agent and normalized session path, and expose a snapshot to newly created pet windows.

#### Scenario: Pet opens after activity starts
- **WHEN** a Hook state was received before the pet webview mounted
- **THEN** the pet obtains the latest activity from the central snapshot and does not wait for another Hook event

#### Scenario: Multiple sessions have activity
- **WHEN** more than one session is active
- **THEN** the pet prioritizes Needs input, Blocked, Ready, and Running in that order and sorts equal states by most recent update

### Requirement: Activity animation and tray
The avatar SHALL map started, blocked, completed, and failed Hook states to the running, waiting, review, and failed atlas animations and SHALL expose a compact activity tray without legacy counters.

#### Scenario: Pointer interaction temporarily overrides activity
- **WHEN** the user hovers or drags the pet while an activity animation is selected
- **THEN** the interaction animation plays temporarily and the selected activity animation returns afterward

#### Scenario: User inspects activities
- **WHEN** the activity tray is opened
- **THEN** each item shows its agent, authoritative session title, and current status

### Requirement: Exact activity navigation and acknowledgement
The system SHALL open activity by exact agent and session path, preferring an existing terminal or session tab before creating a Session Viewer tab.

#### Scenario: User opens completed or failed activity
- **WHEN** the target session opens successfully
- **THEN** its Ready or Blocked activity is acknowledged and removed from the tray

#### Scenario: User opens an approval activity
- **WHEN** the target session opens successfully while it still Needs input
- **THEN** the activity remains until a later Hook state replaces it

#### Scenario: Session navigation fails
- **WHEN** the target session cannot be resolved or opened
- **THEN** its activity remains visible and is not acknowledged
