use crate::types::{CliDiagnosisResult, CliInstallation, CliUpgradeResult, CliVersionInfo};
use std::process::Command;
use std::time::Duration;

struct CliSpec {
    name: &'static str,
    binary: &'static str,
    npm_package: &'static str,
    upgrade_cmd: &'static str,
}

const CLI_SPECS: &[CliSpec] = &[
    CliSpec {
        name: "claude",
        binary: "claude",
        npm_package: "@anthropic-ai/claude-code",
        upgrade_cmd: "claude update",
    },
    CliSpec {
        name: "codex",
        binary: "codex",
        npm_package: "@openai/codex",
        upgrade_cmd: "codex update",
    },
    CliSpec {
        name: "gemini",
        binary: "gemini",
        npm_package: "@google/gemini-cli",
        upgrade_cmd: "npm install -g @google/gemini-cli@latest",
    },
];

fn find_spec(cli_name: &str) -> Result<&'static CliSpec, String> {
    CLI_SPECS
        .iter()
        .find(|s| s.name == cli_name)
        .ok_or_else(|| format!("unknown CLI: {cli_name}"))
}

// ---- shell helpers ----

#[cfg(unix)]
fn run_in_login_shell(cmd: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    const DEFAULT_SHELL: &str = "/bin/zsh";
    #[cfg(not(target_os = "macos"))]
    const DEFAULT_SHELL: &str = "/bin/bash";

    let shell = std::env::var("SHELL").unwrap_or_else(|_| DEFAULT_SHELL.to_string());
    let out = Command::new(&shell)
        .args(["-l", "-i", "-c", cmd])
        .output()
        .map_err(|e| format!("shell exec: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("exit {}", out.status.code().unwrap_or(-1))
        } else {
            stderr
        })
    }
}

#[cfg(windows)]
fn run_in_login_shell(cmd: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let out = Command::new("powershell.exe")
        .args(["-NoLogo", "-Command", cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("powershell exec: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ---- version helpers ----

fn extract_version(output: &str) -> Option<String> {
    let re = regex_lite::Regex::new(r"(\d+\.\d+\.\d+)").ok()?;
    re.captures(output).map(|c| c[1].to_string())
}

fn get_installed_version(spec: &CliSpec) -> Option<String> {
    let out = run_in_login_shell(&format!("{} --version", spec.binary)).ok()?;
    extract_version(&out)
}

fn fetch_npm_latest(package: &str) -> Result<String, String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let try_once = || -> Result<String, String> {
        let resp: serde_json::Value = ureq::get(&url)
            .timeout(Duration::from_secs(10))
            .call()
            .map_err(|e| format!("npm registry: {e}"))?
            .into_json()
            .map_err(|e| format!("parse json: {e}"))?;
        resp.get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "missing version field".into())
    };
    match try_once() {
        Ok(v) => Ok(v),
        Err(_) => {
            std::thread::sleep(Duration::from_millis(500));
            try_once()
        }
    }
}

fn compare_versions(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.').filter_map(|p| p.parse().ok()).collect()
    };
    let cur = parse(current);
    let lat = parse(latest);
    for i in 0..cur.len().max(lat.len()) {
        let c = cur.get(i).copied().unwrap_or(0);
        let l = lat.get(i).copied().unwrap_or(0);
        if c < l {
            return true;
        }
        if c > l {
            return false;
        }
    }
    false
}

fn check_cli_version(spec: &CliSpec) -> CliVersionInfo {
    let current = get_installed_version(spec);
    let installed = current.is_some();
    let latest = fetch_npm_latest(spec.npm_package);
    let (latest_version, error) = match latest {
        Ok(v) => (Some(v), None),
        Err(e) => (None, Some(e)),
    };
    let upgradable = match (&current, &latest_version) {
        (Some(c), Some(l)) => compare_versions(c, l),
        _ => false,
    };
    CliVersionInfo {
        cli: spec.name.to_string(),
        npm_package: spec.npm_package.to_string(),
        current_version: current,
        latest_version,
        upgradable,
        installed,
        error,
    }
}

pub fn check_all_versions() -> Vec<CliVersionInfo> {
    std::thread::scope(|s| {
        let handles: Vec<_> = CLI_SPECS
            .iter()
            .map(|spec| s.spawn(|| check_cli_version(spec)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| CliVersionInfo {
                cli: String::new(),
                npm_package: String::new(),
                current_version: None,
                latest_version: None,
                upgradable: false,
                installed: false,
                error: Some("thread panic".into()),
            }))
            .collect()
    })
}

// ---- upgrade ----

/// For npm-based CLIs, resolve the correct upgrade command by:
/// 1. Finding the CLI binary's bin directory
/// 2. Using the sibling npm binary from that same directory
/// 3. Setting NPM_CONFIG_PREFIX to the node root so npm writes to the right
///    global — without this, a user-level .npmrc `prefix=` can redirect
///    installs to a different node manager's tree.
fn resolve_upgrade_cmd(spec: &CliSpec) -> String {
    if spec.upgrade_cmd.starts_with("npm ") {
        if let Some(first) = find_all_paths(spec.binary).into_iter().next() {
            if let Some(bin_dir) = first.rsplit_once('/').map(|(d, _)| d) {
                let sibling_npm = format!("{bin_dir}/npm");
                if std::path::Path::new(&sibling_npm).exists() {
                    let node_root = bin_dir.rsplit_once('/').map(|(d, _)| d).unwrap_or(bin_dir);
                    let npm_part = spec.upgrade_cmd.replacen("npm ", &format!("'{sibling_npm}' "), 1);
                    return format!("NPM_CONFIG_PREFIX='{node_root}' {npm_part}");
                }
            }
        }
    }
    spec.upgrade_cmd.to_string()
}

pub fn upgrade_single(cli_name: &str) -> Result<CliUpgradeResult, String> {
    let spec = find_spec(cli_name)?;
    let cmd = resolve_upgrade_cmd(spec);
    match run_in_login_shell(&cmd) {
        Ok(_) => {
            let new_version = get_installed_version(spec);
            Ok(CliUpgradeResult {
                cli: spec.name.to_string(),
                success: true,
                new_version,
                error: None,
            })
        }
        Err(e) => Ok(CliUpgradeResult {
            cli: spec.name.to_string(),
            success: false,
            new_version: None,
            error: Some(e),
        }),
    }
}

pub fn upgrade_all() -> Result<Vec<CliUpgradeResult>, String> {
    let versions = check_all_versions();
    let results: Vec<_> = versions
        .iter()
        .filter(|v| v.upgradable)
        .filter_map(|v| upgrade_single(&v.cli).ok())
        .collect();
    Ok(results)
}

// ---- diagnosis ----

#[cfg(unix)]
fn find_all_paths(binary: &str) -> Vec<String> {
    run_in_login_shell(&format!("which -a {binary} 2>/dev/null"))
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| l.starts_with('/'))
        .collect()
}

