// Git 变更查看面板的后端支持：全部通过 `git` 子进程 CLI 调用，不引入 git 库。
// `cwd` 决定仓库位置；`hash` / `path` 是用户可控输入，经 stdin/参数拼进 shell 之外的
// `Command::args`（无 shell 解释），但仍需白名单校验防止路径穿越或参数注入（如 `--upload-pack`）。

use crate::types::{DiffHunk, GitCommit, GitDiffFile, GitFileStatus, GitRepositoryState};
use crate::util::{git_current_branch, parse_unified_diff, silent_command};

fn valid_hash(s: &str) -> bool {
    (7..=40).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_path(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.split('/').any(|seg| seg == "..")
}

fn repo_root(cwd: &str) -> Result<String, String> {
    let output = silent_command("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = silent_command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `git diff --no-index` 用退出码 1 表示「文件不同」，这是未跟踪文件生成 diff 的正常结果。
fn run_git_diff(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = silent_command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn git_has_repo(cwd: &str) -> bool {
    silent_command("git")
        .arg("-C")
        .arg(cwd)
        .arg("rev-parse")
        .arg("--git-dir")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn parse_log_output(text: &str) -> Vec<GitCommit> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\u{0}');
            Some(GitCommit {
                hash: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
                message: parts.next()?.to_string(),
            })
        })
        .collect()
}

pub fn git_log(cwd: &str, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let limit_flag = format!("-{}", limit.unwrap_or(50));
    let out = run_git(
        cwd,
        &["log", &limit_flag, "--format=%H%x00%an%x00%aI%x00%s"],
    )?;
    Ok(parse_log_output(&out))
}

fn parse_status_output(text: &str) -> Vec<GitFileStatus> {
    text.lines()
        .filter(|line| line.len() >= 3)
        .map(|line| {
            let xy = &line[0..2];
            let rest = line[3..].trim();
            let path = match rest.split_once(" -> ") {
                Some((_, new_path)) => new_path.to_string(),
                None => rest.to_string(),
            };
            let status = if xy == "??" {
                "?".to_string()
            } else {
                let x = xy.as_bytes()[0] as char;
                let y = xy.as_bytes()[1] as char;
                (if x != ' ' { x } else { y }).to_string()
            };
            GitFileStatus { path, status }
        })
        .collect()
}

pub fn git_status(cwd: &str) -> Result<Vec<GitFileStatus>, String> {
    let out = run_git(cwd, &["status", "--porcelain", "-uall"])?;
    Ok(parse_status_output(&out))
}

fn parse_branch_output(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(str::to_string)
        .collect()
}

fn local_branches(cwd: &str) -> Result<Vec<String>, String> {
    let out = run_git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=refname",
            "refs/heads",
        ],
    )?;
    Ok(parse_branch_output(&out))
}

pub fn git_repository_state(cwd: &str) -> Result<GitRepositoryState, String> {
    if !git_has_repo(cwd) {
        return Ok(GitRepositoryState {
            branch: None,
            branches: vec![],
            change_count: 0,
        });
    }
    Ok(GitRepositoryState {
        branch: git_current_branch(cwd),
        branches: local_branches(cwd)?,
        change_count: git_status(cwd)?.len(),
    })
}

/// 切换仅限已存在的本地分支。若 working tree 不干净则拒绝，避免把未提交改动带到新分支。
pub fn git_switch_branch(cwd: &str, branch: &str) -> Result<GitRepositoryState, String> {
    if !git_has_repo(cwd) {
        return Err("Not a git repository".to_string());
    }
    let branches = local_branches(cwd)?;
    if !branches.iter().any(|candidate| candidate == branch) {
        return Err("Branch does not exist locally".to_string());
    }
    let changes = git_status(cwd)?;
    if !changes.is_empty() {
        return Err(format!(
            "Cannot switch branches with {} uncommitted change(s)",
            changes.len()
        ));
    }
    run_git(cwd, &["switch", "--", branch])?;
    git_repository_state(cwd)
}

