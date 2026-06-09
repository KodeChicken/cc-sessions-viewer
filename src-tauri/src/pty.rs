// 嵌入终端 (in-app TUI) —— 在窗口里直接跑 CLI，免去切到 Terminal.app。
//
// 设计：
//   - 用 `portable-pty` 开一个伪终端 —— Unix 走 forkpty + openpty，Windows 走 ConPTY
//     (Win10 1809+，比这老的版本会在 openpty 时报错，前端能看到原话）。
//   - 把用户登录 shell 拉起来，让它 `cd '<cwd>'` 后跑 resume CLI。
//     · POSIX (`macOS / Linux`)：`$SHELL -l -i -c "cd '<cwd>' && <cli>"`。
//       `-l + -i` 同时给：login shell source `.zprofile` / `.bash_profile`，interactive
//       shell source `.zshrc` / `.bashrc`。npm global / nvm / fnm / volta 通常把 PATH
//       export 在 rc 文件里，少一个都可能找不到 claude / codex / gemini。
//     · Windows：`powershell.exe -NoLogo -Command "Set-Location -LiteralPath '<cwd>'; <cli>"`。
//       挑 `powershell.exe`（Win10+ 自带）而不是 `pwsh.exe`（PS7，要单独装）以兼容空机器；
//       `-Command` 默认会 load `$PROFILE`，nvm-windows / volta-win 在 profile 里改的 PATH
//       也能拿到。msi / choco 安装的 CLI 直接走系统 PATH，无 profile 也能找到。
//   - 给每个活跃 PTY 分配一个 `u64` id，前端拿着 id 调 write / resize / kill。
//   - 派一个 reader 线程不停读 master 端字节，base64 后 emit 给前端 xterm 绘制。
//     另外派一个 waiter 线程 try_wait 子进程退出，emit 一次 `pty://exit`。
//   - 同进程允许多个 PTY 并存（用户可能边切会话边在另一条上跑 CLI）—— 状态藏在
//     `OnceLock<Mutex<HashMap<id, Arc<PtyHandle>>>>` 里。
//
// 前端事件契约：
//   pty://data   { id: u64, base64: string }     PTY stdout 的原始字节
//   pty://exit   { id: u64, code: i32 }          子进程退出，前端关闭 pane
//
// 不在这里读 JSONL —— 真正的会话内容由 watch.rs 的 file-tail 通道继续推回 ChatView，
// 用户从 TUI 切回 view 模式时直接 read_session 整段重拉即可。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agent_command::AgentCommand;

