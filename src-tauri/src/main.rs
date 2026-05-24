#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Manager, Window};

// 状态管理：保存 PTY 的写入句柄，以便前端可以发送击键
struct PtyState {
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
}

// 核心隔离逻辑：为终端节点派生独立的 PTY 进程
#[tauri::command]
fn spawn_pty(window: Window, state: tauri::State<'_, PtyState>, cwd: String) -> Result<(), String> {
    let pty_system = NativePtySystem::default();
    
    // 初始化一个标准的 80x24 虚拟终端大小
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    // 跨平台 shell 适配
    let shell = if cfg!(windows) { "cmd.exe" } else { "bash" };
    let mut cmd = CommandBuilder::new(shell);
    
    // 目录隔离：限制该 PTY 进程的工作目录
    cmd.cwd(cwd);

    // 【关键】环境变量注入拦截层：在这里为 PTY 注入网关地址
    cmd.env("OPENAI_API_BASE", "http://127.0.0.1:18000/v1");
    cmd.env("OCEAN_AGENT_ID", "local-cli-01"); // 标识终端节点身份

    // 启动进程
    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // 保存 writer 供后续前端交互使用
    *state.writer.lock().unwrap() = Some(writer);

    // 开启独立线程：持续从 PTY 读取输出，并安全的通过 Tauri IPC 转发给前端 xterm.js
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            let output = String::from_utf8_lossy(&buf[..n]).to_string();
            // 通过 pty-output 事件将日志推送到前端 UI 沙盒
            window.emit("pty-output", output).unwrap_or(());
        }
    });

    Ok(())
}

// 前端输入桥接：将 xterm.js 中的键盘敲击安全地写入 PTY
#[tauri::command]
fn write_pty(input: String, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    if let Some(writer) = state.writer.lock().unwrap().as_mut() {
        writer.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(PtyState { writer: Arc::new(Mutex::new(None)) })
        .invoke_handler(tauri::generate_handler![spawn_pty, write_pty])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}