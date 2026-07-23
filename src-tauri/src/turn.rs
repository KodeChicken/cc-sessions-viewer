use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
pub struct TerminalTurnPayload {
    pub agent: String,
    pub path: String,
    pub state: String,
    #[serde(default = "default_turn_signal_source")]
    pub source: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTask {
    pub agent: String,
    pub path: String,
    pub state: String,
    pub title: String,
    pub updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnHookInstallResult {
    pub claude_settings_path: String,
    pub codex_hooks_path: String,
    pub agy_hooks_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnHookEventStatus {
    pub name: String,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnHookEntry {
    pub event: String,
    pub category: Option<String>,
    pub matcher: Option<String>,
    pub hook_type: String,
    pub detail: String,
    pub managed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnHookAgentStatus {
    pub installed: bool,
    pub config_path: String,
    pub events: Vec<TurnHookEventStatus>,
    pub hooks: Vec<TurnHookEntry>,
}

#[derive(Serialize)]
pub struct TurnHookStatus {
    pub enabled: bool,
    pub claude: TurnHookAgentStatus,
    pub codex: TurnHookAgentStatus,
    pub agy: TurnHookAgentStatus,
}

const CLAUDE_TURN_HOOKS: [(&str, &str, Option<&str>); 5] = [
    ("UserPromptSubmit", "started", None),
    ("Stop", "completed", None),
    ("StopFailure", "failed", None),
    (
        "Notification",
        "blocked",
        Some("permission_prompt|elicitation_dialog|agent_needs_input"),
    ),
    ("PermissionRequest", "blocked", None),
];

const CODEX_TURN_HOOKS: [(&str, &str); 3] = [
    ("UserPromptSubmit", "started"),
    ("Stop", "completed"),
    ("PermissionRequest", "blocked"),
];

const AGY_TURN_HOOKS: [(&str, &str); 2] = [("PreInvocation", "started"), ("Stop", "completed")];

fn default_turn_signal_source() -> String {
    "hook".to_string()
}

struct SignalState {
    _watcher: RecommendedWatcher,
    path: PathBuf,
    offset: u64,
}

static SIGNAL_STATE: OnceLock<Mutex<Option<SignalState>>> = OnceLock::new();
static DESKTOP_TASKS: OnceLock<Mutex<HashMap<String, DesktopTask>>> = OnceLock::new();

fn signal_state() -> &'static Mutex<Option<SignalState>> {
    SIGNAL_STATE.get_or_init(|| Mutex::new(None))
}

fn desktop_tasks() -> &'static Mutex<HashMap<String, DesktopTask>> {
    DESKTOP_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalized_session_path(path: &str) -> String {
    let path = path.trim();
    #[cfg(target_os = "windows")]
    {
        path.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string()
    }
}

fn desktop_task_key(agent: &str, path: &str) -> String {
    format!("{agent}\0{}", normalized_session_path(path))
}

fn task_title(agent: &str, path: &str) -> String {
    let fallback = Path::new(path.trim())
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(path.trim())
        .to_string();
    crate::agents::source(agent)
        .ok()
        .map(|source| source.trash_title(Path::new(path.trim())))
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty() && title != "(untitled session)")
        .unwrap_or(fallback)
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn upsert_desktop_task(
    tasks: &mut HashMap<String, DesktopTask>,
    payload: &TerminalTurnPayload,
    updated_at: u64,
) {
    let path = payload.path.trim().to_string();
    tasks.insert(
        desktop_task_key(&payload.agent, &path),
        DesktopTask {
            agent: payload.agent.clone(),
            title: task_title(&payload.agent, &path),
            path,
            state: payload.state.clone(),
            updated_at,
        },
    );
}

pub fn desktop_task_snapshot() -> Result<Vec<DesktopTask>, String> {
    let mut snapshot = desktop_tasks()
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    snapshot.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(snapshot)
}

fn data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| "Cannot locate local data directory".to_string())?;
    Ok(base.join("cc-sessions-viewer"))
}

pub fn signal_file_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("turn-signals.jsonl"))
}

