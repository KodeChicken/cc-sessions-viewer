<div align="center">

# Claude Session Viewer

[![Version](https://img.shields.io/github/v/release/jerrywu001/cc-sessions-viewer?color=blue&label=version)](https://github.com/jerrywu001/cc-sessions-viewer/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/jerrywu001/cc-sessions-viewer/releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-orange.svg)](https://tauri.app/)
[![Downloads](https://img.shields.io/github/downloads/jerrywu001/cc-sessions-viewer/total)](https://github.com/jerrywu001/cc-sessions-viewer/releases/latest)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&logoColor=fff)](https://vuejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · **中文** · [日本語](README.ja.md) · [CHANGELOG](CHANGELOG.md)

<p align="center">一个专为 <strong>Claude Code</strong>、<strong>Codex</strong> 和 <strong>Gemini CLI</strong> 打造的原生桌面浏览器。<br/>在一处读取、搜索并管理三个 CLI 的本地会话记录。</p>

<br />

<img src="docs/screenshots/session.gif" alt="Claude Session Viewer — Claude Code、Codex、Gemini CLI 会话统一浏览器" width="820" />

</div>

---

## 核心特性

- **忠实还原** — 完整呈现思考链路、工具调用配对、结构化 Diff 与内嵌截图
- **全局搜索** — 跨项目秒搜（⌘⇧F）直达具体消息
- **一键恢复** — 在窗口内嵌终端或外部终端中直接恢复/新建会话——支持 **Terminal.app**、**cmux**、**iTerm2**、**Ghostty** 和 **Warp**
- **cmux 深度集成** — 按 cwd 自动复用已有 workspace，定位正在运行的会话并蓝色闪烁提示，智能选择拆分方向，新标签页自动以目录名命名
- **启动参数** — 为每个 agent 单独配置 CLI 参数（如 `--dangerously-skip-permissions`），恢复/新建会话时自动追加
- **定位提问** — 聊天标题栏的定位按钮列出所有用户提问，点击即滚动到目标消息并闪烁高亮
- **深度统计** — 基于 LiteLLM 实时价目聚合 Token 消耗与成本，按项目/模型/工具多维分析
- **实时模型价格** — 可浏览的 Claude / Codex / Gemini 价格表，数据源自动更新
- **灵活导出** — 单会话或批量导出为离线可读的 Markdown / HTML / 无损 JSON
- **书签** — 将任意文件夹固定到侧栏快速访问，按 agent 独立管理
- **重命名与删除** — 会话重命名同步回 CLI，软删除移入共享回收站并支持还原
- **只读安全** — 原始 JSONL 全程只读，绝不物理抹除

## 截图

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/cover.png" alt="主视图 — 侧栏、会话与聊天" />
      <p align="center"><em>主视图 — 侧栏、会话列表与聊天</em></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/chat.png" alt="忠实还原 — 思考、工具调用、结构化 Diff" />
      <p align="center"><em>忠实还原 — 思考、工具调用、结构化 Diff</em></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/session-resume.png" alt="内嵌终端恢复会话" />
      <p align="center"><em>内嵌终端 — 一键恢复或新建会话</em></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/search.png" alt="全局搜索浮层" />
      <p align="center"><em>全局搜索（⌘⇧F）直达目标消息</em></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/stats.png" alt="Token 与成本统计面板" />
      <p align="center"><em>按项目 · 模型 · 工具维度分析 Token 与成本</em></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/export.png" alt="浏览器中预览导出的 HTML" />
      <p align="center"><em>导出 HTML — 完全离线，浏览器直接打开</em></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/model-price.png" alt="模型价格面板" />
      <p align="center"><em>实时模型价格面板</em></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/trash.png" alt="共享回收站与恢复" />
      <p align="center"><em>共享回收站 — 软删除，一键恢复</em></p>
    </td>
  </tr>
</table>

## 安装

到 [Releases](https://github.com/jerrywu001/cc-sessions-viewer/releases) 下载对应平台的安装包：

| 平台 | 文件 |
| --- | --- |
| macOS (Apple Silicon + Intel) | `.dmg` |
| Windows x64 | `-setup.exe` / `.msi` |
| Linux x86_64 | `.deb` / `.AppImage` |

macOS 上 `.app` 是 **ad-hoc 签名、未公证**，首次打开可能弹出「Apple 无法验证…」。两种绕过方式：

- Finder 里右键应用 → **打开** → 弹窗里再确认（一次即可）。
- 或在终端清掉隔离属性：
  ```bash
  sudo xattr -dr com.apple.quarantine /Applications/cc-sessions-viewer.app
  ```

Linux 上 `.AppImage` 是便携格式 —— `chmod +x` 后直接运行。`.deb` 安装：
```bash
sudo apt install ./cc-sessions-viewer_<ver>_amd64.deb
```

## 开发

```bash
git clone https://github.com/jerrywu001/cc-sessions-viewer.git
cd cc-sessions-viewer
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 打包
```

依赖：Node 20+、Rust stable。架构详见 [`CLAUDE.md`](CLAUDE.md)。

## 贡献

欢迎 PR。请使用 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `docs:` ...）。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jerrywu001/cc-sessions-viewer&type=Date)](https://www.star-history.com/#cc-sessions-viewer&Date)

## License

[MIT](LICENSE) © jerrywu001 · [@jerrywu185](https://x.com/jerrywu185)
