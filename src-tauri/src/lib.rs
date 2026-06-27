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
mod agent_chat;
pub mod agents;
mod agent_command;
mod bookmarks;
#[cfg(target_os = "macos")]
mod menu;
mod pty;
pub mod stats;
#[cfg(target_os = "macos")]
mod tray;
mod trash;
mod turn;
mod types;
mod usage_api;
mod util;
mod watch;

use std::fs;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::agent_command::AgentCommand;
use crate::types::{
    AgentStats, Msg, ProjectInfo, SearchHit, SessionPage, TrashItem, TrayStats, UsageSummary,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;
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
            parent_dir_name: None,
            worktree_name: None,
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

#[tauri::command]
fn terminal_turn_signal(
    app: tauri::AppHandle,
    agent: String,
    path: String,
    state: String,
) -> Result<(), String> {
    turn::emit_turn_signal(
        &app,
        turn::TerminalTurnPayload {
            agent,
            path,
            state,
        },
    )
}

#[tauri::command]
fn install_claude_turn_hooks() -> Result<String, String> {
    turn::install_claude_hooks()
}

#[tauri::command]
fn watch_session_turn(
    app: tauri::AppHandle,
    agent: String,
    path: String,
    catch_up: bool,
) -> Result<(), String> {
    turn::watch_session_turn(app, agent, path, catch_up)
}

#[tauri::command]
fn unwatch_session_turn(path: String) -> Result<(), String> {
    turn::unwatch_session_turn(path)
}

/// 单个会话的 token 用量汇总（按 path + mtime 缓存）。
/// 前端 ChatTopbar / SessionsView 卡片懒加载这条；Gemini 暂占位返零。
#[tauri::command]
fn session_usage(agent: String, path: String) -> Result<UsageSummary, String> {
    let src = agents::source(&agent)?;
    agents::session_usage(&*src, &path)
}

/// 「当前上下文」用量 —— 取会话最后一条 usage（≈末尾上下文规模），而非全程累加。
/// 续聊（resume）时前端拿它给上下文进度角标做种子，否则刚切过去会显示 0% 与 TUI 不符。
#[tauri::command]
fn session_context_usage(agent: String, path: String) -> Result<UsageSummary, String> {
    let src = agents::source(&agent)?;
    src.context_usage(&path)
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
async fn search_sessions(
    agent: String,
    query: String,
    request_id: u64,
    project_key: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        SEARCH_GEN.store(request_id, std::sync::atomic::Ordering::SeqCst);
        let src = agents::source(&agent)?;
        let cancel = agents::Cancel {
            request_id,
            gen: &SEARCH_GEN,
        };
        agents::search(&*src, &query, project_key.as_deref(), cancel)
    })
    .await
    .map_err(|e| format!("search task panicked: {e}"))?
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
        return Err("Session file does not exist".to_string());
    }
    if !is_jsonl(&fp) {
        return Err("Not a JSONL file".to_string());
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
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    app: tauri::AppHandle,
    agent: String,
    session_id: String,
    cwd: String,
    path: String,
    cols: u16,
    rows: u16,
    extra_args: String,
    color_scheme: Option<String>,
) -> Result<u64, String> {
    if !Path::new(&cwd).is_dir() {
        return Err("Project directory no longer exists".to_string());
    }
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid session ID".to_string());
    }
    let command = agents::source(&agent)?.resume_command(&session_id, &path).with_extra_args(&extra_args);
    pty::spawn(app, cwd, command, cols, rows, color_scheme.as_deref())
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
    color_scheme: Option<String>,
) -> Result<u64, String> {
    if !Path::new(&cwd).is_dir() {
        return Err("Project directory no longer exists".to_string());
    }
    let command = agents::source(&agent)?.new_session_command().with_extra_args(&extra_args);
    pty::spawn(app, cwd, command, cols, rows, color_scheme.as_deref())
}

