<div align="center">

# Claude Session Viewer

**English** · [中文](README.zh-CN.md) · [日本語](README.ja.md) · [CHANGELOG](CHANGELOG.md)

A native desktop app for browsing **Claude Code**, **Codex**, and **Gemini CLI** local session transcripts — read, search, resume, and soft-delete past conversations from all three CLIs in one place.

Transcripts replay faithfully (text, thinking blocks, tool calls paired with their results, structured diffs, inline screenshots). ⌘⇧F jumps from any keyword to the exact user message that mentioned it — across every project, in every agent. Export a single session or a multi-select batch to Markdown / HTML. The original JSONL files stay strictly read-only — every deletion is a soft move into a shared trash you can preview, restore from, or empty.

[![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=fff)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&logoColor=fff)](https://vuejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## Why

Claude Code, Codex, and Gemini CLI each write their session JSONL files to disk, but in different layouts and through different CLIs. None ships a built-in browser. This app gives you a single timeline across all three:

| Agent | Path | Grouping |
| --- | --- | --- |
| Claude | `~/.claude/projects/<dir>/<sessionId>.jsonl` | by project directory |
| Codex | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` | by the `cwd` recorded inside each file |
| Gemini | `~/.gemini/tmp/<slug>/chats/session-*.jsonl` | by `slug`; cwd read from the `.project_root` sibling |

The app is **read-only** against the originals — deletion is a soft move into `~/.claude/.session-viewer-trash/`, never `rm`.

## Features

- 🗂 **Unified project view** — group sessions by working directory across both CLIs
- 💬 **Faithful chat replay** — text, thinking blocks, tool calls, structured diffs, inline images
- 🔎 **In-session search with scope** — search across the whole conversation or scope to user messages, agent replies (incl. edits), or tool noise; prev / next jump + match counter
- 🌐 **Global search (⌘⇧F / Ctrl+Shift+F)** — Algolia-style overlay over the current agent, scoped to session titles and your own messages; click a hit to jump straight to that message with a flash highlight; recent queries with single-item removal
- 🔃 **Session list search & sort** — keyword search runs on the Rust side, matching session titles and your message text (cancellable mid-typing); sort by recency / size / message count, or show only ones with an ID
- 🪗 **Collapse / expand all tool calls** — one click to hide tool-call clutter and focus on the conversation
- 📤 **Export session** — save a single session to Markdown or HTML (native Save-As, offline-renderable HTML with inlined avatars / styles)
- 🧰 **Multi-select & batch ops** — pick sessions in bulk to move them to the trash or export them into a single `export-YYYYMMDD-HHMMSS-{md,html}/` folder
- 🔄 **Resume or start fresh** — open Terminal in a project to resume an existing session (`claude --resume <id>` / `codex resume <id>`) or start a brand-new one
- 🗑 **Shared trash** — soft-delete, preview a deleted session's transcript, restore one or many (multi-select); survives across both agents
- 🏠 **Welcome screen** — recently opened projects per agent with one-click reopen + per-entry removal
- 📌 **Pin / sink projects** — color-coded pins on the sidebar; sunk projects go to the bottom
- ✏️ **Rename sessions** — your new title syncs back to the CLI, so `claude` / `codex` resume pickers show it too
- 🌗 **Light / dark / system theme** — Codex-inspired neutral palette with brand-color accents
- 🌐 **i18n with auto-detect** — English / 简体中文 / 繁體中文 / 日本語; first launch matches the OS language, falls back to English
- ⚡️ **Custom tooltip & agent brand icons** — no out-of-place native chrome
- 🖼 **Image lightbox** for screenshots embedded in transcripts

## Install

### Pre-built

Grab the latest installer from [Releases](https://github.com/wuchao/claude-session-viewer/releases):

| Platform | File |
| --- | --- |
| macOS (Apple Silicon + Intel) | `claude-session-viewer_<ver>_universal.dmg` |
| Windows x64 | `claude-session-viewer_<ver>_x64-setup.exe` |

On macOS first launch the unsigned `.app` may prompt — right-click → **Open** to bypass.

### Build from source

Prereqs: **Node 20+**, **Rust stable**, **Xcode CLT** (macOS) or **MSVC + WebView2** (Windows).

```bash
git clone https://github.com/wuchao/claude-session-viewer.git
cd claude-session-viewer
npm install
npm run tauri dev          # dev shell
npm run tauri build        # bundle .app / .dmg / .msi
```

`npm run build` is the typecheck step (`vue-tsc --noEmit` + Vite build). Unit tests live under `test/` on Vitest — `npm test` for watch mode, `npm run test:run` for a single CI run, `npm run test:coverage` for a v8 coverage report.

## Usage

1. **Switch agent** — segmented control at the top of the sidebar (Claude 🟠 / Codex 🟢)
2. **Pick a project** — sidebar lists every working directory; right-click for pin / sink / rename
3. **Open a session** — center column renders messages + tool calls grouped by call → result
4. **Resume** — toolbar ▶ button opens Terminal with the right CLI
5. **Delete / restore** — toolbar 🗑 soft-deletes; trash icon in the topbar restores

## Tech stack

- **Frontend** — Vue 3 + Vite + Tailwind CSS v4 (CSS-variable design tokens)
- **Backend** — Rust + Tauri 2; each agent's JSONL parsing is isolated behind a `SessionSource` trait under `src-tauri/src/agents/<agent>.rs`
- **JSONL parsing** — all on the Rust side; the frontend never touches the disk
- **Icons** — [iconify](https://iconify.design) (`lucide`, `material-icon-theme`, `arcticons`) inlined at build time
- **No store** — state lives in `App.vue` refs; `localStorage` only for lang / theme / pin prefs

See [`CLAUDE.md`](CLAUDE.md) for architecture notes aimed at contributors and [`docs/release-ci.md`](docs/release-ci.md) for the release pipeline.

## Roadmap

- [ ] Token usage & cost analytics — per-message / per-session / per-project
- [ ] Stats overview dashboard — activity, model & token breakdown
- [ ] Session favorites & tags
- [ ] Live tail — auto-refresh an in-progress session
- [ ] Linux build target (+ Homebrew / AppImage)
- [ ] Tauri auto-updater — _manual "Check for updates" shipped; silent auto-update pending_

## Contributing

PRs welcome. Please use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...) — `release-please` consumes them to auto-bump versions and update [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE) © wuchao