/// 只删除已合并的非当前本地分支。`git branch -d` 的非强制语义会保护未合并提交。
pub fn git_delete_branch(cwd: &str, branch: &str) -> Result<GitRepositoryState, String> {
    if !git_has_repo(cwd) {
        return Err("Not a git repository".to_string());
    }
    let branches = local_branches(cwd)?;
    if !branches.iter().any(|candidate| candidate == branch) {
        return Err("Branch does not exist locally".to_string());
    }
    if git_current_branch(cwd).as_deref() == Some(branch) {
        return Err("Cannot delete the current branch".to_string());
    }
    run_git(cwd, &["branch", "-d", "--", branch])?;
    git_repository_state(cwd)
}

/// 从当前 HEAD 创建一个本地分支，但不切换工作目录。分支名由 Git 原生校验。
pub fn git_create_branch(cwd: &str, branch: &str) -> Result<GitRepositoryState, String> {
    if !git_has_repo(cwd) {
        return Err("Not a git repository".to_string());
    }
    if branch.trim().is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if local_branches(cwd)?
        .iter()
        .any(|candidate| candidate == branch)
    {
        return Err("Branch already exists locally".to_string());
    }
    run_git(cwd, &["branch", "--", branch])?;
    git_repository_state(cwd)
}

fn parse_numstat_output(text: &str) -> Vec<GitDiffFile> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let additions_raw = parts.next()?;
            let deletions_raw = parts.next()?;
            let path = parts.next()?.to_string();
            let additions: u32 = additions_raw.parse().unwrap_or(0);
            let deletions: u32 = deletions_raw.parse().unwrap_or(0);
            let status = if additions == 0 {
                "D"
            } else if deletions == 0 {
                "A"
            } else {
                "M"
            };
            Some(GitDiffFile {
                path,
                additions,
                deletions,
                status: status.to_string(),
            })
        })
        .collect()
}