fn hook_script_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("turn-signal-hook.cjs"))
}

fn legacy_hook_script_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("claude-turn-signal-hook.cjs"))
}

pub fn emit_turn_signal(app: &AppHandle, payload: TerminalTurnPayload) -> Result<(), String> {
    if payload.agent != "claude" && payload.agent != "codex" && payload.agent != "agy" {
        return Err("Unknown agent".to_string());
    }
    if payload.path.trim().is_empty() {
        return Err("Missing session path".to_string());
    }
    if !matches!(
        payload.state.as_str(),
        "started" | "completed" | "blocked" | "failed"
    ) {
        return Err("Unknown session state".to_string());
    }
    if payload.source != "hook" {
        return Err("Unknown session state source".to_string());
    }
    let mut tasks = desktop_tasks().lock().map_err(|error| error.to_string())?;
    upsert_desktop_task(&mut tasks, &payload, current_timestamp_ms());
    drop(tasks);
    app.emit("terminal-turn://state", payload)
        .map_err(|e| e.to_string())
}

pub fn start_signal_watcher(app: AppHandle) -> Result<(), String> {
    let signal_path = signal_file_path()?;
    if let Some(parent) = signal_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create state directory: {e}"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&signal_path)
        .map_err(|e| format!("Failed to initialize state file: {e}"))?;

    let offset = fs::metadata(&signal_path).map(|m| m.len()).unwrap_or(0);
    let app_for_cb = app.clone();
    let path_for_cb = signal_path.clone();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(ev) = res else { return };
            if !matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                return;
            }
            process_signal_file(&app_for_cb, &path_for_cb);
        })
        .map_err(|e| format!("Failed to initialize turn signal watcher: {e}"))?;

    watcher
        .watch(&signal_path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch state file: {e}"))?;

    let mut slot = signal_state().lock().map_err(|e| e.to_string())?;
    *slot = Some(SignalState {
        _watcher: watcher,
        path: signal_path,
        offset,
    });
    Ok(())
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

pub fn install_turn_hooks() -> Result<TurnHookInstallResult, String> {
    let signal_path = signal_file_path()?;
    if let Some(parent) = signal_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create state directory: {e}"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&signal_path)
        .map_err(|e| format!("Failed to initialize state file: {e}"))?;

    let script_path = hook_script_path()?;
    write_hook_script(&script_path)?;
    let legacy_script_path = legacy_hook_script_path()?;

    let (settings_path, codex_hooks_path, agy_hooks_path) = turn_hook_config_paths()?;
    let claude_dir = settings_path
        .parent()
        .ok_or_else(|| "Cannot locate Claude config directory".to_string())?;
    fs::create_dir_all(&claude_dir)
        .map_err(|e| format!("Failed to create Claude config directory: {e}"))?;

    let mut settings = read_json_object(&settings_path, "Claude settings.json")?;
    for (event, state, matcher) in CLAUDE_TURN_HOOKS {
        merge_turn_hook(
            &mut settings,
            event,
            state,
            "claude",
            matcher,
            &script_path,
            &legacy_script_path,
            &signal_path,
        );
    }

    let formatted = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, format!("{formatted}\n"))
        .map_err(|e| format!("Failed to write Claude config: {e}"))?;

    let codex_dir = codex_hooks_path
        .parent()
        .ok_or_else(|| "Cannot locate Codex config directory".to_string())?;
    fs::create_dir_all(&codex_dir)
        .map_err(|e| format!("Failed to create Codex config directory: {e}"))?;
    let mut codex_hooks = read_json_object(&codex_hooks_path, "Codex hooks.json")?;
    for (event, state) in CODEX_TURN_HOOKS {
        merge_turn_hook(
            &mut codex_hooks,
            event,
            state,
            "codex",
            None,
            &script_path,
            &legacy_script_path,
            &signal_path,
        );
    }
    let formatted = serde_json::to_string_pretty(&codex_hooks).map_err(|e| e.to_string())?;
    fs::write(&codex_hooks_path, format!("{formatted}\n"))
        .map_err(|e| format!("Failed to write Codex hooks: {e}"))?;

    let agy_config_dir = agy_hooks_path
        .parent()
        .ok_or_else(|| "Cannot locate Antigravity config directory".to_string())?;
    fs::create_dir_all(&agy_config_dir)
        .map_err(|e| format!("Failed to create Antigravity config directory: {e}"))?;
    let mut agy_hooks = read_json_object(&agy_hooks_path, "Antigravity hooks.json")?;
    merge_agy_turn_hooks(&mut agy_hooks, &script_path, &signal_path);
    let formatted = serde_json::to_string_pretty(&agy_hooks).map_err(|e| e.to_string())?;
    fs::write(&agy_hooks_path, format!("{formatted}\n"))
        .map_err(|e| format!("Failed to write Antigravity hooks: {e}"))?;

    Ok(TurnHookInstallResult {
        claude_settings_path: settings_path.to_string_lossy().to_string(),
        codex_hooks_path: codex_hooks_path.to_string_lossy().to_string(),
        agy_hooks_path: agy_hooks_path.to_string_lossy().to_string(),
    })
}

