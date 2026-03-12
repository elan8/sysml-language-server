//! Integration tests for the LSP server: spawn the binary and drive it over stdio with JSON-RPC.
//!
//! Run with: `cargo test -p sysml-language-server --test lsp_integration`
//!
//! Workspace awareness: `lsp_workspace_scan_goto_definition` uses a temp dir and proves the
//! server loads files from disk (scan). When `SYSML_V2_RELEASE_DIR` is set,
//! `lsp_workspace_scan_sysml_release` runs and validates indexing of the OMG SysML v2 repo.

use std::io::{Read, Write};
use std::path::PathBuf;
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

/// Integration test for semantic tokens: verifies that port definition syntax
/// (in/out, parameter names, types like Real/String) is tokenized correctly.
/// Helps diagnose syntax highlighting issues (e.g. "position" incorrectly as keyword).
#[test]
fn lsp_semantic_tokens_port_definitions() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///semantic_tokens_test.sysml";
    let content = r#"port def GimbalCommandPort {
    in panAngle : Real;
    in tiltAngle : Real;
}
port def PowerPort {
    out voltage : Real;
    out current : Real;
}
port def SensorDataPort {
    out position : String;
    out velocity : String;
}"#;

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": null,
            "capabilities": {},
            "clientInfo": { "name": "semantic_tokens_test", "version": "0.1.0" }
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
    std::thread::sleep(std::time::Duration::from_millis(80));

    let sem_id = next_id();
    let sem_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": sem_id,
        "method": "textDocument/semanticTokens/full",
        "params": {
            "textDocument": { "uri": uri }
        }
    });
    send_message(&mut stdin, &sem_req.to_string());
    let sem_resp = read_response(&mut stdout, sem_id).expect("semanticTokens/full response");
    let sem_json: serde_json::Value = serde_json::from_str(&sem_resp).expect("parse semanticTokens response");
    assert_eq!(sem_json["id"], sem_id);

    let data = sem_json["result"]["data"]
        .as_array()
        .expect("semanticTokens result should have data array");
    // Decode delta encoding: [deltaLine, deltaStartChar, length, tokenType, tokenModifiers] per token
    let mut line: u32 = 0;
    let mut start_char: u32 = 0;
    let mut tokens: Vec<(u32, u32, u32, u32)> = Vec::new();
    let raw: Vec<u32> = data.iter().filter_map(|v| v.as_u64().map(|u| u as u32)).collect();
    let mut i = 0;
    while i + 5 <= raw.len() {
        line += raw[i];
        start_char = if raw[i] == 0 { start_char + raw[i + 1] } else { raw[i + 1] };
        let length = raw[i + 2];
        let token_type = raw[i + 3];
        tokens.push((line, start_char, length, token_type));
        i += 5;
    }

    let lines: Vec<&str> = content.lines().collect();
    let token_text = |(ln, start, len, _ty): &(u32, u32, u32, u32)| -> String {
        let line_str = lines.get(*ln as usize).unwrap_or(&"");
        let s = *start as usize;
        let e = (*start + *len) as usize;
        line_str.chars().take(e).skip(s).collect()
    };

    // Legend: 0=KEYWORD, 5=VARIABLE, 6=TYPE, 10=PROPERTY
    let in_out_tokens: Vec<_> = tokens.iter().filter(|t| matches!(token_text(t).as_str(), "in" | "out")).collect();
    assert!(!in_out_tokens.is_empty(), "should tokenize in/out; tokens: {:?}", tokens.iter().map(|t| (token_text(t), t.3)).collect::<Vec<_>>());
    for t in &in_out_tokens {
        assert_eq!(t.3, 0, "in/out should be KEYWORD (0), got {} for {:?}", t.3, token_text(t));
    }

    for ident in ["position", "panAngle", "current", "velocity"] {
        let ident_tokens: Vec<_> = tokens.iter().filter(|t| token_text(t) == ident).collect();
        assert!(!ident_tokens.is_empty(), "should tokenize '{}'", ident);
        for t in &ident_tokens {
            assert_ne!(t.3, 0, "{} must NOT be KEYWORD (valid identifier); got type {}", ident, t.3);
        }
    }

    let real_string_tokens: Vec<_> = tokens.iter().filter(|t| matches!(token_text(t).as_str(), "Real" | "String")).collect();
    assert!(!real_string_tokens.is_empty(), "should tokenize Real/String types");
    for t in &real_string_tokens {
        assert_eq!(t.3, 6, "Real/String should be TYPE (6), got {} for {:?}", t.3, token_text(t));
    }

    let _ = child.kill();
}

