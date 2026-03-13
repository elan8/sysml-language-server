//! Builds IBD (Internal Block Diagram) / Interconnection View data from the semantic graph.
//! Used by sysml/model to return a ready-to-render structure for the client.

use serde::Serialize;
use tower_lsp::lsp_types::Url;

use crate::semantic_model::{NodeId, RelationshipKind, SemanticGraph, SemanticNode};

fn is_part_like(kind: &str) -> bool {
    let k = kind.to_lowercase();
    k.contains("part def") || k == "part" || (k.contains("part") && !k.contains("def"))
}

fn is_port_like(kind: &str) -> bool {
    let k = kind.to_lowercase();
    k.contains("port def") || k == "port"
}

/// Count of part nodes in the subtree (direct + recursive). Uses typing to follow part def structure.
fn part_tree_size(graph: &SemanticGraph, node: &SemanticNode, _uri: &Url) -> usize {
    let children = graph.children_of(node);
    let part_children: Vec<_> = children
        .iter()
        .filter(|c| is_part_like(&c.element_kind))
        .collect();
    part_children
        .iter()
        .map(|c| {
            let typed = graph.outgoing_typing_or_specializes_targets(c);
            let def = typed.into_iter().next();
            if let Some(def_node) = def {
                if is_part_like(&def_node.element_kind) {
                    return 1 + part_tree_size(graph, def_node, _uri);
                }
            }
            1 + part_tree_size(graph, c, _uri)
        })
        .sum()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IbdPartDto {
    pub id: String,
    pub name: String,
    pub qualified_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(rename = "type")]
    pub element_type: String,
    pub attributes: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IbdPortDto {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IbdConnectorDto {
    pub source: String,
    pub target: String,
    pub source_id: String,
    pub target_id: String,
    #[serde(rename = "type")]
    pub rel_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IbdDataDto {
    pub parts: Vec<IbdPartDto>,
    pub ports: Vec<IbdPortDto>,
    pub connectors: Vec<IbdConnectorDto>,
    pub root_candidates: Vec<String>,
    pub default_root: Option<String>,
}

/// Qualified name with "::" converted to "." for client path matching (e.g. "pkg::A::b" -> "A.b" when root is "A").
pub fn qualified_name_to_dot(qn: &str) -> String {
    qn.replace("::", ".")
}

/// Builds IBD data for the given URI from the semantic graph.
pub fn build_ibd_for_uri(graph: &SemanticGraph, uri: &Url) -> IbdDataDto {
    let nodes = graph.nodes_for_uri(uri);

    let mut parts = Vec::new();
    let mut ports = Vec::new();
    let mut part_qualified_by_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for node in &nodes {
        let qn = node.id.qualified_name.clone();
        let parent_qualified = node
            .parent_id
            .as_ref()
            .map(|p| p.qualified_name.clone());

        if is_part_like(&node.element_kind) {
            let container_id = node.parent_id.as_ref().and_then(|pid| {
                graph.get_node(pid).and_then(|p| {
                    if is_part_like(&p.element_kind) {
                        Some(qualified_name_to_dot(&pid.qualified_name))
                    } else {
                        None
                    }
                })
            });
            part_qualified_by_id.insert(qn.clone(), qn.clone());
            parts.push(IbdPartDto {
                id: qn.clone(),
                name: node.name.clone(),
                qualified_name: qualified_name_to_dot(&qn),
                container_id: container_id.map(|s| qualified_name_to_dot(&s)),
                element_type: node.element_kind.clone(),
                attributes: node.attributes.clone(),
            });
        } else if is_port_like(&node.element_kind) {
            let parent_id = parent_qualified
                .as_ref()
                .map(|pq| qualified_name_to_dot(pq))
                .unwrap_or_else(|| node.name.clone());
            let direction = node.attributes.get("direction").and_then(|v| v.as_str()).map(String::from);
            ports.push(IbdPortDto {
                id: node.id.qualified_name.clone(),
                name: node.name.clone(),
                parent_id,
                direction,
            });
        }
    }

    // Expand typed part defs into the part-usage hierarchy so the client can render the full nested tree.
    // Example: if `root.propulsion` is typed by `Propulsion`, then `Propulsion`'s internal parts become
    // `root.propulsion.<child>` (with containerId = `root.propulsion`).
    let mut existing_part_qn_dot: std::collections::HashSet<String> =
        parts.iter().map(|p| p.qualified_name.clone()).collect();
    let mut existing_ports: std::collections::HashSet<(String, String)> = ports
        .iter()
        .map(|p| (p.parent_id.clone(), p.name.clone()))
        .collect();

    let add_ports_from_def = |def_node: &SemanticNode,
                              parent_dot: &str,
                              ports_out: &mut Vec<IbdPortDto>,
                              existing_ports: &mut std::collections::HashSet<(String, String)>| {
        for child in graph.children_of(def_node) {
            if !is_port_like(&child.element_kind) {
                continue;
            }
            let key = (parent_dot.to_string(), child.name.clone());
            if existing_ports.contains(&key) {
                continue;
            }
            existing_ports.insert(key);
            let direction = child
                .attributes
                .get("direction")
                .and_then(|v| v.as_str())
                .map(String::from);
            ports_out.push(IbdPortDto {
                id: format!("{parent_dot}.{}", child.name),
                name: child.name.clone(),
                parent_id: parent_dot.to_string(),
                direction,
            });
        }
    };

    fn first_typed_part_shape<'a>(graph: &'a SemanticGraph, node: &'a SemanticNode) -> Option<&'a SemanticNode> {
        graph
            .outgoing_typing_or_specializes_targets(node)
            .into_iter()
            .find(|t| {
                if !is_part_like(&t.element_kind) {
                    return false;
                }
                // Prefer targets that actually contribute structure (ports/parts).
                let children = graph.children_of(t);
                children.iter().any(|c| is_part_like(&c.element_kind) || is_port_like(&c.element_kind))
            })
    }

    fn expand_def_subtree(
        graph: &SemanticGraph,
        def_node: &SemanticNode,
        parent_dot: &str,
        parts_out: &mut Vec<IbdPartDto>,
        ports_out: &mut Vec<IbdPortDto>,
        existing_part_qn_dot: &mut std::collections::HashSet<String>,
        existing_ports: &mut std::collections::HashSet<(String, String)>,
    ) {
        // First, inherit ports from the definition onto the parent usage node.
        // (The closure below is duplicated as a small helper for borrow reasons.)
        for port_child in graph.children_of(def_node) {
            if !is_port_like(&port_child.element_kind) {
                continue;
            }
            let key = (parent_dot.to_string(), port_child.name.clone());
            if existing_ports.contains(&key) {
                continue;
            }
            existing_ports.insert(key);
            let direction = port_child
                .attributes
                .get("direction")
                .and_then(|v| v.as_str())
                .map(String::from);
            ports_out.push(IbdPortDto {
                id: format!("{parent_dot}.{}", port_child.name),
                name: port_child.name.clone(),
                parent_id: parent_dot.to_string(),
                direction,
            });
        }

        for part_child in graph.children_of(def_node) {
            if !is_part_like(&part_child.element_kind) {
                continue;
            }
            let expanded_dot = format!("{parent_dot}.{}", part_child.name);
            if existing_part_qn_dot.contains(&expanded_dot) {
                continue;
            }
            existing_part_qn_dot.insert(expanded_dot.clone());
            parts_out.push(IbdPartDto {
                id: expanded_dot.clone(),
                name: part_child.name.clone(),
                qualified_name: expanded_dot.clone(),
                container_id: Some(parent_dot.to_string()),
                element_type: part_child.element_kind.clone(),
                attributes: part_child.attributes.clone(),
            });

            // Recursively expand if this part usage is typed by a part definition.
            if let Some(grand_def) = first_typed_part_shape(graph, part_child) {
                expand_def_subtree(
                    graph,
                    grand_def,
                    &expanded_dot,
                    parts_out,
                    ports_out,
                    existing_part_qn_dot,
                    existing_ports,
                );
            }
        }
    }

    // Iterate over a snapshot of current parts to avoid infinite growth during iteration.
    let parts_snapshot = parts.clone();
    for p in &parts_snapshot {
        // Only expand for parts that correspond to real semantic nodes (base nodes), not synthetic expanded ones.
        // Base parts use ids with "::" qualified names.
        if !p.id.contains("::") {
            continue;
        }
        let node_id = NodeId::new(uri, &p.id);
        let Some(node) = graph.get_node(&node_id) else { continue };
        let Some(def_node) = first_typed_part_shape(graph, node) else { continue };

        // Expand the definition subtree under this usage part's dot-qualified name.
        let parent_dot = p.qualified_name.as_str();
        // inherit ports (in case the def has ports) onto the usage itself
        add_ports_from_def(def_node, parent_dot, &mut ports, &mut existing_ports);
        expand_def_subtree(
            graph,
            def_node,
            parent_dot,
            &mut parts,
            &mut ports,
            &mut existing_part_qn_dot,
            &mut existing_ports,
        );
    }

    let edges = graph.edges_for_uri_as_strings(uri);
    let mut connectors = Vec::new();
    for (src, tgt, kind, _name) in &edges {
        if *kind == RelationshipKind::Connection {
            // Use full qualified path in dot form for frontend findPartPos resolution
            let source_id = src.replace("::", ".");
            let target_id = tgt.replace("::", ".");
            connectors.push(IbdConnectorDto {
                source: src.clone(),
                target: tgt.clone(),
                source_id,
                target_id,
                rel_type: "connection".to_string(),
            });
        }
    }

    let top_level_parts: Vec<_> = parts
        .iter()
        .filter(|p| {
            p.container_id.is_none()
                || p
                    .container_id
                    .as_ref()
                    .and_then(|container_id| {
                        graph.get_node(&NodeId::new(
                            uri,
                            &container_id.replace('.', "::"),
                        ))
                    })
                    .map(|n| !is_part_like(&n.element_kind))
                    .unwrap_or(true)
        })
        .collect();

    let mut roots_with_size: Vec<(&IbdPartDto, usize)> = top_level_parts
        .iter()
        .filter_map(|p| {
            graph.get_node(&NodeId::new(uri, &p.id)).and_then(|node| {
                if graph.children_of(node).iter().any(|c| is_part_like(&c.element_kind)) {
                    Some((*p, part_tree_size(graph, node, uri)))
                } else {
                    None
                }
            })
        })
        .collect();

    roots_with_size.sort_by(|a, b| b.1.cmp(&a.1));

    let root_candidates: Vec<String> = roots_with_size.iter().map(|(p, _)| p.name.clone()).collect();
    let default_root = root_candidates.first().cloned();

    IbdDataDto {
        parts,
        ports,
        connectors,
        root_candidates,
        default_root,
    }
}
