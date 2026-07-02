# Split Panes Architecture Analysis

> cmux-style screen splitting for the content area.
> Analysis only -- no code changes.

## Current Layout Structure

```
.app
+-- .app-topbar              (fixed titlebar, 40px, macOS drag region)
+-- .app-body                (flex row)
    +-- Sidebar              (collapsible, resizable 220-420px)
    +-- .sidebar-resizer     (drag handle)
    +-- .main                (flex column, flex:1)
        +-- TerminalStrip    (tab bar: List/View meta + TUI tabs)
        +-- .main-body       (relative container, flex:1)
            +-- .view-layer  (session/chat/list/stats/trash/welcome)
            +-- .tui-layer   (xterm terminal, absolute overlay)
```

Key files:

| File | Role |
|------|------|
| `src/App.vue` | All top-level state + template dispatch |
| `src/viewTabs.ts` | ViewTab[] + activeViewTabId (tab-level data isolation) |
| `src/terminals.ts` | TUI tabs (xterm Terminal + PTY lifecycle) |
| `src/components/TerminalStrip.vue` | Tab bar UI |
| `src/components/TerminalPaneSlot.vue` | xterm attach/detach slot |
| `src/style.css` | Layout CSS (.main-body, .view-layer, .tui-layer) |

## Dimension-by-Dimension Assessment

### 1. Data Model (ViewTab) -- READY

`viewTabs.ts` already isolates per-tab state:

```ts
interface ViewTab {
  uiId: number
  type: 'session' | 'chat'
  agent: Agent
  projectKey: string
  session: SessionMeta | null
  msgs: Msg[]
  chatSession: ChatSession | null
  liveTailing: boolean
  // ...
}
```

Each tab carries its own `agent`, `projectKey`, `session`, `msgs`,
`liveTailing` state. Split panes do NOT need a new data structure -- they
reuse `ViewTab` as-is. The pane just decides which `ViewTab.uiId` is active
within itself.

### 2. Layout CSS -- EASY

Current `.main-body` is a simple flex column. Splitting it into two panes:

```
.main-body (flex row)
+-- .pane-left  (flex:1, min-width)
|   +-- TerminalStrip
|   +-- .view-layer / .tui-layer
+-- .pane-resizer (drag handle, 4-6px)
+-- .pane-right (flex:1, min-width)
    +-- TerminalStrip
    +-- .view-layer / .tui-layer
```

The sidebar already has a working resize-handle pattern
(`onSidebarResizePointerDown` / `pointermove` / `pointerup` in App.vue) that
can be reused for the pane divider.

### 3. Singleton State in App.vue -- NEEDS REFACTOR

This is the main blocker. App.vue manages a single "current view" via:

- `activeViewTabId` (one active tab globally)
- `activeUiId` (one active TUI tab globally)
- `openSession` / `liveChat` / `chatMsgs` (computed from activeViewTab)
- `showTrash` / `showStats` / `showExportHistory` / `showPricing` (boolean flags)
- Topbar dispatches based on these flags

All of these assume **one content pane**. Split panes require:

- Each pane owns its own `activeViewTabId`
- Each pane owns its own `activeUiId` (for TUI)
- A global `focusedPaneId` tracks which pane last received focus
- Topbar actions (search, export, delete) target the focused pane

**Proposed new abstraction:**

```ts
interface Pane {
  id: number
  activeViewTabId: number | null
  activeUiId: number | null  // TUI
  // pane-local navigation state (for list/trash/stats within a pane)
}

const panes = ref<Pane[]>([{ id: 1, ... }])  // starts with 1 pane
const focusedPaneId = ref<number>(1)
```

### 4. TerminalStrip -- NEEDS SPLIT

Currently one global strip. Each pane needs its own strip showing:
- ViewTabs assigned to / visible in that pane
- TUI tabs for the pane's active project

The strip component itself is stateless (props in, events out) so it can be
instantiated per-pane without changes to its internals.