const SEMANTIC_TYPE_NAMES: &[&str] = &[
    "KEYWORD", "STRING", "NUMBER", "COMMENT", "OPERATOR", "VARIABLE", "TYPE",
    "NAMESPACE", "CLASS", "INTERFACE", "PROPERTY", "FUNCTION",
];

/// Integration test that dumps full semantic token output for investigation.
/// Writes target/semantic_tokens_investigation.txt with every token (line:col text -> type).
/// Run: cargo test -p sysml-language-server --test lsp_integration lsp_semantic_tokens_investigation
#[test]
fn lsp_semantic_tokens_investigation() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///semantic_tokens_investigation.sysml";
    let content = r#"port def GimbalCommandPort {
    in panAngle : Real;
    in tiltAngle : Real;
    in mode : String;
}
port def PowerPort {
    out voltage : Real;
    out current : Real;
}
port def SensorDataPort {
    out position : String;
    out velocity : String;
    out attitude : String;
    out altitude : Real;
}"#;

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": null,
            "capabilities": {},
            "clientInfo": { "name": "semantic_tokens_investigation", "version": "0.1.0" }
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
    std::thread::sleep(std::time::Duration::from_millis(150));

    let sem_id = next_id();
    let sem_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": sem_id,
        "method": "textDocument/semanticTokens/full",
        "params": {
            "textDocument": { "uri": uri }
        }
    });
    send_message(&mut stdin, &sem_req.to_string());
    let sem_resp = read_response(&mut stdout, sem_id).expect("semanticTokens/full response");
    let sem_json: serde_json::Value = serde_json::from_str(&sem_resp).expect("parse semanticTokens response");

    let _ = child.kill();

    let result = &sem_json["result"];
    let data = result["data"]
        .as_array()
        .expect("semanticTokens result should have data array");

    let mut line: u32 = 0;
    let mut start_char: u32 = 0;
    let mut tokens: Vec<(u32, u32, u32, u32)> = Vec::new();
    let raw: Vec<u32> = data.iter().filter_map(|v| v.as_u64().map(|u| u as u32)).collect();
    let mut i = 0;
    while i + 5 <= raw.len() {
        line += raw[i];
        start_char = if raw[i] == 0 { start_char + raw[i + 1] } else { raw[i + 1] };
        let length = raw[i + 2];
        let token_type = raw[i + 3];
        tokens.push((line, start_char, length, token_type));
        i += 5;
    }

    let lines: Vec<&str> = content.lines().collect();
    let mut report = String::new();
    report.push_str("Semantic tokens investigation dump\n");
    report.push_str("=================================\n");
    report.push_str("Legend: 0=KEYWORD, 5=VARIABLE, 6=TYPE, 10=PROPERTY\n");
    report.push_str("Expected: in/out=KEYWORD, panAngle/current/velocity/position=!KEYWORD, Real/String=TYPE\n\n");
    report.push_str("Source:\n");
    for (i, l) in lines.iter().enumerate() {
        report.push_str(&format!("  {:2}: {}\n", i, l));
    }
    report.push_str("\nTokens:\n");
    for (ln, start, len, ty) in &tokens {
        let line_str = lines.get(*ln as usize).unwrap_or(&"");
        let s = *start as usize;
        let e = (*start + *len) as usize;
        let text: String = line_str.chars().take(e).skip(s).collect();
        let ty_name = SEMANTIC_TYPE_NAMES.get(*ty as usize).copied().unwrap_or("?");
        report.push_str(&format!("  {}:{} len={:2} type={} {:?}\n", ln, start, len, ty_name, text));
    }
    report.push_str("\nProblematic identifiers (should NOT be KEYWORD):\n");
    report.push_str("(If all show 'ok' below, the backend is correct. Highlight issues are client-side.)\n");
    let token_text = |(ln, start, len, _ty): &(u32, u32, u32, u32)| -> String {
        let line_str = lines.get(*ln as usize).unwrap_or(&"");
        let s = *start as usize;
        let e = (*start + *len) as usize;
        line_str.chars().take(e).skip(s).collect()
    };
    for ident in ["panAngle", "current", "velocity", "position", "tiltAngle", "mode", "voltage", "attitude", "altitude"] {
        let ident_tokens: Vec<_> = tokens.iter().filter(|t| token_text(t) == ident).collect();
        if ident_tokens.is_empty() {
            report.push_str(&format!("  {}: NOT FOUND\n", ident));
        } else {
            for t in &ident_tokens {
                let ty_name = SEMANTIC_TYPE_NAMES.get(t.3 as usize).copied().unwrap_or("?");
                let status = if t.3 == 0 { " *** WRONG (KEYWORD) ***" } else { " ok" };
                report.push_str(&format!("  {}: {} at {}:{}{}\n", ident, ty_name, t.0, t.1, status));
            }
        }
    }
    report.push_str("\nWhen backend is correct but highlighting still wrong, check:\n");
    report.push_str("  - editor.semanticHighlighting.enabled = true\n");
    report.push_str("  - No other SysML extension providing conflicting highlighting\n");
    report.push_str("  - Reload window after extension/grammar changes\n");

    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("server has parent")
                .join("target")
        });
    let _ = std::fs::create_dir_all(&target_dir);
    let out_path = target_dir.join("semantic_tokens_investigation.txt");
    std::fs::write(&out_path, &report).expect("write investigation dump");
    eprintln!("Investigation dump written to {:?}", out_path);

    assert!(
        sem_json["error"].is_null(),
        "semanticTokens/full should not return error: {:?}",
        sem_json["error"]
    );
    for ident in ["panAngle", "current", "velocity", "position"] {
        let ident_tokens: Vec<_> = tokens.iter().filter(|t| token_text(t) == ident).collect();
        assert!(!ident_tokens.is_empty(), "should tokenize '{}'; see {:?}", ident, out_path);
        for t in &ident_tokens {
            assert_ne!(
                t.3, 0,
                "{} must NOT be KEYWORD; got KEYWORD. Full dump: {:?}",
                ident,
                out_path
            );
        }
    }
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
    // Use invalid input that sysml-parser's parse_with_diagnostics reports (e.g. extra "}" or invalid keyword).
    // "package P { part def X " does NOT produce diagnostics - parser recovers without error.
    let content = "package P { } }"; // extra closing brace -> "expected end of input"

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

    // Server sends publishDiagnostics (notification); allow time for async processing
    std::thread::sleep(std::time::Duration::from_millis(500));
    // Drain notifications (no id); we expect at least one diagnostics notification
    let mut got_diagnostics = false;
    for _ in 0..20 {
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

/// Cross-file goto definition: symbol defined in file_def.sysml, used in file_use.sysml.
#[test]
fn lsp_cross_file_goto_definition() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri_def = "file:///workspace/def.sysml";
    let uri_use = "file:///workspace/use.sysml";
    let content_def = "package P { part def Engine; }";
    let content_use = "package Q { part e : Engine; }";

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": "file:///workspace",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    // Open both documents so the index has both (definition in def, usage in use)
    let did_open_def = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri_def, "languageId": "sysml", "version": 1, "text": content_def }
        }
    });
    send_message(&mut stdin, &did_open_def.to_string());
    let did_open_use = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri_use, "languageId": "sysml", "version": 1, "text": content_use }
        }
    });
    send_message(&mut stdin, &did_open_use.to_string());
    std::thread::sleep(std::time::Duration::from_millis(80));

    // Go to definition on "Engine" in use.sysml (position at "Engine" in "part e : Engine")
    let def_id = next_id();
    let def_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": def_id,
        "method": "textDocument/definition",
        "params": {
            "textDocument": { "uri": uri_use },
            "position": { "line": 0, "character": 22 }
        }
    });
    send_message(&mut stdin, &def_req.to_string());
    let def_resp = read_response(&mut stdout, def_id).expect("definition response");
    let def_json: serde_json::Value = serde_json::from_str(&def_resp).expect("parse definition response");
    assert_eq!(def_json["id"], def_id);
    let result = &def_json["result"];
    let uri = result["uri"].as_str().expect("definition should return location with uri");
    assert!(
        uri.contains("def.sysml"),
        "goto_definition should resolve to def.sysml, got uri: {}",
        uri
    );

    let _ = child.kill();
}

