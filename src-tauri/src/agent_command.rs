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

    /// `wrapper` 给出时用它做进程包装器（`& 'reclaude' 'claude' ...`）：`&` 调用算子跑
    /// wrapper，原 program/args 全成 wrapper 的参数。与 posix 侧 `'reclaude' <cli>` 同款语义。
    #[cfg(target_os = "windows")]
    pub fn to_powershell(&self, wrapper: Option<&str>) -> String {
        let mut parts = Vec::with_capacity(
            2 + usize::from(wrapper.is_some()) + self.args.len() + usize::from(!self.extra_args.is_empty()),
        );
        parts.push("&".to_string());
        if let Some(wrapper) = wrapper {
            parts.push(powershell_quote(wrapper));
        }
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

/// `use_reclaude`：GUI 聊天 / 内嵌终端里把命令包一层 `reclaude`，走 reclaude 守护进程的
/// 鉴权 + 代理链路（与 posix 侧一致）。外部终端 resume 传 `false`。
#[cfg(target_os = "windows")]
pub fn powershell_set_location_and_run(cwd: &str, command: &AgentCommand, use_reclaude: bool) -> String {
    let cwd = powershell_quote(cwd);
    let wrapper = if use_reclaude { Some("reclaude") } else { None };
    format!(
        "{}; Set-Location -LiteralPath {cwd}; {}",
        powershell_refresh_path(),
        command.to_powershell(wrapper)
    )
}

/// 在 PowerShell 会话内把 PATH 重新拼一遍 —— 进程现有 PATH（已由 OS 展开，最可靠）打头，
/// 再补注册表里的 User + Machine PATH。与 v0.1.12 一致：$processPath 在前，保证继承到的
/// 完整 PATH 永远优先生效。
#[cfg(target_os = "windows")]
pub fn powershell_refresh_path() -> &'static str {
    "$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine'); \
     $userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); \
     $processPath = [Environment]::GetEnvironmentVariable('Path', 'Process'); \
     $env:Path = (@($processPath, $userPath, $machinePath) -ne '') -join ';'"
}

/// 选用哪个 PowerShell 可执行文件：优先 PowerShell 7（`pwsh.exe`，用户默认想用的那个），
/// 装了才用；没装则回退到系统自带的 Windows PowerShell 5.1（`powershell.exe`）以兼容空机器。
/// 检测只扫继承到的 PATH（PS7 安装器会把自己写进 Machine PATH），不另起子进程。
#[cfg(target_os = "windows")]
pub fn windows_powershell_exe() -> &'static str {
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            if dir.join("pwsh.exe").is_file() {
                return "pwsh.exe";
            }
        }
    }
    "powershell.exe"
}

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
