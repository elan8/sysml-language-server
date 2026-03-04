//! Integration tests for the LSP server: spawn the binary and drive it over stdio with JSON-RPC.
//!
//! Run with: `cargo test -p sysml-language-server --test lsp_integration`

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};

static NEXT_ID: AtomicI64 = AtomicI64::new(1);

fn server_binary_path() -> std::path::PathBuf {
    let current_exe = std::env::current_exe().expect("current_exe");
    // Test binary is in target/debug/deps/; server binary is in target/debug/
    let dir = current_exe
        .parent()
        .and_then(|p| p.parent())
        .expect("test binary has parent dir (target/debug)");
    let name = std::env::consts::EXE_SUFFIX;
    let server_name = if name.is_empty() {
        "sysml-language-server".to_string()
    } else {
        format!("sysml-language-server{}", name)
    };
    dir.join(server_name)
}

fn spawn_server() -> Child {
    let bin = server_binary_path();
    assert!(bin.exists(), "server binary not found at {:?}", bin);
    Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn server")
}

/// LSP message framing: "Content-Length: N\r\n\r\n" + body (UTF-8).
fn send_message(stdin: &mut std::process::ChildStdin, body: &str) {
    let bytes = body.as_bytes();
    let header = format!("Content-Length: {}\r\n\r\n", bytes.len());
    stdin.write_all(header.as_bytes()).expect("write header");
    stdin.write_all(bytes).expect("write body");
    stdin.flush().expect("flush");
}

fn read_message(stdout: &mut std::process::ChildStdout) -> Option<String> {
    let mut header = Vec::new();
    let mut buf = [0u8; 1];
    let mut content_length: Option<usize> = None;
    loop {
        if stdout.read(&mut buf).ok()? == 0 {
            return None;
        }
        header.push(buf[0]);
        if header.ends_with(b"\r\n\r\n") {
            let s = String::from_utf8_lossy(&header);
            for line in s.lines() {
                if line.to_lowercase().starts_with("content-length:") {
                    let num = line
                        .split(':')
                        .nth(1)
                        .and_then(|s| s.trim().parse::<usize>().ok())?;
                    content_length = Some(num);
                    break;
                }
            }
            break;
        }
        if header.len() > 1024 {
            return None;
        }
    }
    let len = content_length?;
    let mut body = vec![0u8; len];
    stdout.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

/// Read messages until we get a JSON-RPC response with the given id (request response).
fn read_response(stdout: &mut std::process::ChildStdout, expect_id: i64) -> Option<String> {
    loop {
        let msg = read_message(stdout)?;
        let json: serde_json::Value = serde_json::from_str(&msg).ok()?;
        if json.get("id").and_then(|v| v.as_i64()) == Some(expect_id) {
            return Some(msg);
        }
        // Skip notifications (no id) or other responses
    }
}

fn next_id() -> i64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

#[test]
fn lsp_initialize_and_hover() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///test.sysml";
    let content = "package P { part def X; }";

    // initialize
    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": null,
            "capabilities": {},
            "clientInfo": { "name": "lsp_integration_test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let init_resp = read_message(&mut stdout).expect("initialize response");
    let init_json: serde_json::Value = serde_json::from_str(&init_resp).expect("parse init response");
    assert_eq!(init_json["id"], init_id);
    assert!(init_json["result"]["capabilities"].is_object());

    // initialized (notify)
    let initialized = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "initialized",
        "params": {}
    });
    send_message(&mut stdin, &initialized.to_string());

    // textDocument/didOpen
    let did_open = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": uri,
                "languageId": "sysml",
                "version": 1,
                "text": content
            }
        }
    });
    send_message(&mut stdin, &did_open.to_string());

    // Give server a moment to process didOpen and publish diagnostics
    std::thread::sleep(std::time::Duration::from_millis(50));

    // textDocument/hover at "part" (line 0: "package P { part def X; }" -> "part" starts at char 13)
    let hover_id = next_id();
    let hover_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": hover_id,
        "method": "textDocument/hover",
        "params": {
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 14 }
        }
    });
    send_message(&mut stdin, &hover_req.to_string());
    let hover_resp = read_response(&mut stdout, hover_id).expect("hover response");
    let hover_json: serde_json::Value = serde_json::from_str(&hover_resp).expect("parse hover response");
    assert_eq!(hover_json["id"], hover_id);
    let contents = hover_json["result"]["contents"]["value"].as_str()
        .or_else(|| hover_json["result"]["contents"].as_str());
    assert!(contents.is_some(), "hover should return contents: {}", hover_resp);
    let contents = contents.unwrap();
    assert!(contents.to_lowercase().contains("part"), "hover should mention 'part': {}", contents);

    let _ = child.kill();
}