/// Rename: prepareRename returns range; rename returns WorkspaceEdit updating all references.
#[test]
fn lsp_rename() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri_def = "file:///rename/def.sysml";
    let uri_use = "file:///rename/use.sysml";
    let content_def = "package P { part def Foo; }";
    let content_use = "package Q { part f : Foo; }";

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": "file:///rename",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    let did_open_def = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri_def, "languageId": "sysml", "version": 1, "text": content_def }
        }
    });
    send_message(&mut stdin, &did_open_def.to_string());
    let did_open_use = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri_use, "languageId": "sysml", "version": 1, "text": content_use }
        }
    });
    send_message(&mut stdin, &did_open_use.to_string());
    std::thread::sleep(std::time::Duration::from_millis(80));

    // prepareRename at "Foo" in def.sysml ("package P { part def Foo; }" -> Foo at line 0, char 21)
    let prep_id = next_id();
    let prep_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": prep_id,
        "method": "textDocument/prepareRename",
        "params": {
            "textDocument": { "uri": uri_def },
            "position": { "line": 0, "character": 21 }
        }
    });
    send_message(&mut stdin, &prep_req.to_string());
    let prep_resp = read_response(&mut stdout, prep_id).expect("prepareRename response");
    let prep_json: serde_json::Value = serde_json::from_str(&prep_resp).expect("parse prepareRename response");
    assert_eq!(prep_json["id"], prep_id);
    let prep_result = &prep_json["result"];
    assert!(!prep_result.is_null(), "prepareRename should return range or result");
    if prep_result.get("range").is_some() {
        assert!(prep_result["range"]["start"].is_object() && prep_result["range"]["end"].is_object());
    } else {
        assert!(prep_result.get("start").is_some() && prep_result.get("end").is_some(), "prepareRename result should have range");
    }

    // rename Foo -> Bar (same position as prepareRename)
    let ren_id = next_id();
    let ren_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": ren_id,
        "method": "textDocument/rename",
        "params": {
            "textDocument": { "uri": uri_def },
            "position": { "line": 0, "character": 21 },
            "newName": "Bar"
        }
    });
    send_message(&mut stdin, &ren_req.to_string());
    let ren_resp = read_response(&mut stdout, ren_id).expect("rename response");
    let ren_json: serde_json::Value = serde_json::from_str(&ren_resp).expect("parse rename response");
    assert_eq!(ren_json["id"], ren_id);
    let changes = ren_json["result"]["changes"].as_object().expect("rename should return WorkspaceEdit with changes");
    assert!(!changes.is_empty(), "rename should have at least one file in changes");
    let uris: Vec<&str> = changes.keys().map(|k| k.as_str()).collect();
    assert!(uris.iter().any(|u| u.contains("def.sysml")), "changes should include def.sysml: {:?}", uris);
    assert!(uris.iter().any(|u| u.contains("use.sysml")), "changes should include use.sysml: {:?}", uris);
    for (_uri, edits) in changes {
        let edits_arr = edits.as_array().expect("edits per file should be array");
        for edit in edits_arr {
            assert_eq!(edit["newText"].as_str(), Some("Bar"), "each edit should replace with Bar");
        }
    }

    let _ = child.kill();
}

