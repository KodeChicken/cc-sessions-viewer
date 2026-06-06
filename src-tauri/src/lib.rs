// AI 会话管理器 —— 后端入口。
//
// 这个文件只做两件事：
//   1. 注册 Tauri 命令，把请求路由到对应模块（`agents` / `trash`）。
//   2. macOS 启动期 setup（unifiedCompact 标题栏）。
//
// 所有 agent 相关的解析、读写、重命名逻辑都在 `agents/*.rs` 里；
// 回收站逻辑在 `trash.rs`；跨模块共用的小工具在 `util.rs`；
// 跟前端共享的序列化类型在 `types.rs`。
// 接入新 agent 的步骤详见 `agents/mod.rs` 顶部注释。

// agents / stats are `pub` so the `examples/test_dedup.rs` binary (compiled as
// an external consumer of the lib crate) can call into the dedup pipeline
// directly. Everything else stays crate-private.
pub mod agents;
mod bookmarks;
mod menu;
mod pty;
pub mod stats;
#[cfg(target_os = "macos")]
mod tray;
mod trash;
mod types;
mod util;
mod watch;

use std::fs;
use std::path::{Path, PathBuf};

use crate::types::{
    AgentStats, Msg, ProjectInfo, SearchHit, SessionPage, TrashItem, UsageSummary,
};
use crate::util::is_jsonl;

/// 全局搜索的取消代际 —— 每次新搜索把自己的 `request_id` 写进来，正在跑的搜索循环
/// 不停 check；一旦发现 gen ≠ 自己的 id 就主动 bail。`cancel_search()` 直接 bump 它。
static SEARCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ============================ Tauri 命令：分派层 ============================

#[tauri::command]
fn list_projects(
    agent: String,
    include_codex_internal: bool,
    include_codex_archived: bool,
) -> Result<Vec<ProjectInfo>, String> {
    let mut out = agents::source(&agent)?.list_projects(include_codex_internal, include_codex_archived)?;
    let bm = bookmarks::load(&agent);
    for bp in bm {
        if out.iter().any(|p| p.display_path == bp) {
            continue;
        }
        let bp_path = Path::new(&bp);
        let exists = bp_path.is_dir();
        let (count, last) = if exists {
            bookmarks::count_sessions(bp_path)
        } else {
            (0, 0)
        };
        out.push(ProjectInfo {
            dir_name: format!("bookmark:{bp}"),
            display_path: bp,
            session_count: count,
            last_modified: last,
            exists,
            bookmarked: true,
        });
    }
    Ok(out)
}

#[tauri::command]
fn list_sessions(
    agent: String,
    project_key: String,
    offset: usize,
    limit: usize,
    include_codex_internal: bool,
    include_codex_archived: bool,
) -> Result<SessionPage, String> {
    if let Some(bm_path) = project_key.strip_prefix("bookmark:") {
        return bookmarks::list_sessions_in_dir(bm_path, offset, limit);
    }
    agents::source(&agent)?.list_sessions(
        &project_key,
        offset,
        limit,
        include_codex_internal,
        include_codex_archived,
    )
}

#[tauri::command]
fn read_session(agent: String, path: String) -> Result<Vec<Msg>, String> {
    agents::source(&agent)?.read_session(&path)
}

/// 实时 tail：开始监听 path 文件的写入事件。
/// 同一时刻只允许一个 watch；再次调用会替换上一个 watcher。
/// 文件不存在返回 Err，前端可以静默降级（仅一次性读取）。
#[tauri::command]
fn watch_session(app: tauri::AppHandle, agent: String, path: String) -> Result<(), String> {
    watch::watch_session(app, agent, path)
}

/// 停止当前 tail；空操作可重入。前端 unmount / 切会话时调用。
#[tauri::command]
fn unwatch_session() -> Result<(), String> {
    watch::unwatch_session()
}

/// 单个会话的 token 用量汇总（按 path + mtime 缓存）。
/// 前端 ChatTopbar / SessionsView 卡片懒加载这条；Gemini 暂占位返零。
#[tauri::command]
fn session_usage(agent: String, path: String) -> Result<UsageSummary, String> {
    let src = agents::source(&agent)?;
    agents::session_usage(&*src, &path)
}

