# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semver via [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/).

> ⚙️ This file is currently maintained by hand. From the first `release-please`-driven release onward, it will be regenerated automatically on every merge to `main` — see [`docs/release-ci.md`](docs/release-ci.md#changelog-自动维护).

---

## [v0.1.0]

### Added

- **Three-agent session support** — browse **Claude Code** (`~/.claude/projects/`), **Codex** (`~/.codex/sessions/`), and **Gemini CLI** (`~/.gemini/tmp/`) sessions in one app, normalized into a shared project → sessions → chat view. Claude and Codex group by project directory; Gemini groups by the `slug` directory, with `cwd` read from each slug's sibling `.project_root` file. Agent switch in the sidebar / welcome screen surfaces all three; Trash mixes them with color-coded badges.
- **Empty-state welcome screen** — with no project selected, the main area lists recently opened projects (per agent) for one-click jump-back, an agent switch, and a link to the project repository. Each recent entry can be removed individually via a hover-revealed ×.
- **Project sidebar** with pin / sink / rename and an agent switch (Claude 🟠 / Codex 🟢 / Gemini 🔵) at the top.
- **Chat replay** — text, thinking blocks, tool calls, structured diffs (Claude `structuredPatch`), inline images, sidechain badge. Tool results of non-file-mutating tools (read / search / shell etc.) embed inside the parent tool call's collapsible body; only Write / Edit / MultiEdit / NotebookEdit / `apply_patch` results stay as standalone diff rows so file mutations remain visually distinct.
- **In-session search with scope filter** — search across the whole conversation or scope to user messages, agent replies (incl. file-mutating edits), or tool noise; previous / next jump with a live match counter.
- **Collapse / expand all tool calls** in one click to hide tool clutter and focus on the conversation.
- **Image lightbox** for screenshots embedded in transcripts.
- **Session list keyword search** (Rust-side) — typing in the list toolbar hits a backend `search_sessions` over the current project, matching session titles **and your own message text** (the local array only carries metadata). Cancellable mid-typing in the React-Fiber style: every new keystroke aborts the in-flight scan and only fires a fresh one once input settles.
- **Session list toolbar** — sort by recency / size / message count, filter to sessions that have an ID, and multi-select for batch ops.
- **Global search** (⌘⇧F / Ctrl+Shift+F) — an Algolia-style overlay over the current agent, scoped to **session titles and your own messages** (assistant text, thinking blocks, and tool calls are intentionally excluded — that's where the noise lives). Click a hit to jump straight to the exact matching message with a flash animation. Keyboard-driven (↑↓ to navigate, ↵ to open, Esc to dismiss); recent queries are kept with per-entry removal.
  - **Performance** — rayon-parallel project scan + ASCII fast-path byte filter as a pre-screen + per-file `(path, mtime)` cache of extracted user-text; results capped at 200 server-side / 80 rendered with a "+N more" hint.
  - **Cancellability** — cooperative bail via an `AtomicU64` generation counter on the Rust side; any new request (or an explicit `cancel_search`) makes the running scan stop on the next loop check.
- **Resume or start fresh** — open Terminal in a project to resume an existing session (`claude --resume <id>` / `codex resume <id>` / `gemini …`) or start a brand-new one. Session-id is validated by a strict allowlist before shelling out.
- **New session in terminal** — start a fresh `claude` / `codex` / `gemini` session in a project's directory straight from the session-list header; the header also gains refresh and delete-project actions.
- **Export single session** to Markdown or HTML via native Save-As dialog; HTML inlines avatar SVGs and the full stylesheet so the file renders offline.
- **Batch export / delete** in the session list — toggle multi-select from the list toolbar to move many sessions to Trash in one go, or export them all into a chosen folder as Markdown / HTML (`export-YYYYMMDD-HHMMSS-{md,html}/`).
- **Soft-delete trash** shared across all three agents under `~/.claude/.session-viewer-trash/`; restore puts the JSONL back to its original parent dir; in-chat system-event row surfaces session renames.
- **Trash list improvements** — keyword-highlighted search, click a trashed entry to preview its full transcript, and a hover spotlight matching the session list.
- **Fly animations** — single-session restore arcs back to its project in the sidebar, and deleting a whole project arcs to Trash, mirroring the existing delete-to-trash animation.
- **Native application menu** — full **File / Edit / View / Find / Window / Help** menu on macOS with accelerators (⌘N new session, ⌘B toggle sidebar, ⌘E export, ⌘, settings, ⌘⌃T trash, ⌘F in-session search, ⌘G / ⌘⇧G prev/next match, ⌘⇧F global search). Theme and Language submenus use `CheckMenuItem` and stay in sync with the in-app prefs via a `menu:sync` event bridge.
- **macOS native chrome** — unified topbar (`NSToolbar` `unifiedCompact`), hidden title, drag region.
- **Light / dark / system theme**; reactive i18n in **English / 简体中文 / 繁體中文 / 日本語**, with first-launch auto-detection from the OS language (falls back to English when no locale matches).
- **Custom singleton `v-tooltip` directive** — replaces the native `title=` attribute everywhere; fades in / out with a 250 ms hover delay and flips above when there is no room below.
- **Agent brand icons** next to "Claude" / "Codex" / "Gemini" labels in the chat role tag, dispatched via a global `agentIcons` dictionary (`material-icon-theme:claude`, `arcticons:openai-chatgpt`, `material-icon-theme:gemini-ai`).
- **Vitest test suite** (309 unit tests across logic modules + leaf components, jsdom env) and a GitHub Actions CI workflow (typecheck, unit tests, `cargo clippy` / `cargo test`).

### Changed

- Toast notifications now appear top-center instead of bottom.
- Projects whose working directory no longer exists show a **"Directory missing"** tag; actions that depend on that directory (resume, new session, refresh) are hidden for them — in both the session list and the sidebar context menu.
- Clicking the already-selected project deselects it (toggle), returning to the welcome screen.
- The Trash toolbar hides its sort / multi-select controls when there is one item or none.
- Debounce intervals tuned per surface — 450 ms for the heavy global-search backend call, 280 ms for the session-list backend search and in-chat search, 220 ms for purely client-side filtering; all surfaces are IME-composition-safe.

### Fixed

- Queued user messages — text typed while the agent is still working — were dropped from the Claude transcript; they now render correctly, including messages that contain images.
- **Search-jump scroll** in long sessions — clicking a global-search hit could land at the wrong scroll position because images, code highlighting, and structured-diff blocks kept pushing the target row down after the initial scroll. `ChatView.flashMessage` now self-stabilizes via a rAF loop that re-reads `offsetTop` each frame for ~1.6 s and yields immediately on any user wheel / pointerdown / keydown.