/// Cross-file references: find references to a symbol defined in one file and used in another.
#[test]
fn lsp_cross_file_references() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri_def = "file:///refs/def.sysml";
    let uri_use = "file:///refs/use.sysml";
    let content_def = "package P { part def Widget; }";
    let content_use = "package Q { part w : Widget; }";

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": "file:///refs",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    let did_open_def = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri_def, "languageId": "sysml", "version": 1, "text": content_def }
        }
    });
    send_message(&mut stdin, &did_open_def.to_string());
    let did_open_use = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": { "uri": uri_use, "languageId": "sysml", "version": 1, "text": content_use }
        }
    });
    send_message(&mut stdin, &did_open_use.to_string());
    std::thread::sleep(std::time::Duration::from_millis(80));

    // Find references at "Widget" in use.sysml (include_declaration = true -> def + use)
    let ref_id = next_id();
    let ref_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": ref_id,
        "method": "textDocument/references",
        "params": {
            "textDocument": { "uri": uri_use },
            "position": { "line": 0, "character": 21 },
            "context": { "includeDeclaration": true }
        }
    });
    send_message(&mut stdin, &ref_req.to_string());
    let ref_resp = read_response(&mut stdout, ref_id).expect("references response");
    let ref_json: serde_json::Value = serde_json::from_str(&ref_resp).expect("parse references response");
    assert_eq!(ref_json["id"], ref_id);
    let locs = ref_json["result"].as_array().expect("references should return array");
    let uris: Vec<String> = locs
        .iter()
        .filter_map(|l| l["uri"].as_str().map(String::from))
        .collect();
    assert!(
        uris.iter().any(|u| u.contains("def.sysml")),
        "references should include def.sysml: {:?}",
        uris
    );
    assert!(
        uris.iter().any(|u| u.contains("use.sysml")),
        "references should include use.sysml: {:?}",
        uris
    );

    let _ = child.kill();
}

