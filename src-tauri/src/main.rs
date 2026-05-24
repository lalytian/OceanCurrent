#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use axum::{extract::State, routing::post, Json, Router};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager, Window};

// ─────────────────────────────────────────────────────────────────────────────
// 0. 数据模型 — 对齐 Ruflo 的 agentdb.rvf Schema
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct AgentRecord {
    id: String,
    name: String,
    agent_type: String,
    status: String,       // idle | working | offline
    last_seen: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TraceRecord {
    id: i64,
    agent_id: String,
    session_id: String,
    model: String,
    prompt_preview: String,
    completion_preview: String,
    created_at: String,
}

struct DbState {
    conn: Arc<Mutex<Connection>>,
}

struct PtyState {
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
}

// ─────────────────────────────────────────────────────────────────────────────
// 0a. 初始化 agentdb.rvf
// ─────────────────────────────────────────────────────────────────────────────

fn init_ledger(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agents (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            agent_type  TEXT NOT NULL DEFAULT 'cli',
            status      TEXT NOT NULL DEFAULT 'idle',
            last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
        );
         CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            agent_id    TEXT NOT NULL REFERENCES agents(id),
            title       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
         CREATE TABLE IF NOT EXISTS traces (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id        TEXT NOT NULL,
            session_id      TEXT NOT NULL,
            model           TEXT NOT NULL DEFAULT 'unknown',
            prompt          TEXT NOT NULL,
            completion      TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
         CREATE INDEX IF NOT EXISTS idx_traces_agent    ON traces(agent_id);
         CREATE INDEX IF NOT EXISTS idx_traces_session  ON traces(session_id);
         CREATE INDEX IF NOT EXISTS idx_traces_time     ON traces(created_at);
         PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;"
    ).expect("Failed to initialize agentdb.rvf schema");

    // 种子数据：Ocean Stream 自带的三个核心 Agent
    conn.execute(
        "INSERT OR IGNORE INTO agents (id, name, agent_type, status) VALUES (?1,?2,?3,'idle')",
        params!["desktop", "Desktop", "host"],
    ).ok();
    conn.execute(
        "INSERT OR IGNORE INTO agents (id, name, agent_type, status) VALUES (?1,?2,?3,'idle')",
        params!["ruflo-queen", "Ruflo Queen", "coordinator"],
    ).ok();
    conn.execute(
        "INSERT OR IGNORE INTO agents (id, name, agent_type, status) VALUES (?1,?2,?3,'idle')",
        params!["ocean-mcp", "Ocean MCP", "server"],
    ).ok();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 洋流本地拦截网关 (Ocean Interceptor Gateway)
// ─────────────────────────────────────────────────────────────────────────────

async fn handle_chat_completions(
    State((app, db)): State<(AppHandle, Arc<Mutex<Connection>>)>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let messages = payload.get("messages").and_then(|m| m.as_array());
    let last_msg = messages
        .and_then(|m| m.last())
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("No message");

    let model = payload.get("model").and_then(|m| m.as_str()).unwrap_or("unknown");
    let agent_id = "ocean-aider"; // 后续可从请求头或 token 动态识别

    // A. 持久化 Trace 到 agentdb.rvf
    {
        let db = db.lock().unwrap();
        // 确保 agent 已注册
        db.execute(
            "INSERT OR REPLACE INTO agents (id, name, agent_type, status, last_seen) VALUES (?1,?2,'cli','working',datetime('now'))",
            params![agent_id, "Ocean Aider"],
        ).ok();
        // 创建或获取会话
        let session_id = format!("{}-{}", agent_id, chrono_now());
        db.execute(
            "INSERT OR IGNORE INTO sessions (id, agent_id, title) VALUES (?1,?2,?3)",
            params![session_id, agent_id, last_msg],
        ).ok();
        // 写入 trace
        db.execute(
            "INSERT INTO traces (agent_id, session_id, model, prompt) VALUES (?1,?2,?3,?4)",
            params![agent_id, session_id, model, last_msg],
        ).ok();
        // 更新 agent 状态
        db.execute(
            "UPDATE agents SET status='working', last_seen=datetime('now') WHERE id=?1",
            params![agent_id],
        ).ok();
    }

    // B. UI 广播
    app.emit_all("gateway-intercept", json!({
        "agent_id": agent_id,
        "prompt": last_msg,
        "model": model,
    })).unwrap_or(());

    // C. Mock 响应
    Json(json!({
        "id": "chatcmpl-ocean",
        "object": "chat.completion",
        "created": 1677652288,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": format!("(Ocean Ledger已记录)\n> {}", last_msg),
            },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 }
    }))
}

fn chrono_now() -> String {
    // 简易时间戳，避免引入 chrono 依赖
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}", d.as_secs()))
        .unwrap_or_else(|_| "0".to_string())
}

fn run_interceptor_gateway(app: AppHandle, db: Arc<Mutex<Connection>>) {
    let combined_state = (app, db);
    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/v1/chat/completions", post(handle_chat_completions))
            .with_state(combined_state);
        println!("[Ocean Gateway] 本地拦截网关已启动在 http://127.0.0.1:18000");
        axum::Server::bind(&"127.0.0.1:18000".parse().unwrap())
            .serve(router.into_make_service())
            .await
            .unwrap();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 前端查询 Commands — 驱动画布节点状态
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_agents(db: tauri::State<'_, DbState>) -> Result<Vec<AgentRecord>, String> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, name, agent_type, status, last_seen FROM agents ORDER BY last_seen DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AgentRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                agent_type: row.get(2)?,
                status: row.get(3)?,
                last_seen: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut agents = Vec::new();
    for row in rows {
        agents.push(row.map_err(|e| e.to_string())?);
    }
    Ok(agents)
}

#[tauri::command]
fn get_traces(agent_id: String, db: tauri::State<'_, DbState>) -> Result<Vec<TraceRecord>, String> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, agent_id, session_id, model, 
                    substr(prompt, 1, 80) as prompt_preview,
                    substr(coalesce(completion,''), 1, 80) as completion_preview,
                    created_at 
             FROM traces WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT 50"
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![agent_id], |row| {
            Ok(TraceRecord {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                session_id: row.get(2)?,
                model: row.get(3)?,
                prompt_preview: row.get(4)?,
                completion_preview: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut traces = Vec::new();
    for row in rows {
        traces.push(row.map_err(|e| e.to_string())?);
    }
    Ok(traces)
}

#[tauri::command]
fn update_agent_status(agent_id: String, status: String, db: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE agents SET status=?1, last_seen=datetime('now') WHERE id=?2",
        params![status, agent_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 虚拟终端与沙盒隔离 (PTY Sandbox)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tauri Main
// ─────────────────────────────────────────────────────────────────────────────

fn main() {
    let db_path = dirs_next();
    let db_file = format!("{}/.ocean-stream/agentdb.rvf", db_path);

    // 确保目录存在
    std::fs::create_dir_all(std::path::Path::new(&db_file).parent().unwrap()).ok();

    let conn = Connection::open(&db_file).expect("Failed to open agentdb.rvf");
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .expect("Failed to set SQLite pragmas");
    init_ledger(&conn);

    let db = Arc::new(Mutex::new(conn));

    tauri::Builder::default()
        .manage(DbState { conn: db.clone() })
        .manage(PtyState { writer: Arc::new(Mutex::new(None)) })
        .setup(move |app| {
            run_interceptor_gateway(app.handle(), db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            get_agents,
            get_traces,
            update_agent_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dirs_next() -> String {
    if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string())
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string())
    }
}