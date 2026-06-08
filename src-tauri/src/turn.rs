use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
pub struct TerminalTurnPayload {
    pub agent: String,
    pub path: String,
    pub state: String,
}

struct SignalState {
    _watcher: RecommendedWatcher,
    path: PathBuf,
    offset: u64,
}

struct SessionTurnWatch {
    _watcher: RecommendedWatcher,
    agent: String,
    path: PathBuf,
    offset: u64,
}

static SIGNAL_STATE: OnceLock<Mutex<Option<SignalState>>> = OnceLock::new();
static SESSION_TURN_WATCHES: OnceLock<Mutex<HashMap<String, SessionTurnWatch>>> = OnceLock::new();

fn signal_state() -> &'static Mutex<Option<SignalState>> {
    SIGNAL_STATE.get_or_init(|| Mutex::new(None))
}

fn session_turn_watches() -> &'static Mutex<HashMap<String, SessionTurnWatch>> {
    SESSION_TURN_WATCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| "无法定位本地数据目录".to_string())?;
    Ok(base.join("cc-sessions-viewer"))
}

pub fn signal_file_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("turn-signals.jsonl"))
}

fn hook_script_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("claude-turn-signal-hook.cjs"))
}

const SESSION_TURN_POLL_MS: u64 = 1500;

pub fn emit_turn_signal(app: &AppHandle, payload: TerminalTurnPayload) -> Result<(), String> {
    if payload.agent != "claude" && payload.agent != "codex" && payload.agent != "gemini" {
        return Err("未知 agent".to_string());
    }
    if payload.path.trim().is_empty() {
        return Err("缺少会话路径".to_string());
    }
    if !matches!(
        payload.state.as_str(),
        "started" | "completed" | "blocked" | "failed"
    ) {
        return Err("未知会话状态".to_string());
    }
    app.emit("terminal-turn://state", payload)
        .map_err(|e| e.to_string())
}

pub fn start_signal_watcher(app: AppHandle) -> Result<(), String> {
    let signal_path = signal_file_path()?;
    if let Some(parent) = signal_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建状态目录失败: {e}"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&signal_path)
        .map_err(|e| format!("初始化状态文件失败: {e}"))?;

    let offset = fs::metadata(&signal_path).map(|m| m.len()).unwrap_or(0);
    let app_for_cb = app.clone();
    let path_for_cb = signal_path.clone();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |res: notify::Result<Event>| {
            let Ok(ev) = res else { return };
            if !matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                return;
            }
            process_signal_file(&app_for_cb, &path_for_cb);
        },
    )
    .map_err(|e| format!("turn signal watcher 初始化失败: {e}"))?;

    watcher
        .watch(&signal_path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("监听状态文件失败: {e}"))?;

    let mut slot = signal_state().lock().map_err(|e| e.to_string())?;
    *slot = Some(SignalState {
        _watcher: watcher,
        path: signal_path,
        offset,
    });
    Ok(())
}

pub fn watch_session_turn(
    app: AppHandle,
    agent: String,
    path: String,
    catch_up: bool,
) -> Result<(), String> {
    if agent != "codex" && agent != "gemini" {
        return Ok(());
    }
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    let offset = if catch_up {
        0
    } else {
        fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
    };
    let watch_root = p
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("无法确定父目录: {path}"))?;
    let app_for_cb = app.clone();
    let agent_for_cb = agent.clone();
    let agent_for_catchup = agent.clone();
    let path_for_cb = path.clone();
    let path_buf_for_cb = p.clone();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |res: notify::Result<Event>| {
            let Ok(ev) = res else { return };
            if !matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                return;
            }
            process_session_turn_file(&app_for_cb, &agent_for_cb, &path_for_cb, &path_buf_for_cb);
        },
    )
    .map_err(|e| format!("turn session watcher 初始化失败: {e}"))?;

    watcher
        .watch(&watch_root, RecursiveMode::NonRecursive)
        .map_err(|e| format!("监听会话状态失败: {e}"))?;

    let mut watches = session_turn_watches().lock().map_err(|e| e.to_string())?;
    watches.insert(
        path.clone(),
        SessionTurnWatch {
            _watcher: watcher,
            agent,
            path: p.clone(),
            offset,
        },
    );
    drop(watches);
    if catch_up {
        process_session_turn_file(&app, &agent_for_catchup, &path, &p);
    }
    start_session_turn_poll(app, agent_for_catchup, path, p);
    Ok(())
}

pub fn unwatch_session_turn(path: String) -> Result<(), String> {
    let mut watches = session_turn_watches().lock().map_err(|e| e.to_string())?;
    watches.remove(&path);
    Ok(())
}

fn start_session_turn_poll(app: AppHandle, agent: String, path: String, fp: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(SESSION_TURN_POLL_MS));
        let should_continue = {
            let guard = match session_turn_watches().lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            matches!(
                guard.get(&path),
                Some(state) if state.agent == agent && state.path == fp
            )
        };
        if !should_continue {
            return;
        }
        process_session_turn_file(&app, &agent, &path, &fp);
    });
}