pub fn turn_hook_status() -> Result<TurnHookStatus, String> {
    let (claude_path, codex_path, agy_path) = turn_hook_config_paths()?;
    let script_path = hook_script_path()?;
    let legacy_script_path = legacy_hook_script_path()?;
    let signal_path = signal_file_path()?;
    let script_installed = fs::read_to_string(&script_path).is_ok_and(|raw| raw == HOOK_SCRIPT);

    let claude_config = read_json_object(&claude_path, "Claude settings.json")?;
    let claude_events = CLAUDE_TURN_HOOKS
        .iter()
        .map(|(event, state, matcher)| TurnHookEventStatus {
            name: (*event).to_string(),
            installed: script_installed
                && has_turn_hook(
                    &claude_config,
                    event,
                    state,
                    "claude",
                    *matcher,
                    &script_path,
                    &signal_path,
                ),
        })
        .collect::<Vec<_>>();
    let claude_hooks = collect_grouped_hooks(&claude_config, &script_path, &legacy_script_path);
    let claude = hook_agent_status(claude_path, claude_events, claude_hooks);

    let codex_config = read_json_object(&codex_path, "Codex hooks.json")?;
    let codex_events = CODEX_TURN_HOOKS
        .iter()
        .map(|(event, state)| TurnHookEventStatus {
            name: (*event).to_string(),
            installed: script_installed
                && has_turn_hook(
                    &codex_config,
                    event,
                    state,
                    "codex",
                    None,
                    &script_path,
                    &signal_path,
                ),
        })
        .collect::<Vec<_>>();
    let codex_hooks = collect_grouped_hooks(&codex_config, &script_path, &legacy_script_path);
    let codex = hook_agent_status(codex_path, codex_events, codex_hooks);

    let agy_config = read_json_object(&agy_path, "Antigravity hooks.json")?;
    let agy_events = AGY_TURN_HOOKS
        .iter()
        .map(|(event, state)| TurnHookEventStatus {
            name: (*event).to_string(),
            installed: script_installed
                && has_agy_turn_hook(&agy_config, event, state, &script_path, &signal_path),
        })
        .collect::<Vec<_>>();
    let agy_hooks = collect_agy_hooks(&agy_config, &script_path, &legacy_script_path);
    let agy = hook_agent_status(agy_path, agy_events, agy_hooks);

    Ok(TurnHookStatus {
        enabled: claude.installed && codex.installed && agy.installed,
        claude,
        codex,
        agy,
    })
}