/// 当前 agent 的统计概览：顶层标量 + 项目排行（按 token 降序）+ 日活时间轴。
/// **保留作兼容入口** —— 旧版同步路径仍然可用，但内容比 start_agent_stats 简化（没有
/// cost / by_model / by_tool 等）。前端默认走流式接口，这里只作兜底。
#[tauri::command]
fn agent_stats(agent: String) -> Result<AgentStats, String> {
    let src = agents::source(&agent)?;
    agents::agent_stats(&*src, &agent)
}

/// 流式启动一次统计扫描。函数立刻返回；后台 worker 通过 `stats://progress` /
/// `stats://done` / `stats://error` 三个事件把结果推回前端。新请求会让旧请求让位
/// （`STATS_GEN` 代际计数器）。前端用 `requestId` 比对，丢掉旧数据。
///
/// `scope`：`all` / `claude` / `codex` / `gemini` / `session:<agent>:<absolute path>`。
/// `range`：`today` / `days7` / `days30` / `all`（session-scope 下忽略）。
#[tauri::command]
fn start_agent_stats(app: tauri::AppHandle, scope: String, range: String, request_id: u64) {
    stats::stream::start(app, scope, range, request_id);
}

/// 立刻取消任何正在跑的统计 worker。本质上是把全局代际 +1，跑中的 worker 自己 bail。
#[tauri::command]
fn cancel_stats() {
    stats::stream::cancel();
}

/// 全局搜索：跨当前 agent 的所有项目 / 会话查关键词。
/// 命中范围在 `agents::search` 里：标题 / id / 项目路径 / 文本（仅 text + thinking 块）；
/// 工具调用 / 工具结果 / 文件改动默认不参与匹配。
/// 空字符串返回空数组（避免一次性把所有会话当结果返回）。
///
/// **可取消**：每次调用都会把 `request_id` 写进全局 SEARCH_GEN；之后任何 `cancel_search()`
/// 或更大 id 的 `search_sessions` 都会让旧的搜索循环立刻 bail（返回空数组）。前端的
/// reqSeq 守卫负责丢掉过期结果，所以即使后端返回了一堆结果也不会污染 UI。
#[tauri::command]
fn search_sessions(
    agent: String,
    query: String,
    request_id: u64,
    project_key: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    SEARCH_GEN.store(request_id, std::sync::atomic::Ordering::SeqCst);
    let src = agents::source(&agent)?;
    let cancel = agents::Cancel {
        request_id,
        gen: &SEARCH_GEN,
    };
    agents::search(&*src, &query, project_key.as_deref(), cancel)
}

/// 显式取消正在跑的全局搜索 —— 前端每次新输入立即调一次，让 CPU 让位给打字。
/// 仅仅 bump 一下 SEARCH_GEN —— 在跑的 search 循环下次 check 时就会 bail。
#[tauri::command]
fn cancel_search() {
    SEARCH_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// 重命名会话：与 Claude Code `/rename` / Codex 内部重命名一致，
/// 在原 JSONL 末尾追加一条官方 schema 的元数据行（append-only），
/// 后续扫描时取最后一条 `custom-title` / `thread_name_updated` 作为标题。
/// 各 agent 还可能写额外的旁路文件（codex 会同步更新 session_index.jsonl / state_<N>.sqlite）。
#[tauri::command]
fn rename_session(agent: String, path: String, name: String) -> Result<(), String> {
    let fp = PathBuf::from(&path);
    if !fp.exists() {
        return Err("会话文件不存在".to_string());
    }
    if !is_jsonl(&fp) {
        return Err("不是 JSONL 文件".to_string());
    }
    agents::source(&agent)?.rename_session(&fp, &name)
}

#[tauri::command]
fn soft_delete_session(agent: String, path: String, project_label: String) -> Result<(), String> {
    trash::soft_delete(&agent, &path, &project_label)
}

#[tauri::command]
fn list_trash() -> Result<Vec<TrashItem>, String> {
    trash::list()
}

#[tauri::command]
fn restore_session(trash_file: String) -> Result<(), String> {
    trash::restore(&trash_file)
}

#[tauri::command]
fn permanent_delete_trash(trash_file: String) -> Result<(), String> {
    trash::permanent_delete(&trash_file)
}

#[tauri::command]
fn empty_trash() -> Result<(), String> {
    trash::empty()
}

/// 内嵌 TUI：在窗口内部的 xterm.js 里跑 `<shell> -l -c "cd <cwd> && <resume CLI>"`。
/// 返回新 PTY 的内部 id；前端拿 id 调 `pty_write` / `pty_resize` / `pty_kill`。
/// 与 `resume_session`（开 Terminal.app）并存 —— 调用方各自决定走哪一条。
#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    agent: String,
    session_id: String,
    cwd: String,
    path: String,
    cols: u16,
    rows: u16,
    extra_args: String,
) -> Result<u64, String> {
    if !Path::new(&cwd).is_dir() {
        return Err("项目目录已不存在，无法恢复".to_string());
    }
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("会话 ID 非法".to_string());
    }
    let mut cli = agents::source(&agent)?.resume_cli(&session_id, &path);
    append_extra_args(&mut cli, &extra_args);
    pty::spawn(app, cwd, cli, cols, rows)
}

