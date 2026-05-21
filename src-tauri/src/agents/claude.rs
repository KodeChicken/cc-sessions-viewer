// Claude Code 会话源：~/.claude/projects/<dir>/<sessionId>.jsonl
//
// 每行是 `{ "type": "user" | "assistant" | "custom-title" | ..., ... }`，
// user/assistant 的 `message.content` 数组里夹着 text / thinking / tool_use /
// tool_result / image 等块。

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::SessionSource;
use crate::types::{Block, DiffHunk, DiffLine, Msg, ProjectInfo, SessionMeta, SessionPage};
use crate::util::{
    append_jsonl_line, clean_title, home, is_jsonl, mtime_millis, text_block, validate_rename_name,
};

pub struct ClaudeSource;

fn projects_dir() -> PathBuf {
    home().join(".claude").join("projects")
}

impl SessionSource for ClaudeSource {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn list_projects(&self) -> Result<Vec<ProjectInfo>, String> {
        let dir = projects_dir();
        let mut out = Vec::new();
        let entries = fs::read_dir(&dir).map_err(|e| format!("读取项目目录失败: {e}"))?;
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = e.file_name().to_string_lossy().to_string();
            let mut count = 0usize;
            let mut last = 0u64;
            let mut cwd: Option<String> = None;
            if let Ok(files) = fs::read_dir(&path) {
                for f in files.flatten() {
                    let fp = f.path();
                    if is_jsonl(&fp) {
                        count += 1;
                        let m = mtime_millis(&fp);
                        if m > last {
                            last = m;
                        }
                        if cwd.is_none() {
                            cwd = first_cwd(&fp);
                        }
                    }
                }
            }
            if count == 0 {
                continue;
            }
            let display_path = cwd.unwrap_or_else(|| dir_name.replace('-', "/"));
            let exists = Path::new(&display_path).is_dir();
            out.push(ProjectInfo {
                dir_name,
                display_path,
                session_count: count,
                last_modified: last,
                exists,
            });
        }
        out.sort_by_key(|p| std::cmp::Reverse(p.last_modified));
        Ok(out)
    }

    fn list_sessions(
        &self,
        project_key: &str,
        offset: usize,
        limit: usize,
    ) -> Result<SessionPage, String> {
        let pdir = projects_dir().join(project_key);
        let mut files: Vec<(PathBuf, u64)> = Vec::new();
        let entries = fs::read_dir(&pdir).map_err(|e| format!("读取会话目录失败: {e}"))?;
        for f in entries.flatten() {
            let fp = f.path();
            if is_jsonl(&fp) {
                let mt = mtime_millis(&fp);
                files.push((fp, mt));
            }
        }
        files.sort_by_key(|f| std::cmp::Reverse(f.1));
        let total = files.len();
        let sessions = files
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(p, _)| scan(p))
            .collect();
        Ok(SessionPage { total, sessions })
    }

    fn read_session(&self, path: &str) -> Result<Vec<Msg>, String> {
        read(path)
    }

    fn rename_session(&self, path: &Path, name: &str) -> Result<(), String> {
        let trimmed = validate_rename_name(name)?;
        let id = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.trim_end_matches(".jsonl").to_string())
            .unwrap_or_default();
        let line = serde_json::json!({
            "type": "custom-title",
            "customTitle": trimmed,
            "sessionId": id,
        })
        .to_string();
        append_jsonl_line(path, &line)
    }

    fn trash_title(&self, path: &Path) -> String {
        scan(path).title
    }

    fn resume_cli(&self, session_id: &str) -> String {
        format!("claude --resume {session_id}")
    }

    fn image_src(&self, block: &Value) -> Option<String> {
        image_src(block)
    }
}

// ----- 内部解析 --------------------------------------------------------------

fn first_cwd(fp: &Path) -> Option<String> {
    let file = fs::File::open(fp).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(12) {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                return Some(c.to_string());
            }
        }
    }
    None
}

