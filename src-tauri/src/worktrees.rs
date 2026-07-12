// Git worktree 管理 —— 跨 agent 共享模块（与 trash.rs / bookmarks.rs 同级，非 per-agent）。
//
// 约定：worktree 一律建在「父项目根目录」下的固定子目录 `.claude/worktrees/<分支名>`。
// 这样无论用 claude / codex / agy / opencode 建，都落在同一处，扫描逻辑统一。
//
// 三件事：
//   * create —— `git worktree add <root>/.claude/worktrees/<name> -b <name>`，
//     并把 `.claude/worktrees/` 写进 `.git/info/exclude`，避免污染父仓库的 git status。
//   * scan   —— 遍历给定的候选父根目录，列出各自 `.claude/worktrees/*` 下的 worktree。
//     供 `list_projects` 把它们（即使零会话）注入侧栏。
//   * remove —— `git worktree remove --force <path>`；**保留分支**（会话另由前端软删到回收站）。
//
// 所有 git 调用走 `silent_command`（Windows 下不弹 conhost 黑框）。name 是用户可控输入，
// 经 `valid_name` 白名单校验后既作分支名又作目录名，禁止路径穿越 / git 选项注入。

use std::fs;
use std::path::{Path, PathBuf};

use crate::util::{home, silent_command};

/// worktree 相对项目根的固定存放子目录。
const WT_SUBDIR: &str = ".claude/worktrees";

/// 记录「建过 worktree 的父项目根」。侧栏是 per-agent 的，但 worktree 与 agent 无关 ——
/// 只靠当前 agent 的项目列表当扫描根，会导致「在 Claude 建的 worktree 切到 Codex 就不见了」。
/// 把父根持久化在这里，`inject_worktrees` 无论当前哪个 agent 都会扫这些根，保证四端一致。
fn roots_path() -> PathBuf {
    home()
        .join(".claude")
        .join(".session-viewer-worktree-roots.json")
}

pub fn load_roots() -> Vec<String> {
    let p = roots_path();
    if !p.exists() {
        return Vec::new();
    }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn register_root(path: &str) {
    let norm = normalize(path);
    let mut roots = load_roots();
    if roots.iter().any(|r| normalize(r) == norm) {
        return;
    }
    roots.push(norm);
    let p = roots_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&roots) {
        let _ = fs::write(&p, json);
    }
}

/// 扫描出的一个 worktree。`path` / `parent_path` 均为正斜杠归一化后的绝对路径。
pub struct Worktree {
    pub path: String,
    pub name: String,
    pub parent_path: String,
}

/// 分支名 / 目录名白名单：非空、≤100、不以 `-` 开头（防被当 git 选项），
/// 仅 `[A-Za-z0-9._-]`，且不含 `..`（防路径穿越）。
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name != "."
        && name != ".."
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// 路径分隔符归一化到正斜杠，并去掉末尾斜杠 —— 只用于「路径相等」比较，不改展示值。
pub fn normalize(p: &str) -> String {
    let s = p.replace('\\', "/");
    let trimmed = s.trim_end_matches('/');
    if trimmed.is_empty() {
        s
    } else {
        trimmed.to_string()
    }
}

