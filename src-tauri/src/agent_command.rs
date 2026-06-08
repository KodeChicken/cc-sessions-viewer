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
