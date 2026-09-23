#![windows_subsystem = "windows"]

use std::process::{Command, Stdio};

fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(program) = args.next() else {
        std::process::exit(2);
    };
    let rest: Vec<_> = args.collect();
    let mut child = Command::new(program);
    child
        .args(rest)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x0800_0000);
    }
    match child.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(_) => std::process::exit(1),
    }
}