/// 启动一个 “new session” PTY（不带 --resume）。session_id 不需要 —— 由 CLI 自己生成新 id。
#[tauri::command]
fn pty_spawn_new(
    app: tauri::AppHandle,
    agent: String,
    cwd: String,
    cols: u16,
    rows: u16,
    extra_args: String,
) -> Result<u64, String> {
    if !Path::new(&cwd).is_dir() {
        return Err("项目目录已不存在，无法创建会话".to_string());
    }
    let mut cli = agents::source(&agent)?.new_session_cli();
    append_extra_args(&mut cli, &extra_args);
    pty::spawn(app, cwd, cli, cols, rows)
}

#[tauri::command]
fn pty_write(id: u64, data: String) -> Result<(), String> {
    pty::write(id, &data)
}

#[tauri::command]
fn pty_resize(id: u64, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(id: u64) -> Result<(), String> {
    pty::kill(id)
}

/// 在终端中用对应 CLI 恢复（resume）一个会话。
#[tauri::command]
fn resume_session(
    agent: String,
    session_id: String,
    cwd: String,
    path: String,
    extra_args: String,
    terminal_app: String,
) -> Result<(), String> {
    if !Path::new(&cwd).is_dir() {
        return Err("项目目录已不存在，无法恢复".to_string());
    }
    // id 校验：Claude/Codex 为 UUID，Gemini 为 session-<startTime>-<id8>
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("会话 ID 非法".to_string());
    }
    let mut cli = agents::source(&agent)?.resume_cli(&session_id, &path);
    append_extra_args(&mut cli, &extra_args);
    spawn_terminal(&cli, &cwd, &terminal_app)
}

/// 在终端里为某个项目目录开一个全新会话（不带 --resume）。
#[tauri::command]
fn new_session(agent: String, cwd: String, extra_args: String, terminal_app: String) -> Result<(), String> {
    if !Path::new(&cwd).is_dir() {
        return Err("项目目录已不存在，无法创建会话".to_string());
    }
    let mut cli = agents::source(&agent)?.new_session_cli();
    append_extra_args(&mut cli, &extra_args);
    spawn_terminal(&cli, &cwd, &terminal_app)
}

fn append_extra_args(cli: &mut String, extra: &str) {
    let trimmed = extra.trim();
    if !trimmed.is_empty() {
        cli.push(' ');
        cli.push_str(trimmed);
    }
}