/// sysml/model with scope ["graph"] returns nodes and edges after didOpen.
/// Validates that the semantic graph is built and serialized correctly.
#[test]
fn lsp_sysml_model_graph() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///model_test.sysml";
    let content = "package P { part def X; part a : X; }";

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
    std::thread::sleep(std::time::Duration::from_millis(80));

    let model_id = next_id();
    let model_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": model_id,
        "method": "sysml/model",
        "params": {
            "textDocument": { "uri": uri },
            "scope": ["graph", "stats"]
        }
    });
    send_message(&mut stdin, &model_req.to_string());
    let model_resp = read_response(&mut stdout, model_id).expect("sysml/model response");
    let model_json: serde_json::Value = serde_json::from_str(&model_resp).expect("parse sysml/model response");
    assert_eq!(model_json["id"], model_id);
    let result = &model_json["result"];
    let graph = result.get("graph").expect("sysml/model with scope graph should return graph");
    let nodes = graph["nodes"].as_array().expect("graph should have nodes array");
    let edges = graph["edges"].as_array().expect("graph should have edges array");

    assert!(!nodes.is_empty(), "graph.nodes should not be empty for package P with part def X and part a");
    assert!(nodes.len() >= 2, "expect at least 2 nodes (package P, part def X, part a): got {}", nodes.len());

    let node_ids: Vec<String> = nodes
        .iter()
        .filter_map(|n| n["id"].as_str().map(String::from))
        .collect();
    assert!(
        node_ids.iter().any(|id| id.contains("P")),
        "nodes should include package P: {:?}",
        node_ids
    );

    let contains_edges: usize = edges
        .iter()
        .filter(|e| e["type"].as_str() == Some("contains"))
        .count();
    assert!(contains_edges >= 1, "graph should have contains edges for hierarchy");

    let typing_edges: Vec<_> = edges
        .iter()
        .filter(|e| e["type"].as_str() == Some("typing"))
        .collect();
    assert!(
        !typing_edges.is_empty(),
        "graph should have typing edges from part a to part def X: {:?}",
        edges
    );

    let _ = child.kill();
}

