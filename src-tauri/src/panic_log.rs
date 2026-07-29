use std::backtrace::Backtrace;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::panic;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn install() {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = write_panic(info);
        default_hook(info);
    }));
}

fn write_panic(info: &panic::PanicHookInfo<'_>) -> io::Result<()> {
    let directory = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("cc-sessions-viewer");
    fs::create_dir_all(&directory)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("panic.log"))?;
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    writeln!(
        file,
        "unix_ms={timestamp_ms}\n{info}\nbacktrace:\n{}\n",
        Backtrace::force_capture()
    )
}
