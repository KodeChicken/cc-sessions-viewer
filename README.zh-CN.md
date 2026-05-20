<div align="center">

# Claude Session Viewer

[English](README.md) · **中文** · [日本語](README.ja.md) · [CHANGELOG](CHANGELOG.md)

一个用来浏览 **Claude Code** 和 **Codex** 本地会话记录的桌面应用 —— 在一处读取、搜索、恢复并软删除两个 CLI 的历史对话。

[![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=fff)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&logoColor=fff)](https://vuejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## 起因

Claude Code 和 Codex 都会把会话 JSONL 写到磁盘，但目录结构和入口命令各不相同，两者都没有可视化的浏览器。这个应用把两边合并成同一条时间线：

| Agent | 路径 | 分组方式 |
| --- | --- | --- |
| Claude | `~/.claude/projects/<目录>/<sessionId>.jsonl` | 按项目目录 |
| Codex | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` | 按文件里记录的 `cwd` |

应用对原始文件**只读**——删除其实是软移入 `~/.claude/.session-viewer-trash/`，不会 `rm`。

## 功能

- 🗂 **统一项目视图** —— 跨 CLI 按工作目录归并会话
- 💬 **聊天式还原** —— 文本、思考块、工具调用、结构化 diff、内嵌图片
- 🔄 **一键恢复** —— 打开 Terminal、自动 `cd` 到项目目录、执行 `claude --resume <id>` / `codex resume <id>`
- 🗑 **共享回收站 + 撤销** —— 软删除 + 还原，两 agent 共用一个 trash
- 📌 **置顶 / 沉底** —— 侧栏带色彩标识的小圆点；沉底项目自动落到列表底
- ✏️ **重命名会话** —— 本地起别名，不动原 JSONL
- 🌗 **浅色 / 深色 / 跟随系统** —— Codex 风格中性灰色调，仅 brand 色用于强调
- 🌐 **多语言** —— 中文 / English（日本語 即将到来）
- ⚡️ **自定义 tooltip 与 agent 品牌图标** —— 杜绝突兀的系统原生气泡
- 🖼 **图片 lightbox** —— 查看会话中嵌入的截图

## 截图

> _（待补到 `docs/screenshots/`）_

## 安装

### 预构建版本

到 [Releases](https://github.com/wuchao/claude-session-viewer/releases) 下载：

| 平台 | 文件 |
| --- | --- |
| macOS (Apple Silicon + Intel) | `claude-session-viewer_<ver>_universal.dmg` |
| Windows x64 | `claude-session-viewer_<ver>_x64-setup.exe` |

macOS 首次打开未签名 `.app` 会弹出提示——右键 → **打开** 即可绕过。

### 从源码构建

依赖：**Node 20+**、**Rust stable**、**Xcode CLT**（macOS）或 **MSVC + WebView2**（Windows）。

```bash
git clone https://github.com/wuchao/claude-session-viewer.git
cd claude-session-viewer
npm install
npm run tauri dev          # 开发模式
npm run tauri build        # 打包 .app / .dmg / .msi
```

`npm run build` 是类型检查步骤（`vue-tsc --noEmit` + Vite 构建）；项目没有测试 runner。

## 使用

1. **切换 agent** —— 侧栏顶部分段控件（Claude 🟠 / Codex 🟢）
2. **选项目** —— 侧栏列出所有工作目录；右键可置顶 / 沉底 / 重命名
3. **打开会话** —— 中间栏渲染消息和工具调用，调用 → 结果会自动配对
4. **恢复** —— 工具栏 ▶ 按钮唤起 Terminal 并执行对应 CLI
5. **删除 / 恢复** —— 工具栏 🗑 软删除；顶栏垃圾桶图标进入回收站

## 技术栈

- **前端** —— Vue 3 + Vite + Tailwind CSS v4（CSS 变量式 design tokens）
- **后端** —— Rust + Tauri 2（单文件 `src-tauri/src/lib.rs`）
- **JSONL 解析** —— 全部放在 Rust 侧，前端不直接读盘
- **图标** —— [iconify](https://iconify.design)（`lucide` / `material-icon-theme` / `arcticons`）编译期内联
- **没有 store** —— 状态住在 `App.vue` 的 ref 里，`localStorage` 仅保存语言 / 主题 / pin 偏好

贡献者可参考 [`CLAUDE.md`](CLAUDE.md)（架构笔记）和 [`docs/release-ci.md`](docs/release-ci.md)（发布流程）。

## Roadmap

- [ ] 日文界面
- [ ] Linux 构建产物
- [ ] 跨会话全文检索
- [ ] 导出单会话为 Markdown
- [ ] Tauri auto-updater

## 贡献

欢迎 PR。请使用 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `docs:` ...）—— `release-please` 会基于提交信息自动 bump 版本并更新 [`CHANGELOG.md`](CHANGELOG.md)。

## License

[MIT](LICENSE) © wuchao