### 5. xterm / TUI Layer -- FEASIBLE

`terminals.ts` creates xterm containers as raw DOM nodes:

```ts
const container = markRaw(document.createElement('div'))
term.open(container)
```

Switching tabs moves the `container` div into/out-of a `TerminalPaneSlot`.
This already supports detach/reattach without destroying the Terminal.

For split panes: each pane has its own `TerminalPaneSlot`. Moving a TUI tab
between panes = moving the container div to a different slot. The `FitAddon`
needs a re-fit when the pane resizes (already handled by ResizeObserver in
TerminalPaneSlot).

### 6. Live Tail / File Watcher -- NO CHANGE

The `session:append` event listener matches by `path`, not by "current view":

```ts
const tab = viewTabs.value.find(
  t => t.type === 'session' && t.session?.path === e.payload.path
)
```

Multiple panes viewing different sessions will each receive their own
live-tail updates correctly. No backend changes needed.

### 7. Sidebar Interaction -- DESIGN DECISION

Current flow: click project in sidebar -> loads sessions -> click session ->
opens in content area. With two panes, "opens in content area" is ambiguous.

| Option | Behavior | Complexity |
|--------|----------|------------|
| **A. Focus-follows-click** | Sidebar actions target whichever pane was last focused | Low -- just route to `focusedPaneId` |
| **B. Drag to pane** | Drag a session from sidebar/list into a specific pane | Medium -- needs drag-and-drop |
| **C. Modifier key** | Normal click = left pane, Cmd+click = right pane | Low -- simple and discoverable |

Recommendation: **Option A** as default, with Option C as a quick shortcut.

### 8. Topbar -- NEEDS AWARENESS

The topbar currently shows context for the single active view:

```
[SidebarTopbar] [topbar-context: agent + project/view title] [ChatTopbar/TrashTopbar/SessionsTopbar]
```

With split panes, it should reflect the **focused pane's** context. The
topbar components are already props-driven, so this is mostly about wiring
them to `focusedPane.activeViewTab` instead of the global `activeViewTab`.

### 9. Backend (Tauri) -- NO CHANGE

All Tauri commands (`list_projects`, `list_sessions`, `read_session`,
`watch_session`, `soft_delete_session`, etc.) are stateless request/response.
The frontend decides what to display where. No backend changes needed.

## Summary

| Dimension | Status | Work |
|-----------|--------|------|
| Data model (ViewTab) | Ready | None |
| Layout CSS | Easy | Add flex pane containers + resize handle |
| Singleton state | **Needs refactor** | Introduce `Pane` abstraction, push per-pane state down |
| TerminalStrip | Needs split | Instantiate per-pane (component is already stateless) |
| xterm containers | Feasible | Multiple TerminalPaneSlots, re-fit on resize |
| Live tail | Ready | Already path-based, not singleton |
| Sidebar | Design decision | Focus-follows-click (Option A) recommended |
| Topbar | Needs awareness | Wire to focused pane instead of global |
| Backend | Ready | No changes |

## Recommended Approach

1. **Start with horizontal 2-pane split only** (left/right). No recursive
   split tree, no vertical splits in v1. This covers the primary use case
   (side-by-side session comparison) with minimal complexity.

2. **Introduce a `Pane` reactive object** that owns `activeViewTabId` and
   `activeUiId`. Start with `panes = [singlePane]`; the split button creates
   a second pane. Closing one pane returns to single-pane mode.

3. **Extract a `PaneContent` component** from the current `.main-body`
   template block in App.vue. Each pane renders one `<PaneContent>` with its
   own strip, view-layer, and tui-layer.

4. **Keep sidebar and topbar global** -- they read from `focusedPaneId` to
   know which pane to interact with.

Estimated effort: 2-3 days for a working horizontal split; polish (tab
drag between panes, keyboard shortcuts, persistence) adds another 1-2 days.