fn user_text(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(arr) => {
            for el in arr {
                if el.get("type").and_then(|x| x.as_str()) == Some("text") {
                    if let Some(s) = el.get("text").and_then(|x| x.as_str()) {
                        return Some(s.to_string());
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// Claude: `{"type":"image","source":{"type":"base64"|"url", ...}}`
fn image_src(el: &Value) -> Option<String> {
    if el.get("type").and_then(|x| x.as_str()) != Some("image") {
        return None;
    }
    let source = el.get("source")?;
    let src_type = source.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if src_type == "base64" {
        let media = source
            .get("media_type")
            .and_then(|x| x.as_str())
            .unwrap_or("image/png");
        let data = source.get("data").and_then(|x| x.as_str())?;
        return Some(format!("data:{media};base64,{data}"));
    }
    if src_type == "url" {
        return source
            .get("url")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
    }
    None
}

/// 判断这条 user 消息是不是 Claude Code 紧跟在真实贴图之后写下的图片元引用，
/// 形如 `[Image: source: <local-path>]` 或 `[Image: original WxH, displayed at ...]`。
/// 真正的贴图已经在上一条 user 记录里以 base64 渲染过了，这种纯元数据直接丢弃。
/// 一条 user 记录可能携带多张图（content 数组里多个 text block），只要全是这类
/// 元引用就整体跳过。
fn is_image_source_meta(v: &Value, blocks: &[Block]) -> bool {
    let is_meta = v
        .get("isMeta")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if !is_meta {
        return false;
    }
    if blocks.is_empty() {
        return false;
    }
    blocks.iter().all(|b| {
        if b.kind != "text" {
            return false;
        }
        let txt = b.text.as_deref().unwrap_or("").trim();
        if !txt.starts_with("[Image:") || !txt.ends_with(']') {
            return false;
        }
        let inner = txt.trim_start_matches("[Image:").trim_start();
        inner.starts_with("source:") || inner.starts_with("original")
    })
}

fn stringify_tool_result(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => {
            let mut parts = Vec::new();
            for el in arr {
                match el.get("type").and_then(|x| x.as_str()) {
                    Some("text") => {
                        if let Some(s) = el.get("text").and_then(|x| x.as_str()) {
                            parts.push(s.to_string());
                        }
                    }
                    Some("image") => parts.push("[图片]".to_string()),
                    _ => {}
                }
            }
            parts.join("\n")
        }
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// 把 Claude 的 structuredPatch 解析成带行号的 diff。
fn parse_structured_patch(v: &Value) -> Option<Vec<DiffHunk>> {
    let arr = v.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let mut hunks = Vec::new();
    for h in arr {
        let old_start = h.get("oldStart").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let new_start = h.get("newStart").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let mut old_no = old_start;
        let mut new_no = new_start;
        let mut lines = Vec::new();
        if let Some(raw) = h.get("lines").and_then(|x| x.as_array()) {
            for l in raw {
                let s = l.as_str().unwrap_or("");
                let (kind, text): (&str, &str) = match s.chars().next() {
                    Some('+') => ("add", &s[1..]),
                    Some('-') => ("del", &s[1..]),
                    _ => ("ctx", s.strip_prefix(' ').unwrap_or(s)),
                };
                let (o, n) = match kind {
                    "add" => {
                        let n = new_no;
                        new_no += 1;
                        (None, Some(n))
                    }
                    "del" => {
                        let o = old_no;
                        old_no += 1;
                        (Some(o), None)
                    }
                    _ => {
                        let (o, n) = (old_no, new_no);
                        old_no += 1;
                        new_no += 1;
                        (Some(o), Some(n))
                    }
                };
                lines.push(DiffLine {
                    kind: kind.to_string(),
                    old_no: o,
                    new_no: n,
                    text: text.to_string(),
                });
            }
        }
        hunks.push(DiffHunk {
            old_start,
            new_start,
            lines,
        });
    }
    Some(hunks)
}

/// 单遍扫描一个 jsonl，提取标题 / 时间 / 消息数等元信息。
fn scan(fp: &Path) -> SessionMeta {
    let file_name = fp
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let id = file_name.trim_end_matches(".jsonl").to_string();
    let size = fs::metadata(fp).map(|m| m.len()).unwrap_or(0);
    let modified = mtime_millis(fp);

    // Claude Code `/rename <name>` 会追加一行 `{"type":"custom-title", ...}`，
    // 最后一条生效。优先使用它，否则回落到首条 user message。
    let mut first_user_title = String::new();
    let mut custom_title: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut created: Option<String> = None;
    let mut message_count = 0usize;

    if let Ok(file) = fs::File::open(fp) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if cwd.is_none() {
                if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                    cwd = Some(c.to_string());
                }
            }
            if t == "custom-title" {
                if let Some(ct) = v.get("customTitle").and_then(|x| x.as_str()) {
                    let trimmed = ct.trim();
                    if !trimmed.is_empty() {
                        custom_title = Some(trimmed.to_string());
                    }
                }
                continue;
            }
            if t == "user" || t == "assistant" {
                if created.is_none() {
                    created = v
                        .get("timestamp")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
                }
                message_count += 1;
            }
            if first_user_title.is_empty() && t == "user" {
                if let Some(txt) = user_text(&v) {
                    let clean = clean_title(&txt);
                    if !clean.is_empty() {
                        first_user_title = clean;
                    }
                }
            }
        }
    }
    let title = custom_title.unwrap_or_else(|| {
        if first_user_title.is_empty() {
            "(无标题会话)".to_string()
        } else {
            first_user_title
        }
    });
    SessionMeta {
        id,
        file_name,
        path: fp.to_string_lossy().to_string(),
        title,
        cwd,
        created,
        modified,
        size,
        message_count,
    }
}

fn read(path: &str) -> Result<Vec<Msg>, String> {
    let file = fs::File::open(path).map_err(|e| format!("打开会话失败: {e}"))?;
    let mut msgs = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" {
            continue;
        }
        let sidechain = v
            .get("isSidechain")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let uuid = v
            .get("uuid")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let timestamp = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let message = v.get("message");
        let model = message
            .and_then(|m| m.get("model"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());

        let mut blocks = Vec::new();
        if let Some(content) = message.and_then(|m| m.get("content")) {
            match content {
                Value::String(s) if !s.trim().is_empty() => {
                    blocks.push(text_block("text", s));
                }
                Value::Array(arr) => {
                    for el in arr {
                        let et = el.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        match et {
                            "text" => {
                                if let Some(s) = el.get("text").and_then(|x| x.as_str()) {
                                    if !s.trim().is_empty() {
                                        blocks.push(text_block("text", s));
                                    }
                                }
                            }
                            "thinking" => {
                                if let Some(s) = el.get("thinking").and_then(|x| x.as_str()) {
                                    if !s.trim().is_empty() {
                                        blocks.push(text_block("thinking", s));
                                    }
                                }
                            }
                            "tool_use" => {
                                let name = el
                                    .get("name")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("tool")
                                    .to_string();
                                let input = el
                                    .get("input")
                                    .map(|i| serde_json::to_string_pretty(i).unwrap_or_default());
                                let id = el
                                    .get("id")
                                    .and_then(|x| x.as_str())
                                    .map(|s| s.to_string());
                                blocks.push(Block {
                                    kind: "tool_use".to_string(),
                                    tool_name: Some(name),
                                    tool_input: input,
                                    tool_id: id,
                                    ..Default::default()
                                });
                            }
                            "tool_result" => {
                                let id = el
                                    .get("tool_use_id")
                                    .and_then(|x| x.as_str())
                                    .map(|s| s.to_string());
                                let is_error = el
                                    .get("is_error")
                                    .and_then(|x| x.as_bool())
                                    .unwrap_or(false);
                                let txt = stringify_tool_result(el.get("content"));
                                // 同一条记录顶层的 toolUseResult 携带文件改动的结构化 diff。
                                let tur = v.get("toolUseResult");
                                let file_path = tur
                                    .and_then(|t| t.get("filePath"))
                                    .and_then(|x| x.as_str())
                                    .map(|s| s.to_string());
                                let diff = tur
                                    .and_then(|t| t.get("structuredPatch"))
                                    .and_then(parse_structured_patch);
                                blocks.push(Block {
                                    kind: "tool_result".to_string(),
                                    text: Some(txt),
                                    tool_id: id,
                                    is_error,
                                    file_path,
                                    diff,
                                    ..Default::default()
                                });
                            }
                            "image" => {
                                if let Some(src) = image_src(el) {
                                    blocks.push(Block {
                                        kind: "image".to_string(),
                                        image_src: Some(src),
                                        ..Default::default()
                                    });
                                } else {
                                    blocks.push(text_block("text", "[图片]"));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        if blocks.is_empty() {
            continue;
        }
        // Claude 把用户贴图拆成两条 user 记录：一条是带 base64 的真实消息，
        // 紧跟一条 `isMeta:true` 的 `[Image: source: <local-path>]` 引用。
        // 已经在上一条里渲染过真实图，跳过 meta 那条避免出现重复气泡。
        if t == "user" && is_image_source_meta(&v, &blocks) {
            continue;
        }
        msgs.push(Msg {
            uuid,
            role: t.to_string(),
            timestamp,
            model,
            sidechain,
            blocks,
        });
    }
    Ok(msgs)
}