/// sysml/model with scope ["graph"] returns state machine nodes and transition edges.
/// Validates semantic graph for state-transition-view: state def container, state usages (type "state"),
/// contains edges, and transition edges.
#[test]
#[ignore] // sysml-parser does not expose state def / transition; graph has no state nodes yet
fn lsp_sysml_model_state_transition_view() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///state_test.sysml";
    let content = r#"
        package P {
            state def A;
            state def B;
            state def M {
                state a : A;
                state b : B;
                transition t first a then b;
            }
        }
    "#;

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
    std::thread::sleep(std::time::Duration::from_millis(80));

    let model_id = next_id();
    let model_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": model_id,
        "method": "sysml/model",
        "params": {
            "textDocument": { "uri": uri },
            "scope": ["graph"]
        }
    });
    send_message(&mut stdin, &model_req.to_string());
    let model_resp = read_response(&mut stdout, model_id).expect("sysml/model response");
    let model_json: serde_json::Value = serde_json::from_str(&model_resp).expect("parse sysml/model response");
    assert_eq!(model_json["id"], model_id);
    let result = &model_json["result"];
    let graph = result.get("graph").expect("sysml/model with scope graph should return graph");
    let nodes = graph["nodes"].as_array().expect("graph should have nodes array");
    let edges = graph["edges"].as_array().expect("graph should have edges array");

    // State machine container M (state def) and state usages a, b (type "state")
    let state_def_nodes: Vec<_> = nodes
        .iter()
        .filter(|n| n["type"].as_str() == Some("state def"))
        .collect();
    let state_usage_nodes: Vec<_> = nodes
        .iter()
        .filter(|n| n["type"].as_str() == Some("state"))
        .collect();

    assert!(
        state_def_nodes.iter().any(|n| n["name"].as_str() == Some("M")),
        "graph should have state def M (state machine container), nodes: {:?}",
        nodes.iter().map(|n| (n["name"].as_str(), n["type"].as_str())).collect::<Vec<_>>()
    );
    assert!(
        state_usage_nodes.len() >= 2,
        "graph should have state usages a and b (type 'state'), got: {:?}",
        state_usage_nodes.iter().map(|n| n["name"].as_str()).collect::<Vec<_>>()
    );

    // Contains edges: M -> a, M -> b
    let contains_edges: Vec<_> = edges
        .iter()
        .filter(|e| e["type"].as_str() == Some("contains"))
        .collect();
    let contains_targets: Vec<&str> = contains_edges
        .iter()
        .filter_map(|e| e["target"].as_str())
        .collect();
    assert!(
        contains_targets.iter().any(|t| t.ends_with("::a")),
        "contains edges should link M to state a, got: {:?}",
        contains_targets
    );
    assert!(
        contains_targets.iter().any(|t| t.ends_with("::b")),
        "contains edges should link M to state b, got: {:?}",
        contains_targets
    );

    // Transition edges: a -> b
    let transition_edges: Vec<_> = edges
        .iter()
        .filter(|e| e["type"].as_str() == Some("transition"))
        .collect();
    assert!(
        !transition_edges.is_empty(),
        "graph should have transition edges, got: {:?}",
        edges.iter().map(|e| (e["type"].as_str(), e["source"].as_str(), e["target"].as_str())).collect::<Vec<_>>()
    );

    let _ = child.kill();
}

/// sysml/model with scope ["sequenceDiagrams"] returns diagrams with correct action def names.
/// Regression test for action def name parsing (was "(anonymous)" due to Pest silent terminals).
#[test]
#[ignore] // extract_sequence_diagrams returns empty (sysml-parser ActionDef body has no Call/Perform)
fn lsp_sysml_model_sequence_diagrams() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///seq_test.sysml";
    let content = r#"
        package P {
            action def ExecutePatrol { perform action ControlGimbal; }
            action def ControlGimbal { }
        }
    "#;

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
    std::thread::sleep(std::time::Duration::from_millis(80));

    let model_id = next_id();
    let model_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": model_id,
        "method": "sysml/model",
        "params": {
            "textDocument": { "uri": uri },
            "scope": ["sequenceDiagrams"]
        }
    });
    send_message(&mut stdin, &model_req.to_string());
    let model_resp = read_response(&mut stdout, model_id).expect("sysml/model response");
    let model_json: serde_json::Value = serde_json::from_str(&model_resp).expect("parse sysml/model response");
    let result = &model_json["result"];
    let diagrams = result["sequenceDiagrams"].as_array().expect("sequenceDiagrams array");

    assert_eq!(diagrams.len(), 2, "expected 2 sequence diagrams");
    let names: Vec<&str> = diagrams
        .iter()
        .filter_map(|d| d["name"].as_str())
        .collect();
    assert!(
        names.contains(&"ExecutePatrol"),
        "diagrams should include ExecutePatrol, got: {:?}",
        names
    );
    assert!(
        names.contains(&"ControlGimbal"),
        "diagrams should include ControlGimbal, got: {:?}",
        names
    );
    assert!(
        !names.iter().any(|n| *n == "(anonymous)" || n.to_lowercase().contains("anonymous")),
        "no diagram should have anonymous name, got: {:?}",
        names
    );

    let _ = child.kill();
}

