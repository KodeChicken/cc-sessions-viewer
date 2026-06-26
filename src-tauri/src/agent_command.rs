#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCommand {
    program: String,
    args: Vec<String>,
    extra_args: String,
}

impl AgentCommand {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            extra_args: String::new(),
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn with_extra_args(mut self, extra: &str) -> Self {
        self.extra_args = extra.trim().to_string();
        self
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn to_posix_shell(&self) -> String {
        let mut parts = Vec::with_capacity(1 + self.args.len() + usize::from(!self.extra_args.is_empty()));
        parts.push(posix_quote(&self.program));
        parts.extend(self.args.iter().map(|arg| posix_quote(arg)));
        if !self.extra_args.is_empty() {
            parts.push(self.extra_args.clone());
        }
        parts.join(" ")
    }

    #[cfg(target_os = "windows")]
    pub fn to_powershell(&self) -> String {
        let mut parts = Vec::with_capacity(2 + self.args.len() + usize::from(!self.extra_args.is_empty()));
        parts.push("&".to_string());
        parts.push(powershell_quote(&self.program));
        parts.extend(self.args.iter().map(|arg| powershell_quote(arg)));
        if !self.extra_args.is_empty() {
            parts.push(self.extra_args.clone());
        }
        parts.join(" ")
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "windows")]
pub fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
pub fn powershell_set_location_and_run(cwd: &str, command: &AgentCommand) -> String {
    let cwd = powershell_quote(cwd);
    format!(
        "{}; Set-Location -LiteralPath {cwd}; {}",
        powershell_refresh_path(),
        command.to_powershell()
    )
}

#[cfg(target_os = "windows")]
fn powershell_refresh_path() -> &'static str {
    "$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine'); \
     $userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); \
     $processPath = [Environment]::GetEnvironmentVariable('Path', 'Process'); \
     $env:Path = (@($processPath, $userPath, $machinePath) -ne '') -join ';'"
}

#[cfg(target_os = "windows")]
static PATH_CACHE_REFRESHING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 将 PowerShell 命令编码为 `-EncodedCommand` 所需的 Base64 (UTF-16LE)。
/// 打包后的 .app 经 `cmd /c start "" powershell.exe -Command "..."` 启动时，
/// CMD 的引号层会吞掉 `$`、`@`、`&` 等特殊字符，导致 PATH 刷新失败。
/// `-EncodedCommand` 完全绕过引号解析，是 Windows 上最可靠的传参方式。
#[cfg(target_os = "windows")]
pub fn powershell_encoded_command(ps_cmd: &str) -> String {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    let utf16le: Vec<u8> = ps_cmd.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    B64.encode(utf16le)
}

/// 返回 User + Machine PATH 与当前进程 PATH 的合并结果。
/// 打包后的 .app 可能从安装器 / 升级器继承了不完整的 PATH（缺 nvm / volta / fnm 等），
/// 这里用后台缓存避免每次启动终端都同步等待 `reg query`。
#[cfg(target_os = "windows")]
pub fn merged_system_path() -> String {
    if let Some(cached) = cached_merged_system_path() {
        return cached;
    }
    warm_merged_system_path_cache();
    std::env::var("PATH").unwrap_or_default()
}

#[cfg(target_os = "windows")]
pub fn warm_merged_system_path_cache() {
    if PATH_CACHE_REFRESHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if std::thread::Builder::new()
        .name("windows-path-cache".to_string())
        .spawn(|| {
            let path = build_merged_system_path();
            if let Ok(mut cached) = path_cache().write() {
                *cached = Some(path);
            }
            PATH_CACHE_REFRESHING.store(false, std::sync::atomic::Ordering::SeqCst);
        })
        .is_err()
    {
        PATH_CACHE_REFRESHING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(target_os = "windows")]
fn cached_merged_system_path() -> Option<String> {
    path_cache().read().ok().and_then(|cached| cached.clone())
}

#[cfg(target_os = "windows")]
fn path_cache() -> &'static std::sync::RwLock<Option<String>> {
    static PATH_CACHE: std::sync::OnceLock<std::sync::RwLock<Option<String>>> =
        std::sync::OnceLock::new();
    PATH_CACHE.get_or_init(|| std::sync::RwLock::new(None))
}

#[cfg(target_os = "windows")]
fn build_merged_system_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let user = read_registry_path("HKCU\\Environment");
    let machine = read_registry_path("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
    let mut seen = std::collections::HashSet::new();
    let mut merged = String::new();
    for entry in current.split(';').chain(user.split(';')).chain(machine.split(';')) {
        let trimmed = entry.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_ascii_lowercase()) {
            if !merged.is_empty() {
                merged.push(';');
            }
            merged.push_str(trimmed);
        }
    }
    merged
}

#[cfg(target_os = "windows")]
fn read_registry_path(key: &str) -> String {
    std::process::Command::new("reg")
        .args(["query", key, "/v", "Path"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let stdout = String::from_utf8_lossy(&o.stdout);
            for line in stdout.lines() {
                let line = line.trim();
                if line.to_ascii_lowercase().starts_with("path") {
                    // 格式: "Path    REG_EXPAND_SZ    C:\Users\..."
                    // 跳过 "Path" 和类型 ("REG_SZ" / "REG_EXPAND_SZ")，取剩余部分。
                    if let Some(rest) = line.find("REG_") {
                        let after_type = &line[rest..];
                        if let Some(pos) = after_type.find(char::is_whitespace) {
                            let value = after_type[pos..].trim();
                            if !value.is_empty() {
                                return Some(value.to_string());
                            }
                        }
                    }
                }
            }
            None
        })
        .unwrap_or_default()
}