fn spawn_terminal(cli: &str, cwd: &str, terminal_app: &str) -> Result<(), String> {
    use std::sync::Mutex;
    use std::time::Instant;
    static LAST_SPAWN: Mutex<Option<(String, Instant)>> = Mutex::new(None);
    {
        let mut last = LAST_SPAWN.lock().unwrap();
        if let Some((ref prev_cwd, t)) = *last {
            if prev_cwd == cwd && t.elapsed().as_millis() < 2000 {
                return Ok(());
            }
        }
        *last = Some((cwd.to_string(), Instant::now()));
    }

    #[cfg(target_os = "macos")]
    {
        let cwd_quoted = cwd.replace('\'', "'\\''");
        let shell_cmd = format!("cd '{cwd_quoted}' && {cli}");

        match terminal_app {
            "iterm2" => {
                let as_arg = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
                let script = format!(
                    "set wasRunning to false\n\
                     tell application \"System Events\"\n\
                       set wasRunning to (exists process \"iTerm2\")\n\
                     end tell\n\
                     tell application \"iTerm\"\n\
                     activate\n\
                     end tell\n\
                     if not wasRunning then\n\
                       delay 0.5\n\
                       tell application \"iTerm\"\n\
                         tell current session of current window to write text \"{as_arg}\"\n\
                       end tell\n\
                     else\n\
                       tell application \"iTerm\"\n\
                         tell current window to create tab with default profile\n\
                         tell current session of current window to write text \"{as_arg}\"\n\
                       end tell\n\
                     end if"
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .spawn()
                    .map_err(|e| format!("启动 iTerm2 失败: {e}"))?;
            }
            // TODO: Ghostty macOS 没有窗口管理 API，无法按 cwd 复用已有窗口，
            // 每次都会开新实例。等 Ghostty 支持 IPC 后再实现窗口复用。
            "ghostty" => {
                std::process::Command::new("open")
                    .args([
                        "-na",
                        "Ghostty.app",
                        "--args",
                        &format!("--working-directory={cwd}"),
                        "-e",
                        "bash",
                        "-lc",
                    ])
                    .arg(cli)
                    .spawn()
                    .map_err(|e| format!("启动 Ghostty 失败: {e}"))?;
            }
            "cmux" => {
                let found_ref = std::process::Command::new("cmux")
                    .args(["workspace", "list", "--json"])
                    .env("CMUX_QUIET", "1")
                    .output()
                    .ok()
                    .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
                    .and_then(|json| {
                        json["workspaces"].as_array()?.iter()
                            .find(|w| w["current_directory"].as_str() == Some(cwd))
                            .and_then(|w| w["ref"].as_str().map(String::from))
                    });

                if let Some(ws_ref) = found_ref {
                    // 从 cli 提取会话 ID（UUID-like token）用于去重
                    let session_id = cli.split_whitespace().find(|s| {
                        s.len() > 8 && s.contains('-')
                            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                    });

                    // 检查 workspace 里是否已有运行这个会话的 surface
                    let existing_surface = session_id.and_then(|sid| {
                        let o = std::process::Command::new("cmux")
                            .args(["rpc", "surface.list", &format!("{{\"workspace_id\":\"{ws_ref}\"}}")])
                            .output()
                            .ok()?;
                        let json: serde_json::Value = serde_json::from_slice(&o.stdout).ok()?;
                        json["surfaces"].as_array()?.iter().find_map(|s| {
                            let title = s["title"].as_str().unwrap_or("");
                            let checkpoint = s["resume_binding"]["checkpoint_id"].as_str().unwrap_or("");
                            let cmd = s["resume_binding"]["command"].as_str().unwrap_or("");
                            if title.contains(sid) || checkpoint == sid || cmd.contains(sid) {
                                Some((
                                    s["pane_ref"].as_str()?.to_string(),
                                    s["ref"].as_str()?.to_string(),
                                ))
                            } else {
                                None
                            }
                        })
                    });

                    if let Some((_pane_ref, surface_ref)) = existing_surface {
                        let _ = std::process::Command::new("cmux")
                            .args(["workspace", "select", &ws_ref])
                            .output();
                        let _ = std::process::Command::new("cmux")
                            .args([
                                "rpc",
                                "surface.focus",
                                &format!("{{\"workspace_id\":\"{ws_ref}\",\"surface_id\":\"{surface_ref}\"}}"),
                            ])
                            .output();
                        let _ = std::process::Command::new("cmux")
                            .args(["trigger-flash", "--workspace", &ws_ref, "--surface", &surface_ref])
                            .spawn();
                    } else {
                        // 新开 split
                        let _ = std::process::Command::new("cmux")
                            .args(["workspace", "select", &ws_ref])
                            .output();

                        let split_dir = std::process::Command::new("cmux")
                            .args(["rpc", "pane.list", &format!("{{\"workspace_id\":\"{ws_ref}\"}}")])
                            .output()
                            .ok()
                            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
                            .and_then(|json| {
                                let pane = json["panes"].as_array()?.iter()
                                    .find(|p| p["focused"].as_bool() == Some(true))?;
                                let w = pane["pixel_frame"]["width"].as_f64()?;
                                let h = pane["pixel_frame"]["height"].as_f64()?;
                                Some(if w >= h { "right" } else { "down" })
                            })
                            .unwrap_or("down");

                        let _ = std::process::Command::new("cmux")
                            .args(["new-split", split_dir, "--workspace", &ws_ref, "--focus", "true"])
                            .output();
                        let _ = std::process::Command::new("cmux")
                            .args(["send", "--workspace", &ws_ref, cli])
                            .output();
                        std::process::Command::new("cmux")
                            .args(["send-key", "--workspace", &ws_ref, "enter"])
                            .spawn()
                            .map_err(|e| format!("启动 cmux 失败: {e}"))?;
                    }
                } else {
                    let ws_name = Path::new(cwd)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let mut args = vec![
                        "new-workspace",
                        "--cwd",
                        cwd,
                        "--command",
                        cli,
                        "--focus",
                        "true",
                    ];
                    if !ws_name.is_empty() {
                        args.push("--name");
                        args.push(&ws_name);
                    }
                    std::process::Command::new("cmux")
                        .args(&args)
                        .spawn()
                        .map_err(|e| format!("启动 cmux 失败: {e}"))?;
                }
            }
            "warp" => {
                let tab_name = Path::new(cwd)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let titled_cmd = format!("printf '\\033]0;{tab_name}\\007'; {shell_cmd}");
                let as_arg = titled_cmd.replace('\\', "\\\\").replace('"', "\\\"");
                let script = format!(
                    "set the clipboard to \"{as_arg}\"\n\
                     tell application \"Warp\"\n\
                     activate\n\
                     end tell\n\
                     delay 0.3\n\
                     tell application \"System Events\"\n\
                     tell process \"Warp\"\n\
                       keystroke \"t\" using command down\n\
                     end tell\n\
                     end tell\n\
                     delay 0.3\n\
                     tell application \"System Events\"\n\
                     tell process \"Warp\"\n\
                       key code 53\n\
                     end tell\n\
                     end tell\n\
                     delay 0.3\n\
                     tell application \"System Events\"\n\
                     tell process \"Warp\"\n\
                       keystroke \"v\" using command down\n\
                     end tell\n\
                     end tell\n\
                     delay 0.5\n\
                     tell application \"System Events\"\n\
                     tell process \"Warp\"\n\
                       key code 36\n\
                     end tell\n\
                     end tell"
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .spawn()
                    .map_err(|e| format!("启动 Warp 失败: {e}"))?;
            }
            _ => {
                let as_arg = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
                let script = format!(
                    "set wasRunning to false\n\
                     tell application \"System Events\"\n\
                       set wasRunning to (exists process \"Terminal\")\n\
                     end tell\n\
                     tell application \"Terminal\"\n\
                     activate\n\
                     end tell\n\
                     if not wasRunning then\n\
                       delay 0.3\n\
                       tell application \"Terminal\"\n\
                         do script \"{as_arg}\" in front window\n\
                       end tell\n\
                     else\n\
                       tell application \"Terminal\"\n\
                         do script \"{as_arg}\"\n\
                       end tell\n\
                     end if"
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .spawn()
                    .map_err(|e| format!("启动终端失败: {e}"))?;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let cwd_win = cwd.replace('/', "\\");
        let ps_cmd = format!("Set-Location \"{}\"; {}", cwd_win, cli);
        let launched = std::process::Command::new("cmd")
            .args(["/c", "start", "powershell", "-NoExit", "-Command", &ps_cmd])
            .spawn()
            .is_ok();
        if !launched {
            std::process::Command::new("cmd")
                .args([
                    "/c",
                    "start",
                    "cmd",
                    "/k",
                    &format!("cd /d \"{}\" && {}", cwd_win, cli),
                ])
                .spawn()
                .map_err(|e| format!("启动终端失败: {e}"))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let shell_cmd = format!("cd '{}' && {}", cwd.replace('\'', "'\\''"), cli);
        let terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
        let mut launched = false;
        for term in &terminals {
            let result = if *term == "gnome-terminal" {
                std::process::Command::new(term)
                    .args(["--", "bash", "-c", &shell_cmd])
                    .spawn()
            } else {
                std::process::Command::new(term)
                    .args(["-e", &format!("bash -c '{}'", shell_cmd.replace('\'', "'\\''"))])
                    .spawn()
            };
            if result.is_ok() {
                launched = true;
                break;
            }
        }
        if !launched {
            return Err("未找到可用的终端程序".to_string());
        }
    }

    Ok(())
}

/// 检测 macOS 上已安装的外部终端应用。返回可用终端 key 列表（不含 terminal —— 那个始终可用）。
#[tauri::command]
fn detect_terminals() -> Vec<String> {
    let mut found = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/iTerm.app").exists() {
            found.push("iterm2".to_string());
        }
        if Path::new("/Applications/Ghostty.app").exists() {
            found.push("ghostty".to_string());
        }
        if std::process::Command::new("which")
            .arg("cmux")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            found.push("cmux".to_string());
        }
        if Path::new("/Applications/Warp.app").exists() {
            found.push("warp".to_string());
        }
    }
    found
}

#[tauri::command]
fn add_bookmark(agent: String, path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("目录不存在".to_string());
    }
    bookmarks::add(&agent, &path)
}

#[tauri::command]
fn remove_bookmark(agent: String, path: String) -> Result<(), String> {
    bookmarks::remove(&agent, &path)
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 把字符串内容写到用户指定的绝对路径。
///
/// 历史：早期版本叫 save_to_downloads，自动落到 ~/Downloads；现在已经接入
/// tauri-plugin-dialog 的 save 对话框由前端拿到目标路径，所以后端只负责
/// 把字节安全写入指定位置。Tauri WKWebView 不支持 `<a download>`/blob URL，
/// 写盘必须经过 Rust。
#[tauri::command]
fn write_file(path: String, content: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    fs::write(&p, content).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(p.to_string_lossy().to_string())
}

/// 在系统文件管理器中显示该文件。
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开访达失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.replace('/', "\\")))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {e}"))?;
    }
    Ok(())
}