struct PtyHandle {
    /// 保留 master 主要为了 resize（reader / writer 都已克隆出去）。
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// 写端：前端键盘输入解 base64 后写进来；Mutex 保护并发输入（罕见但稳）。
    writer: Mutex<Box<dyn Write + Send>>,
    /// 子进程句柄：kill 时用；waiter 线程 try_wait 走一份独立的弱引用避免长锁。
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

static PTYS: OnceLock<Mutex<HashMap<u64, Arc<PtyHandle>>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn map() -> &'static Mutex<HashMap<u64, Arc<PtyHandle>>> {
    PTYS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
struct DataPayload {
    id: u64,
    /// base64(原始 PTY 字节)。让前端拿 raw 字节喂给 xterm，避免 utf-8 截断 / 控制字符变形。
    base64: String,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: u64,
    code: i32,
}

/// 按 OS 组装 shell 调用。
///
/// POSIX (macOS / Linux) → `$SHELL -l -i -c "cd '<cwd>' && <cli>"`，让 login + interactive
/// shell 同时 source 两套 rc 文件，把 nvm / fnm / volta / npm-global 在 rc 里 export 的
/// PATH 都拉进来。SHELL 缺省时 macOS 回退 zsh、Linux 回退 bash —— 各自系统默认。
///
/// Windows → `powershell.exe -NoLogo -Command "Set-Location -LiteralPath '<cwd>'; <cli>"`。
/// 用内置的 `powershell.exe`（PS 5.1，Win10+ 自带）而不是 PS7，免去用户额外装。
/// `-Command` 默认会 load `$PROFILE` —— nvm-windows / volta 在 profile 里改的 PATH 能
/// 拿到；msi / choco 装的 CLI 直接走系统 PATH。
///
/// `cwd` 已在 lib.rs 校验过是真实目录；`command` 已由 agent 构造并负责平台渲染。
#[cfg(unix)]
fn build_shell_command(cwd: &str, command: &AgentCommand) -> CommandBuilder {
    #[cfg(target_os = "macos")]
    const DEFAULT_SHELL: &str = "/bin/zsh";
    #[cfg(not(target_os = "macos"))]
    const DEFAULT_SHELL: &str = "/bin/bash";

    let shell = std::env::var("SHELL").unwrap_or_else(|_| DEFAULT_SHELL.to_string());
    // POSIX sh quoting：单引号字符串里 ' 改成 '\'' 关 + 转义 + 重开。
    let inner = format!("cd {} && {}", crate::agent_command::posix_quote(cwd), command.to_posix_shell());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.arg("-i");
    cmd.arg("-c");
    cmd.arg(&inner);
    // CLI 探测 isatty + ANSI 重绘都靠 TERM；xterm.js 默认按 xterm-256color 解析。
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(cwd);
    cmd
}

#[cfg(windows)]
fn build_shell_command(cwd: &str, command: &AgentCommand) -> CommandBuilder {
    // PowerShell 单引号字面串里 ' 用 '' 转义。
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    cmd.arg("-Command");
    cmd.arg(crate::agent_command::powershell_set_location_and_run(cwd, command));
    // ConPTY 自己处理 VT 序列；TERM 对 Win 上的 Node CLI（claude / codex / gemini）也无害。
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(cwd);
    cmd
}

/// 拉起 PTY 跑 OS 对应的 shell 调用（详见 [`build_shell_command`]）。
///
/// `command` 已由 agent 构造；`cwd` 已在 lib.rs 里校验是真实目录。返回新 PTY 的内部 id。
pub fn spawn(
    app: AppHandle,
    cwd: String,
    command: AgentCommand,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("项目目录已不存在，无法启动终端".into());
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty 失败: {e}"))?;

    // 按操作系统装配 shell 调用 —— 把 PATH 注入 + cwd 切换合并到一条命令里。
    // 见模块顶端注释，POSIX / Windows 各自的取舍都在那里。
    let cmd = build_shell_command(&cwd, &command);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn 失败: {e}"))?;
    // slave 端在父进程留着的话，PTY 永远不会 EOF；spawn 完立刻 drop。
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader 失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer 失败: {e}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let handle = Arc::new(PtyHandle {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    map()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, handle.clone());

    // ---- reader 线程：阻塞 read → base64 → emit ----
    let app_for_reader = app.clone();
    thread::spawn(move || reader_loop(app_for_reader, id, reader));

    // ---- waiter 线程：try_wait 退出码后 emit + 清理 ----
    let app_for_wait = app.clone();
    thread::spawn(move || waiter_loop(app_for_wait, id));

    Ok(id)
}

fn reader_loop(app: AppHandle, id: u64, mut reader: Box<dyn Read + Send>) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF —— slave 端被关 / 子进程退出。
            Ok(n) => {
                let payload = DataPayload {
                    id,
                    base64: B64.encode(&buf[..n]),
                };
                if app.emit("pty://data", payload).is_err() {
                    // 事件 emit 失败通常意味着 app 在 teardown —— 直接 break。
                    break;
                }
            }
            Err(e) => {
                // 任何 IO 错误（连接关闭 / 中断）一律退出。Waiter 线程会负责 emit exit。
                let _ = e;
                break;
            }
        }
    }
}

fn waiter_loop(app: AppHandle, id: u64) {
    loop {
        // 锁尽量短：拿一次 try_wait，没结果就 sleep。
        let res = {
            let arc = match map().lock().ok().and_then(|m| m.get(&id).cloned()) {
                Some(a) => a,
                None => return, // kill_pty 已经把它移走了，啥也别干。
            };
            let mut child = match arc.child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            child.try_wait()
        };
        match res {
            Ok(Some(status)) => {
                let code = status.exit_code() as i32;
                let _ = app.emit("pty://exit", ExitPayload { id, code });
                if let Ok(mut m) = map().lock() {
                    m.remove(&id);
                }
                return;
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(150));
            }
            Err(_) => {
                let _ = app.emit("pty://exit", ExitPayload { id, code: -1 });
                if let Ok(mut m) = map().lock() {
                    m.remove(&id);
                }
                return;
            }
        }
    }
}

pub fn write(id: u64, base64_data: &str) -> Result<(), String> {
    let arc = {
        let m = map().lock().map_err(|e| e.to_string())?;
        m.get(&id).cloned().ok_or_else(|| "pty 不存在".to_string())?
    };
    let bytes = B64
        .decode(base64_data)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let mut w = arc.writer.lock().map_err(|e| e.to_string())?;
    w.write_all(&bytes).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn resize(id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let arc = {
        let m = map().lock().map_err(|e| e.to_string())?;
        m.get(&id).cloned().ok_or_else(|| "pty 不存在".to_string())?
    };
    let master = arc.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize 失败: {e}"))
}

pub fn kill(id: u64) -> Result<(), String> {
    // 先把 entry 拿走 —— waiter 线程下一轮 try_wait 时会发现 entry 不见了直接 return，
    // 避免它在 child 已经被 drop 之后还去 emit 一个奇怪的 exit。
    let arc = {
        let mut m = map().lock().map_err(|e| e.to_string())?;
        m.remove(&id)
    };
    let Some(arc) = arc else {
        return Ok(());
    };
    if let Ok(mut child) = arc.child.lock() {
        let _ = child.kill();
        // wait 一下确保进程真死了，避免僵尸；非阻塞失败也不返回错（用户 expected：UI 即时回到 view）。
        let _ = child.wait();
    }
    Ok(())
}
