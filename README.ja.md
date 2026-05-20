<div align="center">

# Claude Session Viewer

[English](README.md) · [中文](README.zh-CN.md) · **日本語** · [CHANGELOG](CHANGELOG.md)

**Claude Code** と **Codex** のローカルセッションログを閲覧するためのデスクトップアプリ。2 つの CLI の会話履歴を 1 つのタイムラインで読み・検索・再開・ソフト削除できます。

[![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=fff)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&logoColor=fff)](https://vuejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## なぜ作ったか

Claude Code と Codex は会話 JSONL をディスクに保存しますが、レイアウトも CLI も別々で、組み込みのビューワーはありません。本アプリは両者を 1 つのタイムラインに統合します。

| Agent | パス | グルーピング |
| --- | --- | --- |
| Claude | `~/.claude/projects/<dir>/<sessionId>.jsonl` | プロジェクトディレクトリ単位 |
| Codex | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` | ファイル内に記録された `cwd` 単位 |

オリジナルファイルに対しては **読み取り専用** です。削除は `~/.claude/.session-viewer-trash/` への移動であり、`rm` は行いません。

## 機能

- 🗂 **統一されたプロジェクトビュー** — CLI を跨いで作業ディレクトリでセッションをまとめる
- 💬 **忠実なチャット再現** — テキスト、thinking ブロック、ツール呼び出し、構造化 diff、画像
- 🔄 **ワンクリック再開** — Terminal を開き、プロジェクトに `cd` し、`claude --resume <id>` / `codex resume <id>` を実行
- 🗑 **共有ゴミ箱 + 復元** — ソフト削除と復元、Claude と Codex で共通
- 📌 **ピン留め / 沈める** — サイドバー上に色付きドット、沈めたプロジェクトは下に
- ✏️ **セッションのリネーム** — ローカルだけのエイリアス、JSONL は変更しない
- 🌗 **ライト / ダーク / システム連動** — Codex 風のニュートラルカラー
- 🌐 **i18n** — 英語 / 簡体字中国語（日本語は近日対応予定）
- ⚡️ **カスタム tooltip & エージェントブランドアイコン** — OS ネイティブの違和感を排除
- 🖼 **画像ライトボックス** — 会話内に貼られたスクリーンショットを拡大表示

## スクリーンショット

> _(後日 `docs/screenshots/` に追加)_

## インストール

### ビルド済みバイナリ

[Releases](https://github.com/wuchao/claude-session-viewer/releases) から取得：

| プラットフォーム | ファイル |
| --- | --- |
| macOS (Apple Silicon + Intel) | `claude-session-viewer_<ver>_universal.dmg` |
| Windows x64 | `claude-session-viewer_<ver>_x64-setup.exe` |

macOS の未署名 `.app` を初回起動するときは、右クリック → **開く** で Gatekeeper を回避してください。

### ソースからビルド

必要環境：**Node 20+**、**Rust stable**、**Xcode CLT**（macOS）または **MSVC + WebView2**（Windows）。

```bash
git clone https://github.com/wuchao/claude-session-viewer.git
cd claude-session-viewer
npm install
npm run tauri dev          # 開発モード
npm run tauri build        # .app / .dmg / .msi をバンドル
```

`npm run build` は型チェック（`vue-tsc --noEmit` + Vite ビルド）です。テストランナーは含まれていません。

## 使い方

1. **エージェント切替** — サイドバー上部のセグメンテッドコントロール（Claude 🟠 / Codex 🟢）
2. **プロジェクトを選ぶ** — サイドバーに全 cwd が並びます。右クリックでピン留め / 沈め / リネーム
3. **セッションを開く** — 中央ペインにメッセージとツール呼び出しが call → result でペアリング表示
4. **再開** — ツールバーの ▶ ボタンが Terminal を開いて該当 CLI を起動
5. **削除 / 復元** — ツールバーの 🗑 がソフト削除、トップバーのゴミ箱アイコンから復元

## 技術スタック

- **フロントエンド** — Vue 3 + Vite + Tailwind CSS v4（CSS 変数ベースのデザイントークン）
- **バックエンド** — Rust + Tauri 2（単一ファイル `src-tauri/src/lib.rs`）
- **JSONL パース** — すべて Rust 側、フロントエンドはディスクに触れない
- **アイコン** — [iconify](https://iconify.design)（`lucide` / `material-icon-theme` / `arcticons`）をビルド時にインライン化
- **ストアなし** — 状態は `App.vue` の ref に置く。`localStorage` は言語 / テーマ / ピン設定のみ

コントリビューター向け資料は [`CLAUDE.md`](CLAUDE.md)（アーキテクチャ）と [`docs/release-ci.md`](docs/release-ci.md)（リリースパイプライン）。

## ロードマップ

- [ ] 日本語ロケール
- [ ] Linux ビルドターゲット
- [ ] セッション横断の全文検索
- [ ] 単一セッションを Markdown にエクスポート
- [ ] Tauri auto-updater

## コントリビュート

PR 歓迎。[Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `docs:` ...）でお願いします。`release-please` がそれを読んでバージョンを上げ、[`CHANGELOG.md`](CHANGELOG.md) を自動で更新します。

## ライセンス

[MIT](LICENSE) © wuchao