fn turn_hook_config_paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory".to_string())?;
    let codex_dir = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    Ok((
        home.join(".claude").join("settings.json"),
        codex_dir.join("hooks.json"),
        home.join(".gemini").join("config").join("hooks.json"),
    ))
}

fn hook_agent_status(
    path: PathBuf,
    events: Vec<TurnHookEventStatus>,
    hooks: Vec<TurnHookEntry>,
) -> TurnHookAgentStatus {
    TurnHookAgentStatus {
        installed: events.iter().all(|event| event.installed),
        config_path: path.to_string_lossy().to_string(),
        events,
        hooks,
    }
}

fn collect_grouped_hooks(
    config: &Value,
    script_path: &Path,
    legacy_script_path: &Path,
) -> Vec<TurnHookEntry> {
    let mut entries = Vec::new();
    let Some(events) = config.get("hooks").and_then(Value::as_object) else {
        return entries;
    };
    for (event, groups) in events {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            let matcher = value_text(group.get("matcher"));
            let Some(items) = group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for item in items {
                entries.push(hook_entry(
                    event,
                    None,
                    matcher.clone(),
                    item,
                    script_path,
                    legacy_script_path,
                ));
            }
        }
    }
    sort_hook_entries(&mut entries);
    entries
}

fn collect_agy_hooks(
    config: &Value,
    script_path: &Path,
    legacy_script_path: &Path,
) -> Vec<TurnHookEntry> {
    let mut entries = Vec::new();
    let Some(categories) = config.as_object() else {
        return entries;
    };
    for (category, hooks) in categories {
        let Some(events) = hooks.as_object() else {
            continue;
        };
        for (event, items) in events {
            let Some(items) = items.as_array() else {
                continue;
            };
            for item in items {
                entries.push(hook_entry(
                    event,
                    Some(category.clone()),
                    value_text(item.get("matcher")),
                    item,
                    script_path,
                    legacy_script_path,
                ));
            }
        }
    }
    sort_hook_entries(&mut entries);
    entries
}

fn hook_entry(
    event: &str,
    category: Option<String>,
    matcher: Option<String>,
    item: &Value,
    script_path: &Path,
    legacy_script_path: &Path,
) -> TurnHookEntry {
    let hook_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("hook")
        .to_string();
    let detail = ["command", "prompt", "url"]
        .iter()
        .find_map(|key| value_text(item.get(*key)))
        .unwrap_or_else(|| serde_json::to_string(item).unwrap_or_default());
    TurnHookEntry {
        event: event.to_string(),
        category,
        matcher,
        hook_type,
        detail,
        managed: is_our_hook(item, script_path, legacy_script_path),
    }
}

fn value_text(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => serde_json::to_string(other).ok(),
    })
}

fn sort_hook_entries(entries: &mut [TurnHookEntry]) {
    entries.sort_by(|a, b| {
        a.event
            .cmp(&b.event)
            .then_with(|| a.category.cmp(&b.category))
            .then_with(|| a.matcher.cmp(&b.matcher))
            .then_with(|| a.detail.cmp(&b.detail))
    });
}

fn read_json_object(path: &Path, label: &str) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read {label}: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("{label} is not valid JSON: {e}"))?;
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Err(format!("{label} top level must be an object"))
    }
}

#[allow(clippy::too_many_arguments)]
fn merge_turn_hook(
    settings: &mut Value,
    event: &str,
    state: &str,
    agent: &str,
    matcher: Option<&str>,
    script_path: &Path,
    legacy_script_path: &Path,
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
    let Some(groups) = entry.as_array_mut() else {
        return;
    };

    for group in groups.iter_mut() {
        let Some(items) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        items.retain(|item| !is_our_hook(item, script_path, legacy_script_path));
    }
    groups.retain(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    });

    let mut group = json!({
        "hooks": [turn_hook_command(agent, state, script_path, signal_path)]
    });
    if let Some(matcher) = matcher {
        group["matcher"] = json!(matcher);
    }
    groups.push(group);
}