/// 启动一个纯 shell PTY（不跑任何 agent CLI），用于在项目目录里执行任意命令。
#[tauri::command]
fn pty_spawn_shell(
    app: tauri::AppHandle,
    cwd: String,
    cols: u16,
    rows: u16,
    color_scheme: Option<String>,
) -> Result<u64, String> {
    if !Path::new(&cwd).is_dir() {
        return Err("Project directory no longer exists".to_string());
    }
    pty::spawn_shell(app, cwd, cols, rows, color_scheme.as_deref())
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

// ---------- 程序化聊天（GUI chat）：管道子进程跑 stream-json ----------

/// model / effort flag 值的轻校验：非空、≤64、仅 `[A-Za-z0-9._:-]`。值最终经
/// `AgentCommand` 的 posix_quote 安全转义（不会注入），这里只是额外挡掉明显垃圾，
/// 并与前端候选列表对齐。低 / 高 / xhigh / max / minimal、gpt-5.1-codex-max 等均通过。
fn valid_flag_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// 权限模式允许列表（会进 shell 命令；虽已 posix_quote，仍只放行已知值）。
/// 对齐 `claude --permission-mode` 的 choices（含 auto / dontAsk）。
fn valid_permission_mode(mode: &str) -> bool {
    matches!(
        mode,
        "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions"
    )
}

/// 启动一个 GUI chat 子进程，返回 chat id + 进程模型。`session_id` 给出时续聊既有
/// 会话；`permission_mode` / `model` / `effort` 走校验后透传给 CLI（默认 acceptEdits，
/// model/effort 为空走 CLI 自身默认）。
#[tauri::command]
fn agent_chat_start(
    app: tauri::AppHandle,
    agent: String,
    cwd: String,
    session_id: Option<String>,
    permission_mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<crate::types::ChatStartInfo, String> {
    if !Path::new(&cwd).is_dir() {
        return Err("Project directory no longer exists".to_string());
    }
    // 续聊时校验 session id（会被拼进 --resume）。新开会话 session_id 为空。
    if let Some(id) = session_id.as_deref() {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Invalid session ID".to_string());
        }
    }
    let mode = permission_mode.unwrap_or_else(|| "acceptEdits".to_string());
    if !valid_permission_mode(&mode) {
        return Err("Invalid permission mode".to_string());
    }
    if let Some(m) = model.as_deref() {
        if !valid_flag_token(m) {
            return Err("Invalid model".to_string());
        }
    }
    if let Some(e) = effort.as_deref() {
        if !valid_flag_token(e) {
            return Err("Invalid effort".to_string());
        }
    }
    // 进程模型在 start 移走 agent 之前算（前端据此决定切设置走 restart 还是下轮 flag）。
    let process_model = agents::source(&agent)?.chat_process_model().as_str().to_string();
    let chat_id = agent_chat::start(app, agent, cwd, session_id, mode, model, effort)?;
    Ok(crate::types::ChatStartInfo { chat_id, process_model })
}

/// 向某个 chat 子进程发送一条用户消息（含可选图片附件 + 本轮的 model/effort/权限）。
/// one-shot agent（Codex）据此每轮切换；长驻 agent（Claude）这三者在 start 已定型，
/// 后端忽略（切换走 restart-with-resume）。
#[tauri::command]
fn agent_chat_send(
    id: u64,
    text: String,
    images: Option<Vec<crate::types::ChatImageInput>>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
) -> Result<(), String> {
    if let Some(m) = model.as_deref() {
        if !valid_flag_token(m) {
            return Err("Invalid model".to_string());
        }
    }
    if let Some(e) = effort.as_deref() {
        if !valid_flag_token(e) {
            return Err("Invalid effort".to_string());
        }
    }
    let mode = permission_mode.unwrap_or_else(|| "acceptEdits".to_string());
    if !valid_permission_mode(&mode) {
        return Err("Invalid permission mode".to_string());
    }
    agent_chat::send(
        id,
        &text,
        &images.unwrap_or_default(),
        model.as_deref(),
        effort.as_deref(),
        &mode,
    )
}

/// 结束一个 chat 子进程（kill + 回收）。幂等。
#[tauri::command]
fn agent_chat_stop(id: u64) -> Result<(), String> {
    agent_chat::stop(id)
}

/// GUI chat 输入框 `/` 浮层的动态指令列表（扫磁盘自定义命令 / user-invocable skills）。
#[tauri::command]
fn agent_chat_slash_commands(
    agent: String,
    cwd: String,
) -> Result<Vec<crate::types::SlashCommand>, String> {
    Ok(agents::source(&agent)?.chat_slash_commands(&cwd))
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
        return Err("Project directory no longer exists".to_string());
    }
    // id 校验：Claude/Codex 为 UUID，Gemini 为 session-<startTime>-<id8>
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid session ID".to_string());
    }
    let command = agents::source(&agent)?.resume_command(&session_id, &path).with_extra_args(&extra_args);
    spawn_terminal(&command, &cwd, &terminal_app)
}

