<div align="center">

# Claude Session Viewer

**English** · [中文](README.zh-CN.md) · [日本語](README.ja.md) · [CHANGELOG](CHANGELOG.md)

A native desktop app for browsing **Claude Code** and **Codex** local session transcripts — read, search, resume, and soft-delete past conversations from both CLIs in one place.

[![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=fff)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&logoColor=fff)](https://vuejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## Why

Claude Code and Codex both write their session JSONL files to disk, but in different layouts and through different CLIs. Neither ships a built-in browser. This app gives you a single timeline across both:

| Agent | Path | Grouping |
| --- | --- | --- |
| Claude | `~/.claude/projects/<dir>/<sessionId>.jsonl` | by project directory |
| Codex | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` | by the `cwd` recorded inside each file |

The app is **read-only** against the originals — deletion is a soft move into `~/.claude/.session-viewer-trash/`, never `rm`.

## Features

- 🗂 **Unified project view** — group sessions by working directory across both CLIs
- 💬 **Faithful chat replay** — text, thinking blocks, tool calls, structured diffs, inline images
- 🔄 **One-click resume** — opens Terminal, `cd`s into the project, runs `claude --resume <id>` / `codex resume <id>`
- 🗑 **Shared trash with undo** — soft-delete + restore, survives across both agents
- 📌 **Pin / sink projects** — color-coded pins on the sidebar; sunk projects go to the bottom
- ✏️ **Rename sessions** — alias persisted locally, original JSONL untouched
- 🌗 **Light / dark / system theme** — Codex-inspired neutral palette with brand-color accents
- 🌐 **i18n** — English / 简体中文 (Japanese coming)
- ⚡️ **Custom tooltip & agent brand icons** — no out-of-place native chrome
- 🖼 **Image lightbox** for screenshots embedded in transcripts

## Screenshots

> _(add to `docs/screenshots/`)_

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

`npm run build` is the typecheck step (`vue-tsc --noEmit` + Vite build); there is no test runner.

## Usage

1. **Switch agent** — segmented control at the top of the sidebar (Claude 🟠 / Codex 🟢)
2. **Pick a project** — sidebar lists every working directory; right-click for pin / sink / rename
3. **Open a session** — center column renders messages + tool calls grouped by call → result
4. **Resume** — toolbar ▶ button opens Terminal with the right CLI
5. **Delete / restore** — toolbar 🗑 soft-deletes; trash icon in the topbar restores

## Tech stack

- **Frontend** — Vue 3 + Vite + Tailwind CSS v4 (CSS-variable design tokens)
- **Backend** — Rust + Tauri 2 (single file, `src-tauri/src/lib.rs`)
- **JSONL parsing** — all on the Rust side; the frontend never touches the disk
- **Icons** — [iconify](https://iconify.design) (`lucide`, `material-icon-theme`, `arcticons`) inlined at build time
- **No store** — state lives in `App.vue` refs; `localStorage` only for lang / theme / pin prefs

See [`CLAUDE.md`](CLAUDE.md) for architecture notes aimed at contributors and [`docs/release-ci.md`](docs/release-ci.md) for the release pipeline.

## Roadmap

- [ ] Japanese locale
- [ ] Linux build target
- [ ] Full-text search across sessions
- [ ] Export single session to Markdown
- [ ] Tauri auto-updater

## Contributing

PRs welcome. Please use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...) — `release-please` consumes them to auto-bump versions and update [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE) © wuchao