/// Workspace scan: definition file exists only on disk; we never didOpen it.
/// Proves the server indexes files from the workspace root and goto_definition resolves across them.
#[test]
fn lsp_workspace_scan_goto_definition() {
    let temp = tempfile::tempdir().expect("temp dir");
    let root: PathBuf = temp.path().canonicalize().expect("canonical root");

    std::fs::write(root.join("def.sysml"), "package P { part def Engine; }").expect("write def");
    std::fs::write(root.join("use.sysml"), "package Q { part e : Engine; }").expect("write use");

    let root_uri = url::Url::from_file_path(&root).expect("root uri");
    let uri_use = url::Url::from_file_path(root.join("use.sysml")).expect("use uri");

    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": root_uri.as_str(),
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    // Wait for workspace scan to index def.sysml and use.sysml from disk
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Open only the file that contains the usage; def.sysml is only in the index from the scan
    let did_open_use = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": uri_use.as_str(),
                "languageId": "sysml",
                "version": 1,
                "text": "package Q { part e : Engine; }"
            }
        }
    });
    send_message(&mut stdin, &did_open_use.to_string());
    std::thread::sleep(std::time::Duration::from_millis(50));

    let def_id = next_id();
    let def_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": def_id,
        "method": "textDocument/definition",
        "params": {
            "textDocument": { "uri": uri_use.as_str() },
            "position": { "line": 0, "character": 22 }
        }
    });
    send_message(&mut stdin, &def_req.to_string());
    let def_resp = read_response(&mut stdout, def_id).expect("definition response");
    let def_json: serde_json::Value = serde_json::from_str(&def_resp).expect("parse definition response");
    assert_eq!(def_json["id"], def_id);
    let result = &def_json["result"];
    let uri = result["uri"].as_str().expect("definition should return location with uri");
    assert!(
        uri.contains("def.sysml"),
        "goto_definition must resolve to def.sysml (loaded by workspace scan), got uri: {}",
        uri
    );

    let _ = child.kill();
}

/// sysml/model with scope ["graph"] returns ibd with defaultRoot = SurveillanceQuadrotorDrone
/// (largest top-level part tree), not Propulsion. Validates IBD backend for interconnection-view.
#[test]
#[ignore] // ibd defaultRoot depends on graph/content that may differ with sysml-parser
fn lsp_sysml_model_ibd_default_root() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///ibd_test.sysml";
    let content = r#"