#[test]
fn lsp_completion() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///test2.sysml";
    let content = "package P { part def X; }";

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": null,
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    let did_open = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri, "languageId": "sysml", "version": 1, "text": content }
        }
    });
    send_message(&mut stdin, &did_open.to_string());
    std::thread::sleep(std::time::Duration::from_millis(50));

    let compl_id = next_id();
    let compl_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": compl_id,
        "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 2 }
        }
    });
    send_message(&mut stdin, &compl_req.to_string());
    let compl_resp = read_response(&mut stdout, compl_id).expect("completion response");
    let compl_json: serde_json::Value = serde_json::from_str(&compl_resp).expect("parse completion response");
    assert_eq!(compl_json["id"], compl_id);
    let items = compl_json["result"].as_array().or_else(|| compl_json["result"]["items"].as_array());
    assert!(items.is_some(), "completion should return array: {}", compl_resp);
    let items = items.unwrap();
    assert!(!items.is_empty(), "completion should have at least one item");
    let labels: Vec<String> = items
        .iter()
        .filter_map(|i| i["label"].as_str().map(String::from))
        .collect();
    assert!(labels.iter().any(|l| l == "part" || l == "package"), "completion should include keywords: {:?}", labels);

    let _ = child.kill();
}

#[test]
fn lsp_goto_definition() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///def_test.sysml";
    let content = "package P { part def A; part a : A; }";

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": null,
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    let did_open = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri, "languageId": "sysml", "version": 1, "text": content }
        }
    });
    send_message(&mut stdin, &did_open.to_string());
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Go to definition on "A" (usage "part a : A" -> def A). Line 0, character after "part a : "
    let def_id = next_id();
    let def_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": def_id,
        "method": "textDocument/definition",
        "params": {
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 22 }
        }
    });
    send_message(&mut stdin, &def_req.to_string());
    let def_resp = read_response(&mut stdout, def_id).expect("definition response");
    let def_json: serde_json::Value = serde_json::from_str(&def_resp).expect("parse definition response");
    assert_eq!(def_json["id"], def_id);
    let result = &def_json["result"];
    assert!(result.is_object() || result["uri"].is_string(), "definition should return location: {}", def_resp);
    if let Some(u) = result["uri"].as_str() {
        assert!(u.contains("def_test.sysml"));
    }

    let _ = child.kill();
}

#[test]
fn lsp_diagnostics_on_invalid_sysml() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///bad.sysml";
    let content = "package P { part def X "; // incomplete

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": null,
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    let did_open = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri, "languageId": "sysml", "version": 1, "text": content }
        }
    });
    send_message(&mut stdin, &did_open.to_string());

    // Server sends publishDiagnostics (notification); we might get one or more messages
    std::thread::sleep(std::time::Duration::from_millis(100));
    // Drain notifications (no id); we expect at least one diagnostics notification
    let mut got_diagnostics = false;
    for _ in 0..5 {
        if let Some(msg) = read_message(&mut stdout) {
            let json: serde_json::Value = serde_json::from_str(&msg).ok().unwrap_or_default();
            if json["method"].as_str() == Some("textDocument/publishDiagnostics") {
                let diags = json["params"]["diagnostics"].as_array();
                if diags.map(|a| !a.is_empty()).unwrap_or(false) {
                    got_diagnostics = true;
                    break;
                }
            }
        } else {
            break;
        }
    }
    assert!(got_diagnostics, "invalid SysML should produce at least one diagnostic");

    let _ = child.kill();
}