/// 在终端里为某个项目目录开一个全新会话（不带 --resume）。
#[tauri::command]
fn new_session(agent: String, cwd: String, extra_args: String, terminal_app: String) -> Result<(), String> {
    if !Path::new(&cwd).is_dir() {
        return Err("Project directory no longer exists".to_string());
    }
    let command = agents::source(&agent)?.new_session_command().with_extra_args(&extra_args);
    spawn_terminal(&command, &cwd, &terminal_app)
}

/// 通过用户登录 shell 解析命令的完整路径。
/// 打包后的 .app 不继承用户 PATH，直接 `Command::new("cmux")` 会 ENOENT。
/// 对于 macOS GUI app（如 cmux），登录 shell 也可能找不到 —— 用已知安装路径兜底。
#[cfg(unix)]
fn resolve_bin(name: &str) -> Result<PathBuf, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", &format!("which {name}")])
        .output()
        .map_err(|e| format!("Failed to resolve {name} via shell: {e}"))?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !path.is_empty() {
        return Ok(PathBuf::from(path));
    }
    // macOS GUI app 内置的 CLI 二进制不在 PATH 里 —— 逐个检查已知路径。
    let known_paths: &[&str] = match name {
        "cmux" => &["/Applications/cmux.app/Contents/Resources/bin/cmux"],
        _ => &[],
    };
    for p in known_paths {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }
    Err(format!("{name} not found — make sure it is installed and in your PATH"))
}