fn process_session_turn_file(app: &AppHandle, agent: &str, path: &str, fp: &Path) {
    let mut file = match File::open(fp) {
        Ok(f) => f,
        Err(_) => return,
    };
    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    let offset = {
        let mut guard = match session_turn_watches().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(state) = guard.get_mut(path) else {
            return;
        };
        if state.agent != agent || state.path != fp {
            return;
        }
        if file_len < state.offset {
            state.offset = 0;
        }
        state.offset
    };

    if file.seek(SeekFrom::Start(offset)).is_err() {
        return;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return;
    }
    let consumed = complete_jsonl_prefix_len(&buf);
    if consumed == 0 {
        return;
    }
    if let Ok(mut guard) = session_turn_watches().lock() {
        if let Some(state) = guard.get_mut(path) {
            state.offset = offset.saturating_add(consumed as u64);
        }
    }

    for line in buf[..consumed].lines() {
        let Some(state) = infer_turn_state(agent, line) else {
            continue;
        };
        let _ = emit_turn_signal(
            app,
            TerminalTurnPayload {
                agent: agent.to_string(),
                path: path.to_string(),
                state: state.to_string(),
            },
        );
    }
}

fn complete_jsonl_prefix_len(buf: &str) -> usize {
    let newline_prefix_len = buf.rfind('\n').map(|idx| idx + 1).unwrap_or(0);
    let tail = &buf[newline_prefix_len..];
    if tail.trim().is_empty() {
        return newline_prefix_len;
    }
    if serde_json::from_str::<Value>(tail.trim()).is_ok() {
        buf.len()
    } else {
        newline_prefix_len
    }
}

fn infer_turn_state(agent: &str, line: &str) -> Option<&'static str> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    match agent {
        "codex" => infer_codex_turn_state(&value),
        "gemini" => infer_gemini_turn_state(&value),
        _ => None,
    }
}

fn infer_codex_turn_state(value: &Value) -> Option<&'static str> {
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    match payload.get("type").and_then(Value::as_str)? {
        "task_started" => Some("started"),
        "user_message" => Some("started"),
        "task_complete" => Some("completed"),
        "agent_message" => {
            if payload.get("phase").and_then(Value::as_str) == Some("commentary") {
                None
            } else {
                Some("completed")
            }
        }
        "task_failed" => Some("failed"),
        "error" => Some("failed"),
        _ => None,
    }
}

fn infer_gemini_turn_state(value: &Value) -> Option<&'static str> {
    match value.get("type").and_then(Value::as_str)? {
        "user" => Some("started"),
        "gemini" => {
            let content_done = value
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| !content.trim().is_empty());
            let token_done = value.get("tokens").is_some_and(|tokens| {
                let output = tokens.get("output").and_then(Value::as_u64).unwrap_or(0);
                let thoughts = tokens.get("thoughts").and_then(Value::as_u64).unwrap_or(0);
                output > 0 || thoughts > 0
            });
            if content_done || token_done {
                Some("completed")
            } else {
                None
            }
        }
        "error" => Some("failed"),
        _ => None,
    }
}

fn process_signal_file(app: &AppHandle, path: &Path) {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    let offset = {
        let mut guard = match signal_state().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(state) = guard.as_mut() else { return };
        if state.path != path {
            return;
        }
        if file_len < state.offset {
            state.offset = 0;
        }
        state.offset
    };

    if file.seek(SeekFrom::Start(offset)).is_err() {
        return;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return;
    }
    let consumed = complete_jsonl_prefix_len(&buf);
    if consumed == 0 {
        return;
    }
    if let Ok(mut guard) = signal_state().lock() {
        if let Some(state) = guard.as_mut() {
            if state.path == path {
                state.offset = offset.saturating_add(consumed as u64);
            }
        }
    }

    for line in buf[..consumed].lines() {
        let Ok(payload) = serde_json::from_str::<TerminalTurnPayload>(line) else {
            continue;
        };
        let _ = emit_turn_signal(app, payload);
    }
}

pub fn install_claude_hooks() -> Result<String, String> {
    let signal_path = signal_file_path()?;
    if let Some(parent) = signal_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建状态目录失败: {e}"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&signal_path)
        .map_err(|e| format!("初始化状态文件失败: {e}"))?;

    let script_path = hook_script_path()?;
    write_hook_script(&script_path)?;

    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let claude_dir = home.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| format!("创建 Claude 配置目录失败: {e}"))?;
    let settings_path = claude_dir.join("settings.json");

    let mut settings = read_json_object(&settings_path)?;
    merge_claude_hook(&mut settings, "UserPromptSubmit", "started", &script_path, &signal_path);
    merge_claude_hook(&mut settings, "Stop", "completed", &script_path, &signal_path);
    merge_claude_hook(&mut settings, "StopFailure", "failed", &script_path, &signal_path);
    merge_claude_hook(&mut settings, "Notification", "blocked", &script_path, &signal_path);
    merge_claude_hook(&mut settings, "PermissionRequest", "blocked", &script_path, &signal_path);

    let formatted = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, format!("{formatted}\n"))
        .map_err(|e| format!("写入 Claude 配置失败: {e}"))?;

    Ok(settings_path.to_string_lossy().to_string())
}