const AGY_HOOK_NAME: &str = "cc-sessions-viewer-turn-status";

fn merge_agy_turn_hooks(config: &mut Value, script_path: &Path, signal_path: &Path) {
    let mut hooks = json!({});
    for (event, state) in AGY_TURN_HOOKS {
        hooks[event] = json!([turn_hook_command("agy", state, script_path, signal_path)]);
    }
    config[AGY_HOOK_NAME] = hooks;
}

fn has_turn_hook(
    config: &Value,
    event: &str,
    state: &str,
    agent: &str,
    matcher: Option<&str>,
    script_path: &Path,
    signal_path: &Path,
) -> bool {
    let expected = turn_hook_command(agent, state, script_path, signal_path);
    config["hooks"][event].as_array().is_some_and(|groups| {
        groups.iter().any(|group| {
            let matcher_matches = match matcher {
                Some(expected) => group["matcher"].as_str() == Some(expected),
                None => group.get("matcher").is_none(),
            };
            matcher_matches
                && group["hooks"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item == &expected))
        })
    })
}

fn has_agy_turn_hook(
    config: &Value,
    event: &str,
    state: &str,
    script_path: &Path,
    signal_path: &Path,
) -> bool {
    let expected = turn_hook_command("agy", state, script_path, signal_path);
    config[AGY_HOOK_NAME][event]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item == &expected))
}

fn turn_hook_command(agent: &str, state: &str, script_path: &Path, signal_path: &Path) -> Value {
    json!({
        "type": "command",
        "command": format!(
            "node {} {} {} {}",
            shell_path_arg(script_path),
            shell_string_arg(agent),
            shell_string_arg(state),
            shell_path_arg(signal_path)
        ),
        "timeout": 5
    })
}

fn is_our_hook(item: &Value, script_path: &Path, legacy_script_path: &Path) -> bool {
    item.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            command_references_path(command, script_path)
                || command_references_path(command, legacy_script_path)
        })
}

fn command_references_path(command: &str, path: &Path) -> bool {
    let raw = path.to_string_lossy();
    command.contains(raw.as_ref()) || command.contains(&raw.replace('\\', "\\\\"))
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
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create hook script directory: {e}"))?;
    }
    fs::write(path, HOOK_SCRIPT).map_err(|e| format!("Failed to write hook script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .map_err(|e| format!("Failed to read hook script permissions: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)
            .map_err(|e| format!("Failed to set hook script permissions: {e}"))?;
    }
    Ok(())
}

const HOOK_SCRIPT: &str = include_str!("turn_signal_hook.cjs");

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(agent: &str, path: &str, state: &str) -> TerminalTurnPayload {
        TerminalTurnPayload {
            agent: agent.to_string(),
            path: path.to_string(),
            state: state.to_string(),
            source: "hook".to_string(),
        }
    }

    #[test]
    fn desktop_tasks_keep_only_the_latest_state_per_session() {
        let mut tasks = HashMap::new();
        upsert_desktop_task(
            &mut tasks,
            &payload("codex", "/tmp/session-1.jsonl", "completed"),
            10,
        );
        upsert_desktop_task(
            &mut tasks,
            &payload("codex", "/tmp/session-1.jsonl", "started"),
            20,
        );

        assert_eq!(tasks.len(), 1);
        let task = tasks.values().next().unwrap();
        assert_eq!(task.state, "started");
        assert_eq!(task.updated_at, 20);
        assert_eq!(task.title, "session-1");
    }

    #[test]
    fn desktop_tasks_separate_agents_with_the_same_session_path() {
        let mut tasks = HashMap::new();
        upsert_desktop_task(
            &mut tasks,
            &payload("claude", "/tmp/shared.jsonl", "blocked"),
            10,
        );
        upsert_desktop_task(
            &mut tasks,
            &payload("codex", "/tmp/shared.jsonl", "failed"),
            20,
        );

        assert_eq!(tasks.len(), 2);
        assert!(tasks.values().any(|task| task.state == "blocked"));
        assert!(tasks.values().any(|task| task.state == "failed"));
    }

    #[test]
    fn desktop_tasks_use_the_session_prompt_as_the_codex_title() {
        let path = std::env::temp_dir().join(format!(
            "cc-sessions-viewer-pet-title-{}-{}.jsonl",
            std::process::id(),
            current_timestamp_ms()
        ));
        std::fs::write(
            &path,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"杨坤唱的答案 歌词是啥"}}