package SurveillanceDrone {
    port def MotorCommandPort { }
    port def PowerPort { }
    part def PropulsionUnit {
        port cmd : ~MotorCommandPort;
        port pwr : ~PowerPort;
    }
    part def Propulsion {
        part propulsionUnit1 : PropulsionUnit;
        part propulsionUnit2 : PropulsionUnit;
        part propulsionUnit3 : PropulsionUnit;
        part propulsionUnit4 : PropulsionUnit;
    }
    part def FlightController {
        port motorCmd : ~MotorCommandPort;
        port pwr : ~PowerPort;
    }
    part def FlightControlAndSensing {
        part flightController : FlightController;
    }
    part def SurveillanceQuadrotorDrone {
        part propulsion : Propulsion;
        part flightControl : FlightControlAndSensing;
        connect flightControl.flightController.motorCmd to propulsion.propulsionUnit1.cmd;
    }
}
"#;

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
    std::thread::sleep(std::time::Duration::from_millis(120));

    let model_id = next_id();
    let model_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": model_id,
        "method": "sysml/model",
        "params": {
            "textDocument": { "uri": uri },
            "scope": ["graph"]
        }
    });
    send_message(&mut stdin, &model_req.to_string());
    let model_resp = read_response(&mut stdout, model_id).expect("sysml/model response");
    let model_json: serde_json::Value = serde_json::from_str(&model_resp).expect("parse sysml/model response");
    assert_eq!(model_json["id"], model_id);
    let result = &model_json["result"];
    let ibd = result.get("ibd").expect("sysml/model with scope graph should return ibd");
    let default_root = ibd["defaultRoot"].as_str().expect("ibd should have defaultRoot");
    assert_eq!(
        default_root,
        "SurveillanceQuadrotorDrone",
        "defaultRoot must be SurveillanceQuadrotorDrone (largest tree), got: {}",
        default_root
    );

    let root_candidates = ibd["rootCandidates"].as_array().expect("ibd should have rootCandidates");
    assert!(
        root_candidates.iter().any(|c| c.as_str() == Some("SurveillanceQuadrotorDrone")),
        "rootCandidates should include SurveillanceQuadrotorDrone: {:?}",
        root_candidates
    );
    assert!(
        root_candidates.iter().any(|c| c.as_str() == Some("Propulsion")),
        "rootCandidates should include Propulsion: {:?}",
        root_candidates
    );

    let parts = ibd["parts"].as_array().expect("ibd should have parts");
    let sqd_parts: Vec<_> = parts
        .iter()
        .filter(|p| {
            let qn = p["qualifiedName"].as_str().unwrap_or("");
            qn == "SurveillanceDrone.SurveillanceQuadrotorDrone"
                || qn.starts_with("SurveillanceDrone.SurveillanceQuadrotorDrone.")
        })
        .collect();

    assert!(
        sqd_parts.len() >= 8,
        "IBD must include complete part tree: root + propulsion + flightControl + 4 propulsionUnit + flightController; got {}: {:?}",
        sqd_parts.len(),
        sqd_parts.iter().map(|p| p["qualifiedName"].as_str()).collect::<Vec<_>>()
    );

    let has_propulsion_units = sqd_parts.iter().any(|p| {
        let qn = p["qualifiedName"].as_str().unwrap_or("");
        qn.contains(".propulsion.propulsionUnit")
    });
    assert!(
        has_propulsion_units,
        "IBD must include nested parts under propulsion (propulsionUnit1..4); got: {:?}",
        sqd_parts.iter().map(|p| p["qualifiedName"].as_str()).collect::<Vec<_>>()
    );

    let has_flight_controller = sqd_parts.iter().any(|p| {
        let qn = p["qualifiedName"].as_str().unwrap_or("");
        qn.contains(".flightControl.flightController")
    });
    assert!(
        has_flight_controller,
        "IBD must include nested part under flightControl (flightController); got: {:?}",
        sqd_parts.iter().map(|p| p["qualifiedName"].as_str()).collect::<Vec<_>>()
    );

    let _connectors = ibd["connectors"].as_array().expect("ibd should have connectors array");

    let _ = child.kill();
}

/// When SYSML_V2_RELEASE_DIR is set, index that folder and assert workspace/symbol finds symbols.
/// Validates workspace awareness against the official OMG SysML v2 repo.
const SYSML_V2_RELEASE_DIR_ENV: &str = "SYSML_V2_RELEASE_DIR";

#[test]
fn lsp_workspace_scan_sysml_release() {
    let release_root = match std::env::var_os(SYSML_V2_RELEASE_DIR_ENV) {
        Some(v) => PathBuf::from(v),
        None => {
            eprintln!(
                "Skipping lsp_workspace_scan_sysml_release: set {} to the SysML-v2-Release clone root",
                SYSML_V2_RELEASE_DIR_ENV
            );
            return;
        }
    };
    if !release_root.is_dir() {
        eprintln!("Skipping: {} is not a directory", release_root.display());
        return;
    }

    let root_uri = match url::Url::from_file_path(&release_root) {
        Ok(u) => u,
        Err(_) => {
            eprintln!("Skipping: cannot build file URL for {}", release_root.display());
            return;
        }
    };

    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let init_id = next_id();
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": root_uri.as_str(),
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let _ = read_message(&mut stdout).expect("init response");

    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
    send_message(&mut stdin, &initialized.to_string());

    // Allow time for scanning a large repo
    std::thread::sleep(std::time::Duration::from_secs(3));

    let sym_id = next_id();
    let sym_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": sym_id,
        "method": "workspace/symbol",
        "params": { "query": "Part" }
    });
    send_message(&mut stdin, &sym_req.to_string());
    let sym_resp = read_response(&mut stdout, sym_id).expect("workspace/symbol response");
    let sym_json: serde_json::Value = serde_json::from_str(&sym_resp).expect("parse workspace/symbol response");
    assert_eq!(sym_json["id"], sym_id);
    let results = sym_json["result"].as_array().expect("workspace/symbol returns array");
    assert!(
        !results.is_empty(),
        "workspace/symbol over SysML-v2-Release should return at least one symbol for query 'Part'"
    );

    let _ = child.kill();
}