#[cfg(target_os = "macos")]
fn create_terminal_script(tab_name: &str, shell_cmd: &str) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join("cc-sessions-viewer");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let path = dir.join(format!("resume-{}.command", std::process::id()));
    let content = format!(
        "#!/bin/zsh\n\
         printf '\\033]0;{tab_name}\\007'\n\
         {shell_cmd}\n"
    );
    fs::write(&path, &content).map_err(|e| format!("Failed to write script: {e}"))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("Failed to set permissions: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn spawn_terminal(command: &AgentCommand, cwd: &str, _terminal_app: &str) -> Result<(), String> {
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
        let cli = command.to_posix_shell();
        let shell_cmd = format!("cd {} && {}", crate::agent_command::posix_quote(cwd), cli);

        match _terminal_app {
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
                    .arg(&cli)
                    .spawn()
                    .map_err(|e| format!("Failed to launch Ghostty: {e}"))?;
            }
            "cmux" => {
                let cmux_bin = resolve_bin("cmux")?;
                let found_ref = std::process::Command::new(&cmux_bin)
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
                    // 从结构化参数提取会话 ID（UUID-like token）用于去重。
                    let session_id = command_session_id(command);

                    // 检查 workspace 里是否已有运行这个会话的 surface
                    let existing_surface = session_id.and_then(|sid| {
                        let o = std::process::Command::new(&cmux_bin)
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
                        let _ = std::process::Command::new(&cmux_bin)
                            .args(["workspace", "select", &ws_ref])
                            .output();
                        let _ = std::process::Command::new(&cmux_bin)
                            .args([
                                "rpc",
                                "surface.focus",
                                &format!("{{\"workspace_id\":\"{ws_ref}\",\"surface_id\":\"{surface_ref}\"}}"),
                            ])
                            .output();
                        let _ = std::process::Command::new(&cmux_bin)
                            .args(["trigger-flash", "--workspace", &ws_ref, "--surface", &surface_ref])
                            .spawn();
                    } else {
                        // 新开 split
                        let _ = std::process::Command::new(&cmux_bin)
                            .args(["workspace", "select", &ws_ref])
                            .output();

                        let split_dir = std::process::Command::new(&cmux_bin)
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

                        let _ = std::process::Command::new(&cmux_bin)
                            .args(["new-split", split_dir, "--workspace", &ws_ref, "--focus", "true"])
                            .output();
                        let _ = std::process::Command::new(&cmux_bin)
                            .args(["send", "--workspace", &ws_ref, cli.as_str()])
                            .output();
                        std::process::Command::new(&cmux_bin)
                            .args(["send-key", "--workspace", &ws_ref, "enter"])
                            .spawn()
                            .map_err(|e| format!("Failed to launch cmux: {e}"))?;
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
                        cli.as_str(),
                        "--focus",
                        "true",
                    ];
                    if !ws_name.is_empty() {
                        args.push("--name");
                        args.push(&ws_name);
                    }
                    std::process::Command::new(&cmux_bin)
                        .args(&args)
                        .spawn()
                        .map_err(|e| format!("Failed to launch cmux: {e}"))?;
                }
            }
            // iTerm2 / Warp / Terminal.app: 写临时脚本 + open -a，不需要辅助功能权限
            _ => {
                let app_name = match _terminal_app {
                    "iterm2" => "iTerm",
                    "warp" => "Warp",
                    _ => "Terminal",
                };
                let tab_name = Path::new(cwd)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let script_path = create_terminal_script(&tab_name, &shell_cmd)?;
                std::process::Command::new("open")
                    .args(["-a", app_name, &script_path])
                    .spawn()
                    .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let ps_cmd = crate::agent_command::powershell_set_location_and_run(cwd, command);
        let encoded = crate::agent_command::powershell_encoded_command(&ps_cmd);
        std::process::Command::new("cmd")
            .args(["/c", "start", "", "powershell.exe", "-NoExit", "-EncodedCommand", &encoded])
            .env("PATH", crate::agent_command::merged_system_path())
            .spawn()
            .map_err(|e| format!("Failed to launch terminal: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let shell_cmd = format!("cd {} && {}", crate::agent_command::posix_quote(cwd), command.to_posix_shell());
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
            return Err("No terminal emulator found".to_string());
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn command_session_id(command: &AgentCommand) -> Option<&str> {
    command.args().iter().find_map(|arg| {
        (arg.len() > 8
            && arg.contains('-')
            && arg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then_some(arg.as_str())
    })
}

/// 检测 macOS 上已安装的外部终端应用。返回可用终端 key 列表（不含 terminal —— 那个始终可用）。
#[tauri::command]
fn detect_terminals() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let mut found = Vec::new();
        if Path::new("/Applications/iTerm.app").exists() {
            found.push("iterm2".to_string());
        }
        if Path::new("/Applications/Ghostty.app").exists() {
            found.push("ghostty".to_string());
        }
        if Path::new("/Applications/cmux.app").exists() {
            found.push("cmux".to_string());
        }
        if Path::new("/Applications/Warp.app").exists() {
            found.push("warp".to_string());
        }
        found
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[tauri::command]
fn add_bookmark(agent: String, path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("Directory does not exist".to_string());
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

/// 把原生窗口外观（标题栏 / 失焦时的红绿灯灰圈）同步到 App 内主题。
///
/// 此前原生外观只跟随 macOS 系统：浅色 App 主题下窗口失焦时，三个交通灯被画成浅灰，
/// 叠在同样浅色的自定义顶栏上几乎看不见（深色主题下灰圈对比够，所以正常）。把窗口
/// appearance 钉到当前主题后，深/浅两态都有正确对比。`theme=None`（系统模式）则交还
/// 系统自动跟随，避免破坏 webview 内 prefers-color-scheme 的自动切换。
#[tauri::command]
fn set_titlebar_theme(window: tauri::WebviewWindow, theme: Option<String>) {
    let t = match theme.as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };
    let _ = window.set_theme(t);
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
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
        }
    }
    fs::write(&p, content).map_err(|e| format!("Failed to write file: {e}"))?;
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
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.replace('/', "\\")))
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
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
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }
    Ok(())
}

