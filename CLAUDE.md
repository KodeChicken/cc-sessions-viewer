# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

A macOS Tauri 2 desktop app (Vue 3 + Rust) for browsing, viewing, and trashing
**Claude Code** and **Codex** local session transcripts. Two CLIs store their
JSONL transcripts in different layouts; this app normalizes both into the same
project → sessions → chat UI, plus a soft-delete trash that survives across
agents. The app is read-only against the original transcripts — deletion is a
`move` into a trash dir, never `rm`.

## Commands

```bash
npm run tauri dev        # full dev (Tauri shell + Vite on :1420)
npm run tauri build      # bundle .app / .dmg into src-tauri/target/release/bundle/
npm run dev              # web-only Vite preview; Tauri invokes will fail
npm run build            # vue-tsc --noEmit + vite build
```

There is no test runner and no linter wired up — `npm run build` (which runs
`vue-tsc --noEmit` first) is the typecheck step.

Vite is locked to port `1420` (strictPort) because `tauri.conf.json` hardcodes
that URL. `src-tauri/**` is excluded from Vite's watcher; Rust changes are
picked up by Tauri's own dev loop.

## Architecture

### Two-side split

- **Frontend** (`src/`) is a thin Vue 3 SPA. State lives in `App.vue` refs;
  there is no store. All persistence besides `localStorage` (lang/theme/pin
  prefs) goes through Tauri.
- **Backend** (`src-tauri/src/lib.rs`, single file) owns *all*
  filesystem I/O and JSONL parsing. Frontend calls it via the
  `#[tauri::command]` functions wrapped in `src/api.ts`. The full
  list is registered in `tauri::generate_handler!` at the bottom
  of `lib.rs`; keep it in sync.

When adding a feature that touches files, add a command in `lib.rs`, register
it in `tauri::generate_handler!` at the bottom, then expose it from `api.ts`
with the matching TypeScript types in `types.ts`. `serde(rename_all =
"camelCase")` is used everywhere so Rust snake_case fields land in JS as
camelCase.

### Session-source abstraction

The backend hides two very different on-disk layouts behind a uniform `Msg[]`
shape (see `src/types.ts`):

| Agent  | Layout                                                              | Project grouping                |
| ------ | ------------------------------------------------------------------- | ------------------------------- |
| Claude | `~/.claude/projects/<dir>/<sessionId>.jsonl`                        | by project directory            |
| Codex  | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`                | by the `cwd` recorded *inside* each file |

Each of the three public commands (`list_projects`, `list_sessions`,
`read_session`) dispatches on the `agent: "claude" | "codex"` argument to a
pair of `list_claude_*` / `list_codex_*` (or `read_*`) helpers. When adding a
new agent or extending parsing, keep that branching pattern — do not push
agent-specific shapes up to the frontend.

`list_sessions` is paginated; it sorts by mtime cheaply and only deep-parses
the window slice. `read_session` is the only call that walks the full file.

### Trash is shared across agents

`soft_delete_session` moves the JSONL into `~/.claude/.session-viewer-trash/`
with a sibling `<file>.meta.json` describing original path, agent, project
label, deletion timestamp, etc. The trash dir lives under `~/.claude` even for
Codex deletions — there is one trash, not two. `restore_session` reads the
`.meta.json` to recreate the original parent directory and move the file back.

### Diff parsing in tool results

When a Claude `tool_result` carries a `structuredPatch`, `parse_structured_patch`
in `lib.rs` converts it into the `DiffHunk[]` shape consumed by
`components/DiffBlock.vue`. Anything not in that shape just shows as text in
`<pre>`. The frontend does not parse diffs itself.

### Resume = AppleScript → Terminal

`resume_session` shells out to `osascript` to open Terminal.app, `cd` into the
project dir, and run `claude --resume <id>` or `codex resume <id>`. It
validates the session id with a strict allowlist (`[A-Za-z0-9-]+`) because the
id is interpolated into a shell command.

### macOS titlebar / traffic lights

The CSS topbar is 40px and shares background with the sidebar; the unified
look depends on AppKit growing the native titlebar to match. `pin_traffic_lights`
in `lib.rs` attaches an empty `NSToolbar` with `unifiedCompact` style — the
*supported* AppKit way to extend the titlebar. The setup hook re-pins on
`WindowEvent::Resized` (and intentionally *not* on Focused/ThemeChanged, which
breaks click→drag tracking). Don't try to manually `setFrameOrigin` the
window buttons; it visually works but corrupts drag-region tracking.

### Reactive i18n + theme

- `src/settings.ts` holds `lang` and `theme` as `ref`s persisted to
  `localStorage`. `applyTheme()` is wrapped in `watchEffect`, so toggling
  theme/lang re-renders Vue templates that read those refs automatically.
- `t(key, vars)` in `src/i18n.ts` reads `lang.value` — that read is what makes
  every template using `t()` reactive. Don't cache `t()` results outside of a
  computed/template.

### Design system

`src/style.css` defines a Codex-inspired neutral token set
(`--surface`, `--surface-hover`, `--border`, `--text`, `--accent`, ...) with a
`:root` (light) and `:root.theme-dark` override block. Brand color
(`--brand` = Claude orange or Codex green) is only used for tiny accents like
the active-project count badge and the agent badge in the trash list — primary
buttons and active surfaces use neutral foreground inversion (Codex style).

Icons are inline SVG components in `src/components/icons.ts`. Do not introduce
emoji icons in chrome — they were intentionally removed for a cleaner look.
Tailwind v4 is installed but most styling uses the CSS-variable tokens above;
new components should follow the existing class-name convention rather than
inlining utility classes.

Tooltips use the custom `v-tooltip` directive (registered in `src/main.ts`,
implemented in `src/tooltip.ts`) rather than the native `title=` attribute —
native tooltips render in a system font and look out of place in this UI.
When adding a new button or icon, write `v-tooltip="t('...')"`, not `:title`.