pub fn git_diff_files(cwd: &str, git_ref: &str) -> Result<Vec<GitDiffFile>, String> {
    let root = repo_root(cwd)?;
    let mut files = if git_ref == "working" {
        let out = run_git(&root, &["diff", "HEAD", "--numstat"])?;
        let mut files = parse_numstat_output(&out);
        for status in git_status(&root)?
            .into_iter()
            .filter(|file| file.status == "?")
        {
            let out = run_git_diff(
                &root,
                &[
                    "diff",
                    "--no-index",
                    "--numstat",
                    "--",
                    "/dev/null",
                    &status.path,
                ],
            )?;
            let stats = parse_numstat_output(&out).into_iter().next();
            files.push(GitDiffFile {
                path: status.path,
                additions: stats.as_ref().map_or(0, |file| file.additions),
                deletions: 0,
                status: "A".to_string(),
            });
        }
        files
    } else {
        if !valid_hash(git_ref) {
            return Err("Invalid commit hash".to_string());
        }
        let out = run_git(
            &root,
            &["diff-tree", "-r", "--numstat", "--no-commit-id", git_ref],
        )?;
        parse_numstat_output(&out)
    };
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

pub fn git_diff_file(cwd: &str, git_ref: &str, path: &str) -> Result<Vec<DiffHunk>, String> {
    if !valid_path(path) {
        return Err("Invalid path".to_string());
    }
    let root = repo_root(cwd)?;
    let out = if git_ref == "working" {
        if git_status(&root)?
            .iter()
            .any(|file| file.status == "?" && file.path == path)
        {
            run_git_diff(&root, &["diff", "--no-index", "--", "/dev/null", path])?
        } else {
            run_git(&root, &["diff", "HEAD", "--", path])?
        }
    } else {
        if !valid_hash(git_ref) {
            return Err("Invalid commit hash".to_string());
        }
        let range = format!("{git_ref}^..{git_ref}");
        run_git(&root, &["diff", &range, "--", path])?
    };
    Ok(parse_unified_diff(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_hash_accepts_short_and_full_sha() {
        assert!(valid_hash("abc1234"));
        assert!(valid_hash("0123456789abcdef0123456789abcdef01234567"));
    }

    #[test]
    fn valid_hash_rejects_bad_input() {
        assert!(!valid_hash("abc12")); // too short
        assert!(!valid_hash("ABC1234")); // uppercase
        assert!(!valid_hash("abc123g")); // non-hex
        assert!(!valid_hash("")); // empty
    }

    #[test]
    fn valid_path_rejects_traversal_and_absolute() {
        assert!(valid_path("src/util.rs"));
        assert!(!valid_path("../etc/passwd"));
        assert!(!valid_path("src/../../etc/passwd"));
        assert!(!valid_path("/etc/passwd"));
        assert!(!valid_path(""));
    }

    #[test]
    fn parse_log_output_splits_nul_separated_fields() {
        let text = "abc123\u{0}Jane Doe\u{0}2026-07-06T00:00:00Z\u{0}fix: thing\n";
        let commits = parse_log_output(text);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].author, "Jane Doe");
        assert_eq!(commits[0].message, "fix: thing");
    }

    #[test]
    fn parse_status_output_handles_modified_added_untracked() {
        let text = " M src/util.rs\nA  src/new.rs\n?? src/scratch.rs\n";
        let files = parse_status_output(text);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].path, "src/util.rs");
        assert_eq!(files[1].status, "A");
        assert_eq!(files[2].status, "?");
    }

    #[test]
    fn parse_status_output_handles_rename() {
        let text = "R  old.rs -> new.rs\n";
        let files = parse_status_output(text);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "R");
        assert_eq!(files[0].path, "new.rs");
    }

    #[test]
    fn parse_branch_output_ignores_blank_lines() {
        assert_eq!(
            parse_branch_output("develop\n\nfeature/chat\nmain\n"),
            vec!["develop", "feature/chat", "main"]
        );
    }

    #[test]
    fn git_switch_branch_requires_a_clean_worktree() {
        let dir = std::env::temp_dir().join(format!("cssv_git_switch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();

        run_git(cwd, &["init"]).unwrap();
        run_git(cwd, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(cwd, &["config", "user.name", "Test User"]).unwrap();
        std::fs::write(dir.join("README.md"), "initial\n").unwrap();
        run_git(cwd, &["add", "README.md"]).unwrap();
        run_git(cwd, &["commit", "-m", "initial"]).unwrap();
        let initial_branch = git_current_branch(cwd).unwrap();
        git_create_branch(cwd, "feature/branch-menu").unwrap();
        assert!(local_branches(cwd)
            .unwrap()
            .iter()
            .any(|branch| branch == "feature/branch-menu"));
        run_git(cwd, &["switch", "feature/branch-menu"]).unwrap();
        run_git(cwd, &["switch", &initial_branch]).unwrap();

        let switched = git_switch_branch(cwd, "feature/branch-menu").unwrap();
        assert_eq!(switched.branch.as_deref(), Some("feature/branch-menu"));

        std::fs::write(dir.join("dirty.txt"), "uncommitted\n").unwrap();
        let error = match git_switch_branch(cwd, &initial_branch) {
            Ok(_) => panic!("a dirty worktree must not switch branches"),
            Err(error) => error,
        };
        assert!(error.contains("uncommitted change"));

        std::fs::remove_file(dir.join("dirty.txt")).unwrap();
        git_switch_branch(cwd, &initial_branch).unwrap();
        let after_delete = git_delete_branch(cwd, "feature/branch-menu").unwrap();
        assert!(!after_delete
            .branches
            .iter()
            .any(|branch| branch == "feature/branch-menu"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_diff_includes_untracked_working_files() {
        let dir =
            std::env::temp_dir().join(format!("cssv_git_untracked_diff_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();

        run_git(cwd, &["init"]).unwrap();
        run_git(cwd, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(cwd, &["config", "user.name", "Test User"]).unwrap();
        std::fs::write(dir.join("README.md"), "initial\n").unwrap();
        run_git(cwd, &["add", "README.md"]).unwrap();
        run_git(cwd, &["commit", "-m", "initial"]).unwrap();

        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("docs/new.md"), "first line\nsecond line\n").unwrap();

        let files = git_diff_files(cwd, "working").unwrap();
        let file = files
            .iter()
            .find(|file| file.path == "docs/new.md")
            .unwrap();
        assert_eq!(file.status, "A");
        assert_eq!(file.additions, 2);
        assert_eq!(file.deletions, 0);

        let hunks = git_diff_file(cwd, "working", "docs/new.md").unwrap();
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == "add" && line.text == "first line"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_numstat_output_derives_status() {
        let text = "5\t0\tsrc/added.rs\n0\t5\tsrc/deleted.rs\n3\t2\tsrc/modified.rs\n";
        let files = parse_numstat_output(text);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "A");
        assert_eq!(files[1].status, "D");
        assert_eq!(files[2].status, "M");
    }
}