/// 在系统默认浏览器中打开一个外部链接。只放行 http/https，避免 url 被
/// 当成本地文件或其它协议处理。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("仅支持 http(s) 链接".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    Ok(())
}

/// 手动从 LiteLLM 上游拉一次模型价格表，覆盖本地 24h 缓存。前端 Settings
/// 「立即刷新模型价格」按钮调用。返回入表条数；失败返回错误字符串（前端弹 toast）。
///
/// **必须是 async**：内部 `refresh_blocking` 走 `ureq::get(...).call()`，是真同步阻塞
/// 调用，timeout 高达 20s。如果当 sync Tauri 命令直接跑，会霸占 webview 主线程，
/// UI 一切动画 / 滚动 / 鼠标光标全冻 —— 用户反馈"点了刷新像卡死了"就是这个。
/// 改成 async + `spawn_blocking` 后阻塞活路扔进 Tauri 的后台线程池，UI 线程立刻
/// 返回继续跑 CSS 动画，等结果时 webview 仍然响应。
#[tauri::command]
async fn refresh_pricing() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(stats::pricing::refresh_blocking)
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// 价格表当前状态。前端按 `loaded` / `fetching` / `lastError` 决定渲染：
///   - loaded=false && fetching=true → 显示加载占位
///   - loaded=false && lastError=Some → 显示 error placeholder
///   - loaded=true → 正常渲染（即使过期 cache 也先用着）
#[tauri::command]
fn pricing_status() -> stats::pricing::PricingStatus {
    stats::pricing::status()
}