"#,
        )
        .unwrap();
        let mut tasks = HashMap::new();
        upsert_desktop_task(
            &mut tasks,
            &payload("codex", path.to_string_lossy().as_ref(), "completed"),
            10,
        );

        assert_eq!(tasks.values().next().unwrap().title, "杨坤唱的答案 歌词是啥");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn hook_merge_replaces_legacy_hook_and_preserves_other_handlers() {
        let script = Path::new("/app/turn-signal-hook.cjs");
        let legacy = Path::new("/app/claude-turn-signal-hook.cjs");
        let signal = Path::new("/app/turn-signals.jsonl");
        let mut config = json!({
            "hooks": {
                "Stop": [{
                    "hooks": [
                        {"type":"command","command":"node /app/claude-turn-signal-hook.cjs completed /tmp/old"},
                        {"type":"command","command":"echo keep-me"}
                    ]
                }]
            }
        });

        merge_turn_hook(
            &mut config,
            "Stop",
            "completed",
            "codex",
            None,
            script,
            legacy,
            signal,
        );

        let groups = config["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["hooks"][0]["command"], "echo keep-me");
        let command = groups[1]["hooks"][0]["command"].as_str().unwrap();
        assert!(command.contains("turn-signal-hook.cjs"));
        assert!(command.contains("\"codex\" \"completed\""));
    }

    #[test]
    fn hook_merge_sets_optional_matcher() {
        let mut config = json!({});
        merge_turn_hook(
            &mut config,
            "Notification",
            "blocked",
            "claude",
            Some("permission_prompt|elicitation_dialog|agent_needs_input"),
            Path::new("/app/turn-signal-hook.cjs"),
            Path::new("/app/claude-turn-signal-hook.cjs"),
            Path::new("/app/turn-signals.jsonl"),
        );
        assert_eq!(
            config["hooks"]["Notification"][0]["matcher"],
            "permission_prompt|elicitation_dialog|agent_needs_input"
        );
    }

    #[test]
    fn hook_status_requires_the_expected_command_and_matcher() {
        let script = Path::new("/app/turn-signal-hook.cjs");
        let legacy = Path::new("/app/claude-turn-signal-hook.cjs");
        let signal = Path::new("/app/turn-signals.jsonl");
        let matcher = "permission_prompt|elicitation_dialog|agent_needs_input";
        let mut config = json!({});
        merge_turn_hook(
            &mut config,
            "Notification",
            "blocked",
            "claude",
            Some(matcher),
            script,
            legacy,
            signal,
        );

        assert!(has_turn_hook(
            &config,
            "Notification",
            "blocked",
            "claude",
            Some(matcher),
            script,
            signal,
        ));
        assert!(!has_turn_hook(
            &config,
            "Notification",
            "completed",
            "claude",
            Some(matcher),
            script,
            signal,
        ));
        assert!(!has_turn_hook(
            &config,
            "Notification",
            "blocked",
            "claude",
            Some("permission_prompt"),
            script,
            signal,
        ));
    }

    #[test]
    fn hook_inventory_lists_external_and_managed_handlers() {
        let script = Path::new("/app/turn-signal-hook.cjs");
        let legacy = Path::new("/app/claude-turn-signal-hook.cjs");
        let signal = Path::new("/app/turn-signals.jsonl");
        let mut config = json!({
            "hooks": {
                "PreToolUse": [{
                    "matcher": "Bash",
                    "hooks": [{"type":"prompt","prompt":"Check this command"}]
                }]
            }
        });
        merge_turn_hook(
            &mut config,
            "Stop",
            "completed",
            "claude",
            None,
            script,
            legacy,
            signal,
        );

        let entries = collect_grouped_hooks(&config, script, legacy);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].event, "PreToolUse");
        assert_eq!(entries[0].matcher.as_deref(), Some("Bash"));
        assert_eq!(entries[0].hook_type, "prompt");
        assert_eq!(entries[0].detail, "Check this command");
        assert!(!entries[0].managed);
        assert_eq!(entries[1].event, "Stop");
        assert!(entries[1].managed);
    }

    #[test]
    fn managed_hook_detection_accepts_escaped_windows_paths() {
        let script = Path::new(r"C:\Users\test\turn-signal-hook.cjs");
        let item = turn_hook_command(
            "codex",
            "started",
            script,
            Path::new(r"C:\Users\test\turn-signals.jsonl"),
        );
        assert!(is_our_hook(
            &item,
            script,
            Path::new(r"C:\Users\test\claude-turn-signal-hook.cjs"),
        ));
    }

    #[test]
    fn agy_hook_merge_uses_antigravity_schema_and_preserves_other_hooks() {
        let mut config = json!({
            "other-hook": {
                "PreInvocation": [{"type":"command","command":"echo keep-me"}]
            }
        });
        merge_agy_turn_hooks(
            &mut config,
            Path::new("/app/turn-signal-hook.cjs"),
            Path::new("/app/turn-signals.jsonl"),
        );

        assert_eq!(
            config["other-hook"]["PreInvocation"][0]["command"],
            "echo keep-me"
        );
        let hook = &config[AGY_HOOK_NAME];
        assert!(hook.get("PreInvocation").is_some_and(Value::is_array));
        assert!(hook.get("Stop").is_some_and(Value::is_array));
        assert!(hook.get("hooks").is_none());
        assert!(hook["PreInvocation"][0]["command"]
            .as_str()
            .is_some_and(|command| command.contains("\"agy\" \"started\"")));
        assert!(hook["Stop"][0]["command"]
            .as_str()
            .is_some_and(|command| command.contains("\"agy\" \"completed\"")));
        assert!(has_agy_turn_hook(
            &config,
            "PreInvocation",
            "started",
            Path::new("/app/turn-signal-hook.cjs"),
            Path::new("/app/turn-signals.jsonl"),
        ));
        assert!(!has_agy_turn_hook(
            &config,
            "PreInvocation",
            "completed",
            Path::new("/app/turn-signal-hook.cjs"),
            Path::new("/app/turn-signals.jsonl"),
        ));
        let entries = collect_agy_hooks(
            &config,
            Path::new("/app/turn-signal-hook.cjs"),
            Path::new("/app/claude-turn-signal-hook.cjs"),
        );
        assert_eq!(entries.len(), 3);
        assert!(entries
            .iter()
            .any(|entry| entry.category.as_deref() == Some("other-hook") && !entry.managed));
        assert_eq!(entries.iter().filter(|entry| entry.managed).count(), 2);
    }

    #[test]
    fn signal_jsonl_consumption_keeps_partial_line_for_next_event() {
        assert_eq!(complete_jsonl_prefix_len(""), 0);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":1}"), 7);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":"), 0);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":1}\n{\"b\":"), 8);
        assert_eq!(complete_jsonl_prefix_len("{\"a\":1}\n{\"b\":2}"), 15);
        assert_eq!(
            complete_jsonl_prefix_len("{\"a\":\"中\"}\n"),
            "{\"a\":\"中\"}\n".len()
        );
    }
}
