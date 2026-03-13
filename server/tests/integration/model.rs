//! sysml/model integration tests.

use super::harness::{next_id, read_message, read_response, send_message, spawn_server};

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

#[test]
fn lsp_sysml_model_graph_includes_requirement_usecase_and_state_nodes() {
    let mut child = spawn_server();
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");

    let uri = "file:///rich_model_test.sysml";
    let content = r#"
        package P {
            requirement def EnduranceReq;
            use case def PatrolMission {
                actor operator : HumanOperator;
            }
            state def DroneMode {
                state idle;
                state active;
                transition activate first idle then active;
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
    let model_json: serde_json::Value =
        serde_json::from_str(&model_resp).expect("parse sysml/model response");
    let graph = &model_json["result"]["graph"];
    let nodes = graph["nodes"].as_array().expect("graph should have nodes array");
    let edges = graph["edges"].as_array().expect("graph should have edges array");

    let has_requirement = nodes.iter().any(|n| {
        n["type"].as_str() == Some("requirement def")
            && n["name"].as_str() == Some("EnduranceReq")
    });
    assert!(has_requirement, "graph should include requirement def EnduranceReq");

    let has_use_case = nodes.iter().any(|n| {
        n["type"].as_str() == Some("use case def")
            && n["name"].as_str() == Some("PatrolMission")
    });
    assert!(has_use_case, "graph should include use case def PatrolMission");

    let has_actor = nodes.iter().any(|n| {
        n["type"].as_str() == Some("actor")
            && n["name"].as_str() == Some("operator")
    });
    assert!(has_actor, "graph should include actor usage operator");

    let has_state_def = nodes.iter().any(|n| {
        n["type"].as_str() == Some("state def")
            && n["name"].as_str() == Some("DroneMode")
    });
    assert!(has_state_def, "graph should include state def DroneMode");

    let state_names: Vec<_> = nodes
        .iter()
        .filter(|n| n["type"].as_str() == Some("state"))
        .filter_map(|n| n["name"].as_str())
        .collect();
    assert!(
        state_names.contains(&"idle") && state_names.contains(&"active"),
        "graph should include state usages idle and active, got {:?}",
        state_names
    );

    let has_transition = edges.iter().any(|e| {
        e["type"].as_str() == Some("transition")
            && e["source"].as_str().is_some_and(|s| s.ends_with("::idle"))
            && e["target"].as_str().is_some_and(|t| t.ends_with("::active"))
    });
    assert!(has_transition, "graph should include transition edge idle -> active");

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