fn read_json_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 Claude 配置失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Claude settings.json 不是合法 JSON: {e}"))?;
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Err("Claude settings.json 顶层必须是对象".to_string())
    }
}

fn merge_claude_hook(
    settings: &mut Value,
    event: &str,
    state: &str,
    script_path: &Path,
    signal_path: &Path,
) {
    if !settings.get("hooks").is_some_and(Value::is_object) {
        settings["hooks"] = json!({});
    }
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    let entry = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
    if !entry.is_array() {
        *entry = json!([]);
    }
    let Some(groups) = entry.as_array_mut() else { return };

    for group in groups.iter_mut() {
        let Some(items) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        items.retain(|item| !is_our_hook(item, script_path));
    }
    groups.retain(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    });

    groups.push(json!({
        "hooks": [{
            "type": "command",
            "command": format!(
                "node {} {} {}",
                shell_path_arg(script_path),
                shell_string_arg(state),
                shell_path_arg(signal_path)
            ),
            "timeout": 5
        }]
    }));
}

fn is_our_hook(item: &Value, script_path: &Path) -> bool {
    item.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(script_path.to_string_lossy().as_ref()))
}

fn shell_path_arg(value: impl AsRef<Path>) -> String {
    let raw = value.as_ref().to_string_lossy();
    shell_string_arg(&raw)
}

fn shell_string_arg(raw: &str) -> String {
    format!("\"{}\"", raw.replace('\\', "\\\\").replace('"', "\\\""))
}

fn write_hook_script(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 hook 脚本目录失败: {e}"))?;
    }
    fs::write(path, HOOK_SCRIPT).map_err(|e| format!("写入 hook 脚本失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .map_err(|e| format!("读取 hook 脚本权限失败: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).map_err(|e| format!("设置 hook 脚本权限失败: {e}"))?;
    }
    Ok(())
}

const HOOK_SCRIPT: &str = r#"#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const state = process.argv[2];
const signalPath = process.argv[3];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if (!signalPath || !state) process.exit(0);
    const data = input.trim() ? JSON.parse(input) : {};
    const transcriptPath = data.transcript_path || data.transcriptPath || '';
    if (!transcriptPath) process.exit(0);
    const payload = {
      agent: 'claude',
      path: transcriptPath,
      state,
    };
    fs.mkdirSync(path.dirname(signalPath), { recursive: true });
    fs.appendFileSync(signalPath, JSON.stringify(payload) + '\n', 'utf8');
  } catch (_) {
    // Observability hook: never block Claude Code.
  }
});
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_infers_turn_lifecycle_from_event_messages() {
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"user_message"}})),
            Some("started")
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"task_started"}})),
            Some("started")
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"agent_message","message":"done"}})),
            Some("completed")
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"task_complete"}})),
            Some("completed")
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"done"}})),
            Some("completed")
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"checking"}})),
            None
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"error","message":"boom"}})),
            Some("failed")
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"task_failed","message":"boom"}})),
            Some("failed")
        );
        assert_eq!(
            infer_codex_turn_state(&json!({"type":"event_msg","payload":{"type":"token_count"}})),
            None
        );
    }

    #[test]
    fn gemini_infers_turn_lifecycle_from_user_and_response_records() {
        assert_eq!(
            infer_gemini_turn_state(&json!({"type":"user","content":"hi"})),
            Some("started")
        );
        assert_eq!(
            infer_gemini_turn_state(&json!({"type":"gemini","content":"ok"})),
            Some("completed")
        );
        assert_eq!(
            infer_gemini_turn_state(&json!({"type":"gemini","tokens":{"output":1}})),
            Some("completed")
        );
        assert_eq!(
            infer_gemini_turn_state(&json!({"type":"gemini","tokens":{"thoughts":1}})),
            Some("completed")
        );
        assert_eq!(
            infer_gemini_turn_state(&json!({"type":"gemini","toolCalls":[] })),
            None
        );
        assert_eq!(infer_gemini_turn_state(&json!({"type":"error"})), Some("failed"));
    }

    #[test]
    fn jsonl_consumption_keeps_partial_line_for_next_event() {
        assert_eq!(complete_jsonl_prefix_len(""), 0);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":1}"), 7);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":"), 0);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":1}\n{\"b\":"), 8);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":1}\n{\"b\":2}"), 15);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":\"中\"}\n"), "{\"a\":\"中\"}\n".len());
    }
}

