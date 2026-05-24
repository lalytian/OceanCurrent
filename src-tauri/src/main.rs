#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use axum::{extract::State, routing::post, Json, Router};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use reqwest::Client as HttpClient;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager, Window};
use tokio::process::Command as TokioCommand;
use tokio::time::{sleep, Duration};

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
    alive: Arc<Mutex<bool>>,
}

// Ruflo MCP 桥接状态 — 前端通过此桥同步 Agent 数据
struct RufloBridgeState {
    mcp_url: String,
    client: HttpClient,
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
// 0b. Ruflo MCP 桥接 — JSON-RPC 客户端 (跟随 Ruflo 实际 transport)
// ─────────────────────────────────────────────────────────────────────────────

/// 向 Ruflo MCP Server 发起 JSON-RPC 调用
async fn mcp_jsonrpc_call(
    client: &HttpClient,
    mcp_url: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    let resp = client
        .post(format!("{}/mcp", mcp_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("MCP HTTP error: {}", e))?;

    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("MCP JSON parse error: {}", e))?;

    if let Some(err) = json.get("error") {
        return Err(format!("MCP RPC error: {:?}", err));
    }

    Ok(json["result"].clone())
}

/// 从 Ruflo MCP Server 同步 Agent 列表到本地 agentdb.rvf
async fn sync_agents_from_ruflo(
    client: &HttpClient,
    mcp_url: &str,
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
) -> Result<usize, String> {
    // 1. MCP initialize (握手)
    mcp_jsonrpc_call(
        client, mcp_url,
        "initialize",
        json!({"protocolVersion": "2024-11-05", "capabilities": {}}),
    ).await?;

    // 2. 调用 Ruflo 的 memory_search 获取活跃 agent 列表
    //    Ruflo 的 agent 信息分散在 memory namespace 中
    let result = mcp_jsonrpc_call(
        client, mcp_url,
        "tools/call",
        json!({
            "name": "memory_search",
            "arguments": {"query": "agent"}
        }),
    ).await?;

    // 3. 解析 agent 数据并写入 SQLite
    let mut count = 0;
    let content = result.to_string();

    // 尝试从 Ruflo 响应中提取 agent 信息
    // Ruflo 的 memory_search 返回格式：{"content":[{"type":"text","text":"..."}]}
    if let Some(items) = result.get("content").and_then(|c| c.as_array()) {
        for item in items {
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                // 解析文本中的 agent 引用 — 格式 "agent:<id> (<name>)"
                for cap in text.match_indices("agent:") {
                    let rest = &text[cap.0 + 6..];
                    if let Some(end) = rest.find(|c: char| c.is_whitespace() || c == ')') {
                        let agent_id = &rest[..end].trim_end_matches(')');
                        let name = agent_id.to_string();
                        let db = db.lock().unwrap();
                        db.execute(
                            "INSERT OR REPLACE INTO agents (id, name, agent_type, status, last_seen) 
                             VALUES (?1, ?2, 'agent', 'idle', datetime('now'))",
                            params![agent_id, name],
                        ).ok();
                        count += 1;
                    }
                }
            }
        }
    }

    // 4. 如果 Ruflo 没有返回 agent 数据，注入 OpenClaw 联邦已知 agent 作为兜底
    if count == 0 {
        let known_agents = vec![
            ("desktop", "Desktop", "host"),
            ("coibox", "小龙虾 (OCI)", "server"),
            ("ruflo-queen", "Ruflo Queen", "coordinator"),
        ];
        let db = db.lock().unwrap();
        for (id, name, atype) in &known_agents {
            db.execute(
                "INSERT OR REPLACE INTO agents (id, name, agent_type, status, last_seen) 
                 VALUES (?1, ?2, ?3, 'idle', datetime('now'))",
                params![id, name, atype],
            ).ok();
        }
        count = known_agents.len();
    }

    // 5. 通知前端刷新
    app.emit_all("agents-synced", json!({"count": count}))
        .unwrap_or(());

    Ok(count)
}