/// 返回当前价格表里 Claude / Codex / Gemini 三家的全部模型 —— 给 PricingView 弹窗渲染。
/// 已按 family 分组、组内按 input 单价升序，前端可直接 group_by(family) 渲染。
#[tauri::command]
fn list_pricing() -> Vec<stats::pricing::PricingEntry> {
    stats::pricing::list_for_ui()
}

/// Attach an empty `NSToolbar` with `unifiedCompact` style so AppKit grows the
/// titlebar to ~40px and auto-centers the traffic lights vertically inside it
/// — matching our 40px CSS topbar. This is the SUPPORTED AppKit way to extend
/// the titlebar; manually `setFrameOrigin`-ing the standardWindowButtons works
/// visually but appears to confuse AppKit's titlebar drag tracking (focused
/// click→drag stops working).
#[cfg(target_os = "macos")]
fn pin_traffic_lights(window: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};

    let ns_window_ptr = match window.ns_window() {
        Ok(p) => p as *mut AnyObject,
        Err(_) => return,
    };
    if ns_window_ptr.is_null() {
        return;
    }

    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
    };
    unsafe {
        let ns_window: Retained<NSWindow> = match Retained::retain(ns_window_ptr.cast::<NSWindow>()) {
            Some(w) => w,
            None => return,
        };
        if ns_window.toolbar().is_some() {
            return; // 已挂好，避免重复
        }
        let toolbar = NSToolbar::new(mtm);
        ns_window.setToolbar(Some(&toolbar));
        ns_window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // 开发期注入 MCP Bridge —— 让 AI 助手经 WebSocket 直接看/控这个 app（截图 /
    // DOM 快照 / 执行 JS / 监控 IPC）。仅 debug：release 构建里这段被 cfg 去掉。
    // 绑 127.0.0.1（默认是 0.0.0.0），避免把调试端口 9223 暴露到局域网。
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    builder
        .invoke_handler(tauri::generate_handler![
            list_projects,
            list_sessions,
            read_session,
            watch_session,
            unwatch_session,
            session_usage,
            agent_stats,
            start_agent_stats,
            cancel_stats,
            search_sessions,
            cancel_search,
            rename_session,
            soft_delete_session,
            list_trash,
            restore_session,
            permanent_delete_trash,
            empty_trash,
            resume_session,
            new_session,
            detect_terminals,
            pty_spawn,
            pty_spawn_new,
            pty_write,
            pty_resize,
            pty_kill,
            reveal_in_finder,
            open_url,
            write_file,
            add_bookmark,
            remove_bookmark,
            app_version,
            refresh_pricing,
            pricing_status,
            list_pricing,
        ])
        .setup(|app| {
            // 启动期后台拉一次 LiteLLM 模型价格表，新模型上架不必发版。
            // 不阻塞 setup —— init() 自己 spawn 后台线程，离线 / 失败时 lookup 自动落回
            // hardcoded 兜底表。
            stats::pricing::init();

            // 原生应用菜单 —— 主要价值在 macOS 顶部菜单栏。
            // Windows / Linux 也会挂菜单，但视觉上不那么重要。
            menu::build(app.handle())?;
            menu::install_bridges(app.handle());

            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                // 菜单栏托盘图标 + 菜单（Show / Settings / Quit）。
                tray::build(app.handle())?;

                if let Some(win) = app.get_webview_window("main") {
                    pin_traffic_lights(&win);
                    // AppKit relays out standard window buttons on resize,
                    // so re-pin then. Avoid Focused / ThemeChanged: AppKit
                    // does NOT recreate the buttons on those events, and
                    // running Objective-C work inside the Focused handler
                    // can race the click→drag transition and break titlebar
                    // dragging when focusing the window from a click.
                    let win_clone = win.clone();
                    win.on_window_event(move |e| match e {
                        tauri::WindowEvent::Resized(_) => pin_traffic_lights(&win_clone),
                        // Close-to-tray：红灯 / ⌘W 不退出，藏到菜单栏，仍可从托盘
                        // "Show" 唤回；真正退出走托盘 "Quit" 或 ⌘Q。
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = win_clone.hide();
                        }
                        _ => {}
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Dock 图标点击（macOS Reopen）：close-to-tray 把窗口藏起来后，点 Dock
            // 图标应能唤回它，否则只能从托盘菜单 "Show"。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                use tauri::Manager;
                if let Some(win) = _app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
}