fn git_stdout(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = silent_command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn is_git_repo(cwd: &str) -> bool {
    silent_command("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 把 `.claude/worktrees/` 追加进 `<git-common-dir>/info/exclude`（幂等）。失败不致命 ——
/// 仅影响父仓库 git status 是否干净，不影响 worktree 本身。
fn add_gitignore_exclude(project_path: &str) {
    let common = match git_stdout(
        project_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };
    let exclude = Path::new(&common).join("info").join("exclude");
    let line = "/.claude/worktrees/";
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return;
    }
    if let Some(parent) = exclude.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(line);
    content.push('\n');
    let _ = fs::write(&exclude, content);
}

/// 在 `project_path` 下创建名为 `name` 的 worktree（新建同名分支）。返回新 worktree 的
/// 绝对路径（正斜杠）。若同名目录已存在、分支冲突或非 git 仓库则返回 Err。
pub fn create(project_path: &str, name: &str) -> Result<String, String> {
    if !valid_name(name) {
        return Err(format!("Invalid worktree name: {name}"));
    }
    let root = Path::new(project_path);
    if !root.is_dir() {
        return Err(format!("Project directory not found: {project_path}"));
    }
    if !is_git_repo(project_path) {
        return Err("Not a git repository".to_string());
    }
    let target = root.join(".claude").join("worktrees").join(name);
    if target.exists() {
        return Err(format!("Worktree already exists: {name}"));
    }
    let target_str = target.to_string_lossy().to_string();

    // 先试 `-b`（新建分支）；分支已存在时退回「附着到既有分支」。
    let new_branch = git_stdout(
        project_path,
        &["worktree", "add", &target_str, "-b", name],
    );
    if let Err(e) = new_branch {
        let lower = e.to_lowercase();
        if lower.contains("already exists") {
            git_stdout(project_path, &["worktree", "add", &target_str, name])
                .map_err(|e2| format!("git worktree add failed: {e2}"))?;
        } else {
            return Err(format!("git worktree add failed: {e}"));
        }
    }

    add_gitignore_exclude(project_path);
    register_root(project_path);
    Ok(normalize(&target_str))
}

/// 判断一个目录是否是 git worktree —— worktree 的 `.git` 是**文件**（内容 `gitdir: ...`），
/// 普通仓库根的 `.git` 是目录。这里只要 `.git` 存在即认为是有效工作树。
fn looks_like_worktree(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// 遍历候选父根目录，列出各自 `.claude/worktrees/*` 下的 worktree。
/// `parent_roots` 里本身就是 worktree 的（路径含 `.claude/worktrees`）会被跳过，避免嵌套扫描。
pub fn scan(parent_roots: &[String]) -> Vec<Worktree> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for root in parent_roots {
        let norm_root = normalize(root);
        if norm_root.contains("/.claude/worktrees/") {
            continue;
        }
        if !seen.insert(norm_root.clone()) {
            continue;
        }
        let wt_dir = Path::new(root).join(WT_SUBDIR);
        let rd = match fs::read_dir(&wt_dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_dir() || !looks_like_worktree(&p) {
                continue;
            }
            let name = match p.file_name() {
                Some(n) => n.to_string_lossy().to_string(),
                None => continue,
            };
            out.push(Worktree {
                path: normalize(&p.to_string_lossy()),
                name,
                parent_path: norm_root.clone(),
            });
        }
    }
    out
}

/// 全部删除 `path` 处的 worktree：`git worktree remove --force` 移除工作树，并
/// `git branch -D <分支>` 一并删掉其分支（不可撤销）。为安全起见只允许移除位于某个
/// `.claude/worktrees/` 之下的路径。会话记录不在此处理（前端已软删到回收站）。
pub fn remove(path: &str) -> Result<(), String> {
    let norm = normalize(path);
    if !norm.contains("/.claude/worktrees/") {
        return Err("Refusing to remove a path outside .claude/worktrees".to_string());
    }
    if !Path::new(path).exists() {
        return Err(format!("Worktree not found: {path}"));
    }
    // 删分支要在工作树移除前先取到分支名（移除后 path 就没了）。detached HEAD 返回 "HEAD"，
    // 这种情况没有可删的具名分支，跳过。
    let branch = git_stdout(path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD");
    // 从 worktree 的 git-common-dir 反推主仓库根，在主仓库上下文里执行 remove，
    // 避免「不能移除当前所在工作树」的报错。
    let common = git_stdout(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let repo_root = Path::new(&common)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to resolve repo root".to_string())?;
    // git worktree remove 在 Windows 上偶发 "Invalid argument"（EINVAL）：它自带的目录
    // 清理在删完内容后、最后一步 rmdir 时报错，但内容多半已删。因此不把这个错误当致命 ——
    // 兜底：残留目录用 Rust 强删（更可靠），再 `worktree prune` 清掉悬空注册。否则会出现
    // 「其实删掉了却弹错、侧栏还留着要手动刷新」。
    if git_stdout(&repo_root, &["worktree", "remove", "--force", path]).is_err() {
        if Path::new(path).exists() {
            fs::remove_dir_all(path)
                .map_err(|e| format!("Failed to remove worktree dir: {e}"))?;
        }
        let _ = git_stdout(&repo_root, &["worktree", "prune"]);
    }
    // 工作树注册已清 → 分支不再被占用，可安全 `-D` 强删（含未合并提交）。分支删不掉只报错，
    // 工作树已经没了、重试无意义。
    if let Some(b) = branch {
        git_stdout(&repo_root, &["branch", "-D", &b])
            .map_err(|e| format!("git branch -D failed: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_name_accepts_reasonable_branch_names() {
        assert!(valid_name("test-aaa"));
        assert!(valid_name("feature_login"));
        assert!(valid_name("v1.2.3"));
        assert!(valid_name("abc123"));
    }

    #[test]
    fn valid_name_rejects_dangerous_input() {
        assert!(!valid_name(""));
        assert!(!valid_name("-rf")); // leading dash → git option injection
        assert!(!valid_name("..")); // traversal
        assert!(!valid_name("a/b")); // slash → nested path
        assert!(!valid_name("a b")); // space
        assert!(!valid_name("foo..bar")); // embedded ..
        assert!(!valid_name(&"x".repeat(101))); // too long
    }

    #[test]
    fn normalize_unifies_separators_and_trailing_slash() {
        assert_eq!(normalize("C:\\a\\b\\"), "C:/a/b");
        assert_eq!(normalize("/a/b/"), "/a/b");
        assert_eq!(normalize("/a/b"), "/a/b");
        assert_eq!(normalize("/"), "/");
    }

    #[test]
    fn remove_refuses_paths_outside_worktrees_dir() {
        let err = remove("/tmp/some/random/dir").unwrap_err();
        assert!(err.contains("Refusing"));
    }
}