/// 在系统默认浏览器中打开一个外部链接。只放行 http/https，避免 url 被
/// 当成本地文件或其它协议处理。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http(s) URLs are supported".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    Ok(())
}

fn path_env_candidates() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default()
}

fn find_in_path(bin: &str) -> Option<PathBuf> {
    let candidates = path_env_candidates();
    #[cfg(target_os = "windows")]
    let exts: Vec<OsString> = std::env::var_os("PATHEXT")
        .map(|v| {
            v.to_string_lossy()
                .split(';')
                .filter(|s| !s.is_empty())
                .map(OsString::from)
                .collect()
        })
        .unwrap_or_else(|| vec![OsString::from(".exe"), OsString::from(".cmd"), OsString::from(".bat")]);
    #[cfg(not(target_os = "windows"))]
    let exts: Vec<OsString> = vec![OsString::new()];

    for dir in candidates {
        for ext in &exts {
            let cand = if ext.is_empty() {
                dir.join(bin)
            } else {
                dir.join(format!("{bin}{}", ext.to_string_lossy()))
            };
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

fn parse_local_target(input: &str) -> (String, Option<u32>, Option<u32>) {
    let trimmed = input.trim();
    let parts: Vec<&str> = trimmed.rsplitn(3, ':').collect();
    if parts.len() >= 2 {
        if let Ok(last) = parts[0].parse::<u32>() {
            let base_one = parts[1..].iter().rev().copied().collect::<Vec<_>>().join(":");
            let base_one_path = Path::new(&base_one);
            if base_one_path.is_absolute() || base_one_path.exists() {
                if parts.len() == 3 {
                    if let Ok(mid) = parts[1].parse::<u32>() {
                        let base_two = parts[2];
                        let base_two_path = Path::new(base_two);
                        if base_two_path.is_absolute() || base_two_path.exists() {
                            return (base_two.to_string(), Some(mid), Some(last));
                        }
                    }
                }
                return (base_one, Some(last), None);
            }
        }
    }
    (trimmed.to_string(), None, None)
}

fn open_with_editor(path: &str, line: Option<u32>, column: Option<u32>) -> Result<bool, String> {
    let Some(line) = line else {
        return Ok(false);
    };
    let column = column.unwrap_or(1);

    let specs: &[(&str, &[&str])] = &[
        ("cursor", &["-g"]),
        ("code", &["-g"]),
        ("code-insiders", &["-g"]),
        ("codium", &["-g"]),
        ("windsurf", &["-g"]),
        ("zed", &[]),
        ("subl", &[]),
        ("mate", &["-l"]),
        ("bbedit", &[]),
    ];

    for (bin, prefix) in specs {
        let Some(found) = find_in_path(bin) else {
            continue;
        };
        let mut cmd = std::process::Command::new(found);
        for arg in *prefix {
            cmd.arg(arg);
        }
        match *bin {
            "mate" => {
                cmd.arg(line.to_string()).arg(path);
            }
            "bbedit" => {
                cmd.arg(format!("+{line}")).arg(path);
            }
            "zed" | "subl" => {
                cmd.arg(format!("{path}:{line}:{column}"));
            }
            _ => {
                cmd.arg(format!("{path}:{line}:{column}"));
            }
        }
        match cmd.spawn() {
            Ok(_) => return Ok(true),
            Err(err) => return Err(format!("Failed to launch editor: {err}")),
        }
    }
    Ok(false)
}

/// 打开本地文件。若 path 形如 `/abs/file:12:3`，会尽量让编辑器定位到该行列。
#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    let (file_path, line, column) = parse_local_target(&path);
    let target = PathBuf::from(&file_path);

    if !target.is_absolute() {
        return Err("Only absolute paths are supported".to_string());
    }

    if open_with_editor(&file_path, line, column)? {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open local file: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("Failed to open local file: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to open local file: {e}"))?;
    }
    Ok(())
}

/// 手动从 models.dev 上游拉一次模型价格表，覆盖本地 24h 缓存。前端 Settings
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

/// 账号额度（5 小时 / 周 / 各模型分项）—— 走 Claude OAuth 用量接口，返回每个窗口的
/// 精确利用率 + 重置时间。前端底栏据此渲染 5h / 周徽标（随时精确，不依赖越阈值事件）。
/// async + spawn_blocking：内部 `curl` 子进程是同步阻塞，不能霸占 webview 主线程。
/// `force=true`：绕过 20s 缓存强制拉新（事件驱动刷新 —— 一轮对话结束后用，确保拿到刚变化的值）。
#[tauri::command]
async fn account_usage(force: Option<bool>) -> Result<usage_api::AccountUsage, String> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || usage_api::account_usage_blocking(force))
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// 托盘弹窗用的快速统计：一次扫描三个时间窗口，返回 per-agent 的 token + cost。
/// async + spawn_blocking —— 扫描耗时取决于会话数量（几百毫秒到几秒），不能阻塞主线程。
#[tauri::command]
async fn tray_quick_stats() -> Result<TrayStats, String> {
    tauri::async_runtime::spawn_blocking(stats::tray::quick_stats)
        .await
        .map_err(|e| format!("join: {e}"))?
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // 开发期注入 MCP Bridge —— 让 AI 助手经 WebSocket 直接看/控这个 app（截图 /
    // DOM 快照 / 执行 JS / 监控 IPC）。feature "dev-mcp"（default 但 release
    // 构建通过 --no-default-features 排除）控制是否编译链接。
    // 绑 127.0.0.1（默认是 0.0.0.0），避免把调试端口 9223 暴露到局域网。
    #[cfg(feature = "dev-mcp")]
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
            terminal_turn_signal,
            install_claude_turn_hooks,
            watch_session_turn,
            unwatch_session_turn,
            session_usage,
            session_context_usage,
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
            pty_spawn_shell,
            pty_write,
            pty_resize,
            pty_kill,
            agent_chat_start,
            agent_chat_send,
            agent_chat_stop,
            agent_chat_slash_commands,
            reveal_in_finder,
            open_local_path,
            open_url,
            write_file,
            set_titlebar_theme,
            add_bookmark,
            remove_bookmark,
            app_version,
            refresh_pricing,
            pricing_status,
            list_pricing,
            account_usage,
            tray_quick_stats,
        ])
        .setup(|app| {
            // 启动期后台拉一次 models.dev 模型价格表，新模型上架不必发版。
            // 不阻塞 setup —— init() 自己 spawn 后台线程，离线 / 失败时先用过期
            // 磁盘缓存兜着，前端按 pricing_status 渲染 error placeholder。
            stats::pricing::init();
            if let Err(e) = turn::start_signal_watcher(app.handle().clone()) {
                eprintln!("turn signal watcher failed: {e}");
            }

            #[cfg(target_os = "windows")]
            {
                crate::agent_command::warm_merged_system_path_cache();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
                }
            }

            #[cfg(target_os = "macos")]
            {
                // 原生应用菜单只保留给 macOS。Windows 的窗口内菜单栏会挤占
                // 自定义顶栏，视觉上和 WebView command bar 重复。
                menu::build(app.handle())?;
                menu::install_bridges(app.handle());

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
                if let Some(win) = _app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
}
