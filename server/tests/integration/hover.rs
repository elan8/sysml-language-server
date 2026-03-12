//! Hover integration tests.

use super::harness::{next_id, read_message, read_response, send_message, spawn_server};

#[test]
fn lsp_initialize_and_hover() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///test.sysml";
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
            "clientInfo": { "name": "lsp_integration_test", "version": "0.1.0" }
        }
    });
    send_message(&mut stdin, &init_req.to_string());
    let init_resp = read_message(&mut stdout).expect("initialize response");
    let init_json: serde_json::Value = serde_json::from_str(&init_resp).expect("parse init response");
    assert_eq!(init_json["id"], init_id);
    assert!(init_json["result"]["capabilities"].is_object());

    let initialized = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "initialized",
        "params": {}
    });
    send_message(&mut stdin, &initialized.to_string());

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

    std::thread::sleep(std::time::Duration::from_millis(50));

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
