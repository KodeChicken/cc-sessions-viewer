## ADDED Requirements

### Requirement: Latest Hook state per session
The system SHALL maintain at most one current task record for each normalized agent and session-path pair using validated session-status Hook events received during the current application run.

#### Scenario: A session starts a new task
- **WHEN** a `started` Hook event is received for a session that previously completed, failed, or waited for approval
- **THEN** the system replaces that session's previous record with the running state

#### Scenario: A session reaches a terminal or blocked state
- **WHEN** a `completed`, `failed`, or `blocked` Hook event is received
- **THEN** the system exposes the corresponding completed, failed, or waiting-for-approval state until a later event for that session arrives or the application exits

### Requirement: Optional desktop pet window
The system SHALL provide a single optional transparent, frameless, always-on-top, non-resizable desktop pet window that can be dragged and does not appear as a separate taskbar application.

#### Scenario: User enables the desktop pet
- **WHEN** an eligible user enables the desktop pet and no pet window exists
- **THEN** the system creates one pet window near the bottom-right of the primary display

#### Scenario: Enable is requested repeatedly
- **WHEN** the desktop pet is already open and another enable request occurs
- **THEN** the system reuses the existing pet window without creating a duplicate

#### Scenario: User disables the desktop pet
- **WHEN** the user turns off the desktop pet
- **THEN** the system closes the pet window and preserves no background pet webview

### Requirement: Hook-gated enablement
The system MUST allow desktop pet enablement only when session-status tracking Hooks are fully installed for every supported agent integration.

#### Scenario: User opens desktop pet settings
- **WHEN** the user navigates through Settings
- **THEN** the system exposes a dedicated desktop-pet section separate from the Hooks configuration section

#### Scenario: Hooks are incomplete
- **WHEN** at least one required session-status Hook is missing
- **THEN** Settings disables the desktop pet switch and explains that session-status tracking must be enabled first

#### Scenario: Hooks become incomplete after pet enablement
- **WHEN** the application detects incomplete session-status Hooks while the desktop pet preference is enabled
- **THEN** the system closes the pet window and resets the enabled preference

### Requirement: Status counts and task inspection
The desktop pet SHALL keep the selected character compact while idle, show persistent notices for completed, waiting-for-approval, and failed records, and SHALL reveal separate counts plus current task details when the user hovers or focuses the pet.

#### Scenario: User is not inspecting the pet
- **WHEN** the pet is neither hovered nor focused
- **THEN** no status cards or task panel remain visible, while current terminal-state notices remain beside the character

#### Scenario: User inspects current progress
- **WHEN** the user hovers or focuses the pet
- **THEN** the character gives a visible hover response and the pet displays all four status counts and current tasks with the session's human-readable title, agent, state, and update information

#### Scenario: User moves from the pet to the task panel
- **WHEN** the mouse leaves the character and enters the visible task panel
- **THEN** the panel remains open so the user can inspect and select its tasks

#### Scenario: No tasks exist in a status
- **WHEN** no current task record matches a status
- **THEN** that status displays a zero count without showing stale tasks from another status

### Requirement: Completed task reminder
The desktop pet SHALL briefly animate only when a new real-time completed Hook event arrives and SHALL keep a completed-task notice visible until that exact event is dismissed through successful navigation or replaced by a later state.

#### Scenario: A task completes while the pet is open
- **WHEN** the pet receives a new `completed` turn-state event
- **THEN** the character briefly raises both hands with a happy expression and displays a completion notice that can open the completed session

#### Scenario: Initial snapshot contains completed tasks
- **WHEN** the pet loads an initial snapshot containing completed task records
- **THEN** the pet shows their persistent notice without replaying completion reminder animations

#### Scenario: User opens a completed task
- **WHEN** the completed task is opened successfully from its notice or task row
- **THEN** the pet dismisses that exact completed event from its current list while allowing a later completion for the same session to appear

### Requirement: State-driven character gestures
The desktop pet SHALL animate its existing character parts rather than moving the whole character image and SHALL reflect active Hook task states through recognizable gestures.

#### Scenario: A task is running
- **WHEN** at least one current task is running
- **THEN** the character alternates its hands over the enlarged laptop keyboard while the bright screen casts a breathing, soft-edged trapezoidal light that widens upward across the character's lower face without outlining the whole laptop

#### Scenario: A task needs approval
- **WHEN** at least one current task is waiting for approval
- **THEN** the character raises one hand to notify the user

#### Scenario: A task fails
- **WHEN** at least one current task has failed
- **THEN** the character gives a visible failed response using its head, ears, and laptop screen

### Requirement: Persistent terminal-state notices
The desktop pet SHALL keep separate actionable notices for current completed, waiting-for-approval, and failed records until their underlying state is replaced or the completed event is dismissed.

#### Scenario: Multiple terminal states exist
- **WHEN** completed, waiting-for-approval, or failed records coexist
- **THEN** the pet displays one notice for each represented state and each notice opens the latest task in that state

#### Scenario: User inspects the full task panel
- **WHEN** the hover or focus task panel is open
- **THEN** the compact notices temporarily yield to the full panel and return when the panel closes if their states still exist

#### Scenario: Whole-character motion
- **WHEN** any idle, hover, or task-state animation is active
- **THEN** the outer character stage remains fixed while only the relevant body parts and effects animate

### Requirement: Direct session navigation
The system SHALL let the user open a listed task in the main Session Viewer window without creating duplicate tabs for the same agent and session path.

#### Scenario: User clicks an existing terminal task
- **WHEN** the user clicks a pet task whose agent and session path match an open or saved terminal tab
- **THEN** the system shows and focuses the main window and activates or restores that terminal tab without creating a Session Viewer tab

#### Scenario: User clicks an existing Session Viewer task
- **WHEN** the user clicks a pet task that is already open in a Session Viewer tab
- **THEN** the system shows and focuses the main window and activates the existing matching tab

#### Scenario: User clicks a task that is not open
- **WHEN** the user clicks a pet task that has no matching open tab
- **THEN** the system shows and focuses the main window, creates a session tab for the task's agent and path, and loads that session

### Requirement: Switchable original appearances
The system SHALL include three original anime-style pet appearances and SHALL allow the user to select one from Settings.

#### Scenario: User changes the appearance while the pet is open
- **WHEN** the user selects another bundled appearance
- **THEN** the open pet window updates to the selected appearance without being recreated

### Requirement: Preference persistence and startup behavior
The system SHALL persist the desktop pet enabled preference and selected appearance across application restarts while keeping task records process-local.

#### Scenario: Eligible enabled preference is restored
- **WHEN** the application starts with the pet preference enabled and all required Hooks installed
- **THEN** the system opens the pet using the persisted appearance

#### Scenario: Task records after restart
- **WHEN** the application restarts before any new Hook event is received
- **THEN** the pet displays zero current task records rather than restoring stale task states