#[cfg(windows)]
fn find_all_paths(binary: &str) -> Vec<String> {
    run_in_login_shell(&format!("where {binary} 2>$null"))
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn get_version_at_path(path: &str) -> Option<String> {
    let out = run_in_login_shell(&format!("'{}' --version", path.replace('\'', "'\\''"))).ok()?;
    extract_version(&out)
}

fn resolve_symlink(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

fn detect_package_manager(resolved: &str) -> String {
    let r = resolved.to_lowercase();
    if r.contains("/caskroom/") || r.contains("\\caskroom\\") {
        "homebrew-cask".into()
    } else if r.contains("/cellar/") || r.contains("\\cellar\\") {
        "homebrew".into()
    } else if r.contains("/.nvm/") || r.contains("\\.nvm\\") {
        "nvm".into()
    } else if r.contains("/.volta/") || r.contains("\\.volta\\") {
        "volta".into()
    } else if r.contains("/.fnm/") || r.contains("\\.fnm\\") {
        "fnm".into()
    } else if r.contains("/node_modules/") || r.contains("\\node_modules\\") {
        "npm".into()
    } else {
        "system".into()
    }
}

fn is_temp_path(path: &str) -> bool {
    (path.contains("/var/folders/") && path.contains("/T/"))
        || path.starts_with("/tmp/")
        || path.starts_with("/temp/")
}

pub fn diagnose(cli_name: &str) -> Result<CliDiagnosisResult, String> {
    let spec = find_spec(cli_name)?;
    let raw_paths = find_all_paths(spec.binary);

    // 1. Deduplicate raw paths (which -a returns duplicates when PATH has
    //    the same directory listed multiple times)
    let mut seen_raw = std::collections::HashSet::new();
    let unique_paths: Vec<_> = raw_paths
        .into_iter()
        .filter(|p| seen_raw.insert(p.clone()))
        .collect();

    // 2. Build installations, deduplicating by resolved (canonical) path so
    //    symlinks that point to the same binary count as one installation
    let mut seen_resolved = std::collections::HashSet::new();
    let mut installations = Vec::new();
    for path in &unique_paths {
        if is_temp_path(path) {
            continue;
        }
        let resolved = resolve_symlink(path);
        let resolved_key = resolved.clone().unwrap_or_else(|| path.clone());
        if !seen_resolved.insert(resolved_key) {
            continue;
        }
        let version = get_version_at_path(path);
        let pm = resolved
            .as_deref()
            .map(detect_package_manager)
            .unwrap_or_else(|| "unknown".into());
        installations.push(CliInstallation {
            path: path.clone(),
            version,
            is_default: installations.is_empty(),
            package_manager: pm,
            resolved_path: resolved,
        });
    }

    let has_conflict = installations.len() > 1;
    Ok(CliDiagnosisResult {
        cli: spec.name.to_string(),
        binary_name: spec.binary.to_string(),
        installations,
        has_conflict,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_version() {
        assert_eq!(
            extract_version("2.1.187 (Claude Code)"),
            Some("2.1.187".into())
        );
        assert_eq!(
            extract_version("codex-cli 0.142.3"),
            Some("0.142.3".into())
        );
        assert_eq!(extract_version("0.43.0"), Some("0.43.0".into()));
        assert_eq!(extract_version("no version here"), None);
    }

    #[test]
    fn test_compare_versions() {
        assert!(compare_versions("2.1.187", "2.1.197"));
        assert!(!compare_versions("2.1.197", "2.1.187"));
        assert!(!compare_versions("2.1.187", "2.1.187"));
        assert!(compare_versions("0.43.0", "0.49.0"));
        assert!(compare_versions("0.142.3", "0.142.5"));
    }

    #[test]
    fn test_detect_package_manager() {
        assert_eq!(
            detect_package_manager("/opt/homebrew/Caskroom/claude-code/2.1.187/claude"),
            "homebrew-cask"
        );
        assert_eq!(
            detect_package_manager(
                "/Users/u/.nvm/versions/node/v22.21.1/lib/node_modules/@openai/codex/bin/codex.js"
            ),
            "nvm"
        );
        assert_eq!(
            detect_package_manager("/Users/u/.volta/bin/gemini"),
            "volta"
        );
        assert_eq!(
            detect_package_manager("/usr/local/lib/node_modules/@google/gemini-cli/bin/gemini"),
            "npm"
        );
        assert_eq!(detect_package_manager("/usr/bin/claude"), "system");
    }
}
