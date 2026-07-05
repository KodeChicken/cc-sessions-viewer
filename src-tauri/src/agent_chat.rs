// 程序化聊天（GUI chat）—— 用纯管道子进程跑 agent 的 headless stream-json 模式，
// 逐行读 JSON 事件直接喂给前端复用的 `Block`/ChatView 渲染。
//
// 与 `pty.rs` 的关系：
//   - pty.rs 服务「窗口内 TUI resume / shell」—— 走伪终端，处理 ANSI / 光标，给 xterm。
//   - agent_chat.rs 服务「干净聊天框」—— 走 `Stdio::piped()` 纯管道，没有 TUI 控制字符，
//     stdout 每一行是一个 JSON 事件，由各 agent 的 `parse_chat_line` 归一成 `ChatEvent`。
//   两者并存，互不影响；结构刻意对齐（HashMap<id, Arc<Handle>> + reader/waiter 线程）。
//
// 设计：
//   - 通过用户登录 shell 拉起 CLI（`$SHELL -l -i -c "cd '<cwd>' && <cli>"` / powershell），
//     与 pty.rs 同款，确保 nvm / fnm / volta / npm-global 的 PATH 都能拿到 claude。
//   - stdin 持续喂 `{"type":"user","message":{...}}`（含可选 image 块）；进程长驻直到 stdin
//     关闭 / 被 kill。
//   - reader 线程逐行读 stdout → `source.parse_chat_line(line)` → emit 对应事件。
//   - stderr 线程收诊断行（emit `agent-chat://stderr`，便于排障）。
//   - waiter 线程 try_wait 退出码后 emit 一次 `agent-chat://exit` 并清理。
//
// 前端事件契约：
//   agent-chat://event   { chatId, msg }              一条解析好的 Msg（assistant / tool_result）
//   agent-chat://init    { chatId, sessionId }        子进程报告的 session id（定位 JSONL / 续聊）
//   agent-chat://result  { chatId, ok, usage }        一轮回答结束（驱动 turn 门控）
//   agent-chat://stderr  { chatId, line }             子进程 stderr 诊断行
//   agent-chat://exit    { chatId, code }             子进程退出
//
// webview 刷新时后端进程不杀 —— 前端重连（list_running_chats → reconnect）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agent_command::AgentCommand;
use crate::agents::{self, ChatEvent, ChatProcessModel};
use crate::types::{ChatImageInput, UsageSummary};

/// 一个 chat「会话」的句柄。两种进程模型对应两个变体（见 [`ChatProcessModel`]）。
#[allow(clippy::large_enum_variant)]
enum ChatHandle {
    /// 长驻进程（Claude）：start 时 spawn，send 写 stdin，waiter 监控退出。
    LongLived {
        /// 该会话的 agent —— send 时据此取 `chat_encode_input`。
        agent: String,
        /// 写端：用户消息 JSON 逐行写进来；Mutex 保护并发输入。
        stdin: Mutex<ChildStdin>,
        /// 子进程句柄：stop 时 kill；waiter 线程走短锁 try_wait 避免长占。
        child: Mutex<Child>,
    },
    /// 一轮一进程（Codex）：start 不 spawn，send 时 spawn 一个 resume 进程。
    OneShot {
        /// 用于 send 时 spawn turn 进程 + emit 事件。
        app: AppHandle,
        agent: String,
        cwd: String,
        /// 上一轮回填的 session/thread id —— 下一轮 resume 用。
        session_id: Mutex<Option<String>>,
        /// 当前在跑的那一轮子进程（stop 时 kill）。
        current: Mutex<Option<Child>>,
        use_reclaude: bool,
    },
}

struct ChatMeta {
    agent: String,
    project_key: String,
    cwd: String,
    session_id: Mutex<Option<String>>,
    permission_mode: String,
    model: Option<String>,
    effort: Option<String>,
    process_model: String,
}