/// 后台启动 Ruflo MCP Server 子进程 (HTTP transport)
async fn spawn_ruflo_mcp_server(port: u16) -> Result<(), String> {
    // 尝试 npx ruflo，失败则尝试本地路径
    let mcp_url = format!("http://127.0.0.1:{}", port);

    let child = TokioCommand::new("npx")
        .args([
            "-y", "ruflo@latest",
            "mcp", "start",
            "--transport", "http",
            "--port", &port.to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn();

    match child {
        Ok(_) => {
            println!("[Ruflo Bridge] MCP Server 已启动 → {}", mcp_url);
            // 等待服务就绪
            sleep(Duration::from_secs(3)).await;
            Ok(())
        }
        Err(e) => {
            // npx 不可用时优雅降级
            println!("[Ruflo Bridge] 无法启动 Ruflo MCP Server: {}。将使用本地 agentdb.rvf 种子数据。", e);
            Err(format!("Ruflo spawn failed: {}", e))
        }
    }
}

/// 后台桥接任务：周期性同步 Ruflo → agentdb.rvf
async fn start_ruflo_bridge(
    mcp_url: String,
    client: HttpClient,
    db: Arc<Mutex<Connection>>,
    app: AppHandle,
) {
    // 首次同步
    match sync_agents_from_ruflo(&client, &mcp_url, &db, &app).await {
        Ok(n) => println!("[Ruflo Bridge] 首次同步完成，{} 个 agent", n),
        Err(e) => println!("[Ruflo Bridge] 首次同步失败 (将使用种子数据): {}", e),
    }

    // 每 30 秒轮询同步
    loop {
        sleep(Duration::from_secs(30)).await;
        match sync_agents_from_ruflo(&client, &mcp_url, &db, &app).await {
            Ok(_) => {} // 静默成功
            Err(e) => eprintln!("[Ruflo Bridge] 周期同步失败: {}", e),
        }
    }
}

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

#[tauri::command]
async fn refresh_agents(
    db: tauri::State<'_, DbState>,
    bridge: tauri::State<'_, RufloBridgeState>,
    app: AppHandle,
) -> Result<usize, String> {
    sync_agents_from_ruflo(
        &bridge.client,
        &bridge.mcp_url,
        &db.conn,
        &app,
    ).await
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

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // 保持 child 存活——用 mem::forget 防止 drop 导致进程被杀
    // 关闭 writer (kill_pty) 会关闭 PTY master → 子进程收到 SIGHUP → 自然退出
    std::mem::forget(child);
    *state.writer.lock().unwrap() = Some(writer);
    *state.alive.lock().unwrap() = true;

    let alive_flag = state.alive.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break; }
            let output = String::from_utf8_lossy(&buf[..n]).to_string();
            window.emit("pty-output", output).unwrap_or(());
        }
        // 子进程退出 → 标记 PTY 不可用，通知前端
        *alive_flag.lock().unwrap() = false;
        window.emit("pty-exit", "PTY process exited").unwrap_or(());
    });

    Ok(())
}

#[tauri::command]
fn write_pty(input: String, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    if !*state.alive.lock().unwrap() {
        return Err("PTY 进程已退出，请重新打开终端".to_string());
    }
    if let Some(writer) = state.writer.lock().unwrap().as_mut() {
        writer.write_all(input.as_bytes()).map_err(|e| {
            *state.alive.lock().unwrap() = false;
            format!("write_pty 失败: {}", e)
        })?;
    }
    Ok(())
}

#[tauri::command]
fn kill_pty(state: tauri::State<'_, PtyState>) -> Result<(), String> {
    *state.alive.lock().unwrap() = false;
    // 关闭 writer → PTY master 关闭 → 子进程收到 SIGHUP → 自然退出
    state.writer.lock().unwrap().take();
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
    let db_clone = db.clone();

    tauri::Builder::default()
        .manage(DbState { conn: db.clone() })
        .manage(PtyState { writer: Arc::new(Mutex::new(None)), alive: Arc::new(Mutex::new(false)) })
        .manage(RufloBridgeState {
            mcp_url: "http://127.0.0.1:3100".to_string(),
            client: HttpClient::new(),
        })
        .setup(move |app| {
            let app_handle = app.handle();
            let db_for_bridge = db_clone.clone();

            // 1. 启动拦截网关
            run_interceptor_gateway(app_handle.clone(), db_for_bridge.clone());

            // 2. 启动 Ruflo MCP 桥接（异步后台任务）
            let mcp_url = "http://127.0.0.1:3100".to_string();
            let client = HttpClient::new();
            let db_bridge = db_for_bridge;
            let app_bridge = app_handle.clone();

            tauri::async_runtime::spawn(async move {
                // 尝试启动 Ruflo MCP Server
                let _ = spawn_ruflo_mcp_server(3100).await;
                // 开始周期同步
                start_ruflo_bridge(mcp_url, client, db_bridge, app_bridge).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            kill_pty,
            get_agents,
            get_traces,
            update_agent_status,
            refresh_agents,
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