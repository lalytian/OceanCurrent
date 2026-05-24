#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use axum::{extract::State, routing::post, Json, Router};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager, Window};

struct PtyState {
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
}

// -----------------------------------------------------------------------------
// 1. 洋流专属本地拦截网关 (Ocean Interceptor Gateway) - 运行在 18000 端口
// -----------------------------------------------------------------------------
async fn handle_chat_completions(
    State(app): State<AppHandle>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    // A. 嗅探提取：解析第三方 CLI Agent 发送来的 Prompt
    let messages = payload.get("messages").and_then(|m| m.as_array());
    let last_msg = messages
        .and_then(|m| m.last())
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("No message");
    
    let model = payload.get("model").and_then(|m| m.as_str()).unwrap_or("unknown");

    println!("[Interceptor] 截获流量: {}", last_msg);

    // B. UI 驱动：将拦截到的数据广播给前端 ReactFlow 画布
    app.emit_all("gateway-intercept", json!({
        "agent_id": "ocean-aider",
        "prompt": last_msg,
        "model": model,
    })).unwrap_or(());

    // C. 上游转发：MVP 阶段为了演示闭环，我们直接在本地 Mock 一段大模型的回复
    // 实际生产中，这里使用 reqwest 把 payload 转发给 TideProxy (stsub.laly.ccwu.cc)
    Json(json!({
        "id": "chatcmpl-ocean-mock",
        "object": "chat.completion",
        "created": 1677652288,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": format!("(Ocean Interceptor已劫持) \n我正在处理你的指令：\n> {}\n\n[模拟数据完毕]", last_msg),
            },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 }
    }))
}

// 启动内嵌的 Axum 拦截网关
fn run_interceptor_gateway(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/v1/chat/completions", post(handle_chat_completions))
            .with_state(app);
            
        println!("[Ocean Gateway] 本地拦截网关已启动在 http://127.0.0.1:18000");
        axum::Server::bind(&"127.0.0.1:18000".parse().unwrap())
            .serve(router.into_make_service())
            .await
            .unwrap();
    });
}

fn expand_home(path: &str) -> String {
    if path.starts_with("~/") || path == "~" {
        let home = if cfg!(windows) {
            std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string())
        } else {
            std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string())
        };
        if path == "~" { home } else { format!("{}/{}", home, &path[2..]) }
    } else {
        path.to_string()
    }
}

// -----------------------------------------------------------------------------
// 2. 虚拟终端与沙盒隔离 (PTY Sandbox)
// -----------------------------------------------------------------------------
#[tauri::command]
fn spawn_pty(window: Window, state: tauri::State<'_, PtyState>, cwd: String) -> Result<(), String> {
    let pty_system = NativePtySystem::default();
    
    let pair = pty_system.openpty(PtySize {
        rows: 24, cols: 80, pixel_width: 0, pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let shell = if cfg!(windows) { "cmd.exe" } else { "bash" };
    let mut cmd = CommandBuilder::new(shell);
    
    let real_cwd = expand_home(&cwd);
    cmd.cwd(&real_cwd);
    cmd.env("OPENAI_API_BASE", "http://127.0.0.1:18000/v1");

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    *state.writer.lock().unwrap() = Some(writer);

    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            let output = String::from_utf8_lossy(&buf[..n]).to_string();
            window.emit("pty-output", output).unwrap_or(());
        }
    });

    Ok(())
}

#[tauri::command]
fn write_pty(input: String, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    if let Some(writer) = state.writer.lock().unwrap().as_mut() {
        writer.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// 3. Tauri Main
// -----------------------------------------------------------------------------
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            run_interceptor_gateway(app.handle());
            Ok(())
        })
        .manage(PtyState { writer: Arc::new(Mutex::new(None)) })
        .invoke_handler(tauri::generate_handler![spawn_pty, write_pty])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}