type ChatEntry = (Arc<ChatHandle>, Arc<ChatMeta>);

static CHATS: OnceLock<Mutex<HashMap<u64, ChatEntry>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn map() -> &'static Mutex<HashMap<u64, ChatEntry>> {
    CHATS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InitPayload {
    chat_id: u64,
    session_id: Option<String>,
    /// Claude init 的 apiKeySource：前端据此判断是否隐藏 5h/周限额角标（见 ChatEvent::Init）。
    api_key_source: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResultPayload {
    chat_id: u64,
    ok: bool,
    usage: Option<UsageSummary>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StderrPayload {
    chat_id: u64,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    chat_id: u64,
    code: i32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PermissionPayload {
    chat_id: u64,
    request: crate::types::ChatPermissionRequest,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QuestionPayload {
    chat_id: u64,
    request: crate::types::ChatQuestionRequest,
}

/// 按 OS 组装管道子进程命令。与 `pty.rs::build_shell_command` 同款 PATH 策略，只是
/// 改用 `std::process::Command` + 三路管道（无 PTY）。
///
/// `use_reclaude`：用 reclaude 做进程包装器（`reclaude claude --print ...`），
/// 走 reclaude 守护进程的鉴权 + 代理链路。与 IDE 插件的 "Claude Process Wrapper" 同理。
#[cfg(unix)]
fn build_piped_command(cwd: &str, command: &AgentCommand, use_reclaude: bool) -> std::process::Command {
    #[cfg(target_os = "macos")]
    const DEFAULT_SHELL: &str = "/bin/zsh";
    #[cfg(not(target_os = "macos"))]
    const DEFAULT_SHELL: &str = "/bin/bash";

    let shell = std::env::var("SHELL").unwrap_or_else(|_| DEFAULT_SHELL.to_string());
    let cli = if use_reclaude {
        format!("'reclaude' {}", command.to_posix_shell())
    } else {
        command.to_posix_shell()
    };
    let inner = format!(
        "cd {} && {}",
        crate::agent_command::posix_quote(cwd),
        cli
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-l").arg("-i").arg("-c").arg(&inner);
    cmd.env_remove("npm_config_prefix");
    cmd.current_dir(cwd);
    cmd
}

#[cfg(windows)]
fn build_piped_command(cwd: &str, command: &AgentCommand, use_reclaude: bool) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.arg("-NoLogo")
        .arg("-Command")
        .arg(crate::agent_command::powershell_set_location_and_run(cwd, command, use_reclaude));
    cmd.current_dir(cwd);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn read_reclaude_port(path: &std::path::Path) -> Option<u16> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let running = v.pointer("/daemon/running")?.as_bool()?;
    if !running {
        return None;
    }
    v.pointer("/daemon/port")?.as_u64().map(|p| p as u16)
}

pub fn reclaude_info() -> crate::types::ReclaudeInfo {
    let base = crate::util::home().join(".reclaude");
    if !base.is_dir() {
        return crate::types::ReclaudeInfo {
            installed: false,
            daemon_running: false,
            daemon_port: None,
        };
    }
    let state_path = base.join("state.json");
    let port = read_reclaude_port(&state_path);
    crate::types::ReclaudeInfo {
        installed: true,
        daemon_running: port.is_some(),
        daemon_port: port,
    }
}

/// 起一个 chat「会话」。`session_id` 给出时续聊既有会话；否则新开。返回内部 chat id。
/// 按该 agent 的 [`ChatProcessModel`] 选驱动路径：
///   - LongLivedStdin：spawn 一个长驻进程 + reader/stderr/waiter 线程（现状）。
///   - OneShotResume：**不 spawn**，只登记会话；首条 `send` 才起「这一轮」的进程。
#[allow(clippy::too_many_arguments)]
pub fn start(
    app: AppHandle,
    agent: String,
    project_key: String,
    cwd: String,
    session_id: Option<String>,
    permission_mode: String,
    model: Option<String>,
    effort: Option<String>,
    fork: bool,
    use_reclaude: bool,
) -> Result<u64, String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("项目目录已不存在，无法启动聊天".into());
    }
    let source = agents::source(&agent)?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let pm_str = match source.chat_process_model() {
        ChatProcessModel::LongLivedStdin => "longLived",
        ChatProcessModel::OneShotResume => "oneShot",
    };
    let meta = Arc::new(ChatMeta {
        agent: agent.clone(),
        project_key,
        cwd: cwd.clone(),
        session_id: Mutex::new(session_id.clone()),
        permission_mode: permission_mode.clone(),
        model: model.clone(),
        effort: effort.clone(),
        process_model: pm_str.to_string(),
    });

    match source.chat_process_model() {
        ChatProcessModel::LongLivedStdin => {
            let command = source
                .chat_command(
                    session_id.as_deref(),
                    &permission_mode,
                    model.as_deref(),
                    effort.as_deref(),
                    fork,
                )
                .ok_or_else(|| format!("{agent} 暂不支持 GUI 聊天模式"))?;

            let mut cmd = build_piped_command(&cwd, &command, use_reclaude);
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
            let stdin = child.stdin.take().ok_or("failed to capture stdin")?;
            let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
            let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

            let handle = Arc::new(ChatHandle::LongLived {
                agent: agent.clone(),
                stdin: Mutex::new(stdin),
                child: Mutex::new(child),
            });
            map().lock().map_err(|e| e.to_string())?.insert(id, (handle, meta.clone()));

            let meta_for_reader = meta;
            let app_for_reader = app.clone();
            let agent_for_reader = agent.clone();
            thread::spawn(move || reader_loop(app_for_reader, id, agent_for_reader, stdout, meta_for_reader));
            spawn_stderr_pump(app.clone(), id, stderr);
            let app_for_wait = app.clone();
            thread::spawn(move || waiter_loop(app_for_wait, id));
        }
        ChatProcessModel::OneShotResume => {
            if source
                .chat_turn_command(session_id.as_deref(), "", &permission_mode, None, None)
                .is_none()
            {
                return Err(format!("{agent} 暂不支持 GUI 聊天模式"));
            }
            let handle = Arc::new(ChatHandle::OneShot {
                app: app.clone(),
                agent: agent.clone(),
                cwd: cwd.clone(),
                session_id: Mutex::new(session_id),
                current: Mutex::new(None),
                use_reclaude,
            });
            map().lock().map_err(|e| e.to_string())?.insert(id, (handle, meta));
        }
    }

    Ok(id)
}

/// stderr 诊断行透传线程 —— 两条路径共用（长驻进程 / 每轮进程都有 stderr）。
fn spawn_stderr_pump(app: AppHandle, id: u64, stderr: std::process::ChildStderr) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if app
                        .emit("agent-chat://stderr", StderrPayload { chat_id: id, line: trimmed })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}

fn reader_loop(app: AppHandle, id: u64, agent: String, stdout: std::process::ChildStdout, meta: Arc<ChatMeta>) {
    let Ok(source) = agents::source(&agent) else {
        return;
    };
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let emit_ok = match source.parse_chat_line(&line) {
            ChatEvent::Message(msg) => app
                .emit("agent-chat://event", EventPayload { chat_id: id, msg })
                .is_ok(),
            ChatEvent::Init {
                session_id,
                api_key_source,
            } => {
                if let Some(s) = session_id.as_ref() {
                    if let Ok(mut g) = meta.session_id.lock() {
                        *g = Some(s.clone());
                    }
                }
                app.emit(
                    "agent-chat://init",
                    InitPayload {
                        chat_id: id,
                        session_id,
                        api_key_source,
                    },
                )
                .is_ok()
            }
            ChatEvent::Result { ok, usage } => app
                .emit("agent-chat://result", ResultPayload { chat_id: id, ok, usage })
                .is_ok(),
            ChatEvent::Delta(delta) => app
                .emit("agent-chat://delta", DeltaPayload { chat_id: id, delta })
                .is_ok(),
            ChatEvent::Permission(request) => app
                .emit("agent-chat://permission", PermissionPayload { chat_id: id, request })
                .is_ok(),
            ChatEvent::Question(request) => app
                .emit("agent-chat://question", QuestionPayload { chat_id: id, request })
                .is_ok(),
            ChatEvent::Ignore => true,
        };
        if !emit_ok {
            break;
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    chat_id: u64,
    msg: crate::types::Msg,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    chat_id: u64,
    delta: crate::types::ChatDelta,
}

fn waiter_loop(app: AppHandle, id: u64) {
    loop {
        let res = {
            let arc = match map().lock().ok().and_then(|m| m.get(&id).map(|(h, _)| h.clone())) {
                Some(a) => a,
                None => return,
            };
            let ChatHandle::LongLived { child, .. } = &*arc else {
                return;
            };
            let mut child = match child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            child.try_wait()
        };
        match res {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                let _ = app.emit("agent-chat://exit", ExitPayload { chat_id: id, code });
                if let Ok(mut m) = map().lock() {
                    m.remove(&id);
                }
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(150)),
            Err(_) => {
                let _ = app.emit("agent-chat://exit", ExitPayload { chat_id: id, code: -1 });
                if let Ok(mut m) = map().lock() {
                    m.remove(&id);
                }
                return;
            }
        }
    }
}

/// 发送一条用户消息（含可选图片附件）。按进程模型分两条路：
///   - LongLived：用 `chat_encode_input` 编一行写进长驻进程 stdin。`model`/`effort`/
///     `permission_mode` 在 start 时已定型，此处忽略（切换走 restart-with-resume）。
///   - OneShot：spawn 一个 `chat_turn_command(...)` 进程跑这一轮 —— 三者每轮自带，
///     故模型 / effort / 权限切换免费即时生效（下一轮带新 flag）。
pub fn send(
    id: u64,
    text: &str,
    images: &[ChatImageInput],
    model: Option<&str>,
    effort: Option<&str>,
    permission_mode: &str,
) -> Result<(), String> {
    let arc = {
        let m = map().lock().map_err(|e| e.to_string())?;
        m.get(&id).map(|(h, _)| h.clone()).ok_or_else(|| "chat not found".to_string())?
    };
    if text.is_empty() && images.is_empty() {
        return Ok(()); // 空消息不发。
    }

    match &*arc {
        ChatHandle::LongLived { agent, stdin, .. } => {
            let source = agents::source(agent)?;
            let mut line = source.chat_encode_input(text, images);
            line.push('\n');
            let mut w = stdin.lock().map_err(|e| e.to_string())?;
            w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            w.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        ChatHandle::OneShot {
            app,
            agent,
            cwd,
            session_id,
            current,
            use_reclaude,
        } => {
            let source = agents::source(agent)?;
            let sid = session_id.lock().ok().and_then(|g| g.clone());
            // OneShot 的图片入参暂不处理：Codex 的 CLI 图片形态各异（多为文件路径
            // 而非 base64 arg），接具体 agent 时再补；这里只发文本 prompt。
            let command = source
                .chat_turn_command(sid.as_deref(), text, permission_mode, model, effort)
                .ok_or_else(|| format!("{agent} 暂不支持 GUI 聊天模式"))?;

            let mut cmd = build_piped_command(cwd, &command, *use_reclaude);
            cmd.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
            let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
            let stderr = child.stderr.take().ok_or("failed to capture stderr")?;
            // 记录在跑的这一轮（stop 时 kill）。
            if let Ok(mut g) = current.lock() {
                *g = Some(child);
            }
            spawn_stderr_pump(app.clone(), id, stderr);
            // 这一轮的 reader：读到退出；捕获 Init 回填 session_id 供下轮 resume；
            // 退出时若没见过 Result，补一条 Result{ok:false} 防止前端 turn 卡住。
            let app_for_reader = app.clone();
            let agent_for_reader = agent.clone();
            let arc_for_reader = arc.clone();
            thread::spawn(move || {
                oneshot_turn_reader(app_for_reader, id, agent_for_reader, stdout, arc_for_reader)
            });
            Ok(())
        }
    }
}

/// OneShot「这一轮」的 stdout reader：归一事件 → emit；`Init` 回填会话 session_id；
/// 进程退出（stdout EOF）时收尾 —— 没见过 `Result` 就补一条失败 Result，并清掉
/// `current`（该轮进程已结束）。**不** emit `exit`：one-shot 的「会话」要活到 stop。
fn oneshot_turn_reader(
    app: AppHandle,
    id: u64,
    agent: String,
    stdout: std::process::ChildStdout,
    arc: Arc<ChatHandle>,
) {
    let Ok(source) = agents::source(&agent) else {
        return;
    };
    let reader = BufReader::new(stdout);
    let mut saw_result = false;
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let emit_ok = match source.parse_chat_line(&line) {
            ChatEvent::Message(msg) => app
                .emit("agent-chat://event", EventPayload { chat_id: id, msg })
                .is_ok(),
            ChatEvent::Init {
                session_id,
                api_key_source,
            } => {
                if let (Some(s), ChatHandle::OneShot { session_id: slot, .. }) =
                    (session_id.as_ref(), &*arc)
                {
                    if let Ok(mut g) = slot.lock() {
                        *g = Some(s.clone());
                    }
                }
                app.emit(
                    "agent-chat://init",
                    InitPayload {
                        chat_id: id,
                        session_id,
                        api_key_source,
                    },
                )
                .is_ok()
            }
            ChatEvent::Result { ok, usage } => {
                saw_result = true;
                app.emit("agent-chat://result", ResultPayload { chat_id: id, ok, usage })
                    .is_ok()
            }
            // OneShot agent（Codex）目前不产 Delta；保留分支以满足穷尽匹配。
            ChatEvent::Delta(delta) => app
                .emit("agent-chat://delta", DeltaPayload { chat_id: id, delta })
                .is_ok(),
            // 交互式权限请求 / 结构化提问只在长驻 stdin 模型（Claude）出现；OneShot 没有可
            // 回写的长驻 stdin，故这里不该收到 —— 忽略即可（保持穷尽匹配）。
            ChatEvent::Permission(_) | ChatEvent::Question(_) => true,
            ChatEvent::Ignore => true,
        };
        if !emit_ok {
            break;
        }
    }
    // 该轮进程已退出。
    if !saw_result {
        let _ = app.emit(
            "agent-chat://result",
            ResultPayload { chat_id: id, ok: false, usage: None },
        );
    }
    if let ChatHandle::OneShot { current, .. } = &*arc {
        if let Ok(mut g) = current.lock() {
            // 回收该轮 child（已退出，wait 清掉僵尸）。
            if let Some(mut c) = g.take() {
                let _ = c.wait();
            }
        }
    }
}

/// 结束一个 chat 会话：先把 entry 拿走（waiter 下一轮发现不见了就 return，
/// 不再 emit 奇怪的 exit），再 kill + wait 回收，避免僵尸。幂等。
pub fn stop(id: u64) -> Result<(), String> {
    let entry = {
        let mut m = map().lock().map_err(|e| e.to_string())?;
        m.remove(&id)
    };
    let Some((arc, _meta)) = entry else {
        return Ok(());
    };
    match &*arc {
        ChatHandle::LongLived { child, .. } => {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        ChatHandle::OneShot { current, .. } => {
            // 杀掉当前在跑的那一轮（如果有）；没有在跑就只是从 map 摘除。
            if let Ok(mut g) = current.lock() {
                if let Some(mut c) = g.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }
    }
    Ok(())
}

/// 仅中断当前这轮生成，不结束 chat 会话本身。
/// Claude 长驻进程里这应等价于用户在 CLI 按一次 Esc：当前请求打断，但进程继续存活，下一条
/// 消息还能继续发。OneShot agent 没有长驻 stdin / 没有可复用会话进程，回退到 stop。
pub fn interrupt(id: u64) -> Result<(), String> {
    let arc = {
        let m = map().lock().map_err(|e| e.to_string())?;
        m.get(&id).map(|(h, _)| h.clone()).ok_or_else(|| "chat not found".to_string())?
    };
    match &*arc {
        ChatHandle::LongLived { stdin, .. } => {
            let mut w = stdin.lock().map_err(|e| e.to_string())?;
            w.write_all(&[0x1b]).map_err(|e| e.to_string())?;
            w.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        ChatHandle::OneShot { .. } => stop(id),
    }
}

/// 回写一次控制协议决定（响应 `can_use_tool`，覆盖工具权限与 AskUserQuestion 两类请求）。
/// 把前端构造好的 `decision`（`{behavior:"allow",updatedInput,...}` /
/// `{behavior:"deny",message,interrupt}`）包进 `control_response`，写进长驻进程的同一条 stdin
/// （与用户消息、Esc 同管道）：
///   `{"type":"control_response","response":{"subtype":"success","request_id":<id>,"response":<decision>}}`
/// 只有长驻 stdin 模型（Claude）有这条回路；OneShot 不产生此类请求，调用即报错。
fn respond_control(
    id: u64,
    request_id: &str,
    decision: serde_json::Value,
) -> Result<(), String> {
    let arc = {
        let m = map().lock().map_err(|e| e.to_string())?;
        m.get(&id).map(|(h, _)| h.clone()).ok_or_else(|| "chat not found".to_string())?
    };
    match &*arc {
        ChatHandle::LongLived { stdin, .. } => {
            let line = serde_json::json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": decision,
                }
            })
            .to_string();
            let mut w = stdin.lock().map_err(|e| e.to_string())?;
            w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            w.write_all(b"\n").map_err(|e| e.to_string())?;
            w.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        ChatHandle::OneShot { .. } => Err("此 agent 不支持交互式控制响应".into()),
    }
}

/// 回写一次交互式工具权限决定（响应 `agent-chat://permission`）。
pub fn respond_permission(
    id: u64,
    request_id: &str,
    decision: serde_json::Value,
) -> Result<(), String> {
    respond_control(id, request_id, decision)
}

/// 回写一次结构化提问的答案决定（响应 `agent-chat://question`）。`decision` 已由前端构造成
/// `{behavior:"allow",updatedInput:{questions,answers,response?}}`（作答）或
/// `{behavior:"deny",message,interrupt:false}`（取消，反馈给模型但不打断本轮）。
pub fn respond_question(
    id: u64,
    request_id: &str,
    decision: serde_json::Value,
) -> Result<(), String> {
    respond_control(id, request_id, decision)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunningChatInfo {
    pub chat_id: u64,
    pub agent: String,
    pub project_key: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub permission_mode: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub process_model: String,
}

pub fn list_running_chats() -> Vec<RunningChatInfo> {
    let guard = match map().lock() {
        Ok(g) => g,
        Err(_) => return vec![],
    };
    guard
        .iter()
        .map(|(id, (_handle, meta))| RunningChatInfo {
            chat_id: *id,
            agent: meta.agent.clone(),
            project_key: meta.project_key.clone(),
            cwd: meta.cwd.clone(),
            session_id: meta.session_id.lock().ok().and_then(|g| g.clone()),
            permission_mode: meta.permission_mode.clone(),
            model: meta.model.clone(),
            effort: meta.effort.clone(),
            process_model: meta.process_model.clone(),
        })
        .collect()
}
