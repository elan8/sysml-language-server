//! Builds semantic graph from parsed AST (packages, parts, ports, connections, etc.).

use std::collections::HashMap;
use sysml_parser::ast::{
    PackageBodyElement, PackageBody, PartDefBody, PartDefBodyElement, PartUsageBody,
    PartUsageBodyElement, PortDefBody, PortDefBodyElement, InterfaceDefBody,
};
use sysml_parser::RootNamespace;
use tower_lsp::lsp_types::{Position, Range, Url};

use crate::ast_util::{identification_name, span_to_range};
use crate::semantic_model::relationships::{
    add_edge_if_both_exist, add_specializes_edge_if_exists, add_typing_edge_if_exists,
    find_part_def_in_root, type_ref_candidates,
};
use crate::semantic_model::{root_element_body, NodeId, RelationshipKind, SemanticGraph, SemanticNode};

/// Builds a semantic graph from a parsed RootNamespace (sysml-parser AST).
/// Adds the root package/namespace as a node and sets parent_id on its direct children
/// so that contains edges are emitted for the General View.
pub fn build_graph_from_doc(root: &RootNamespace, uri: &Url) -> SemanticGraph {
    let mut g = SemanticGraph::new();
    for node in &root.elements {
        let (elements, pkg_qualified, pkg_name_display, pkg_span) =
            match root_element_body(&node.value) {
                Some(t) => t,
                None => continue,
            };
        let pkg_qualified_disambiguated = qualified_name_for_node(
            &g,
            uri,
            None,
            if pkg_name_display == "(top level)" {
                ""
            } else {
                &pkg_name_display
            },
            "package",
        );
        let pkg_qualified_final = if pkg_qualified_disambiguated.is_empty() {
            pkg_qualified.clone()
        } else {
            pkg_qualified_disambiguated
        };
        add_node_and_recurse(
            &mut g,
            uri,
            &pkg_qualified_final,
            "package",
            pkg_name_display,
            span_to_range(pkg_span),
            HashMap::new(),
            None,
        );
        let package_node_id = NodeId::new(uri, &pkg_qualified_final);
        let child_prefix = if pkg_qualified == "(top level)" || pkg_qualified.is_empty() {
            None
        } else {
            Some(pkg_qualified_final.as_str())
        };
        for el in elements {
            build_from_package_body_element(
                el,
                uri,
                child_prefix,
                Some(&package_node_id),
                root,
                &mut g,
            );
        }
    }
    g
}

fn build_from_package_body_element(
    node: &sysml_parser::Node<PackageBodyElement>,
    uri: &Url,
    container_prefix: Option<&str>,
    parent_id: Option<&NodeId>,
    root: &RootNamespace,
    g: &mut SemanticGraph,
) {
    use sysml_parser::ast::PackageBodyElement as PBE;
    match &node.value {
        PBE::Package(pkg_node) => {
            let name = identification_name(&pkg_node.identification);
            let name_display = if name.is_empty() { "(top level)" } else { name.as_str() };
            let qualified = qualified_name_for_node(g, uri, container_prefix, name_display, "package");
            let node_id = NodeId::new(uri, &qualified);
            let range = span_to_range(&pkg_node.span);
            let sem_node = SemanticNode {
                id: node_id.clone(),
                element_kind: "package".to_string(),
                name: name_display.to_string(),
                range: range.clone(),
                attributes: HashMap::new(),
                parent_id: parent_id.map(Clone::clone),
            };
            let idx = g.graph.add_node(sem_node);
            g.node_index_by_id.insert(node_id.clone(), idx);
            g.nodes_by_uri.entry(uri.clone()).or_default().push(node_id.clone());
            let prefix = if name.is_empty() {
                container_prefix.map(str::to_string)
            } else {
                Some(qualified.clone())
            };
            if let PackageBody::Brace { elements } = &pkg_node.body {
                for child in elements {
                    build_from_package_body_element(child, uri, prefix.as_deref(), Some(&node_id), root, g);
                }
            }
        }
        PBE::PartDef(pd_node) => {
            let name = identification_name(&pd_node.identification);
            let qualified = qualified_name_for_node(g, uri, container_prefix, &name, "part def");
            let range = span_to_range(&pd_node.span);
            let mut attrs = HashMap::new();
            if let Some(ref s) = pd_node.specializes {
                attrs.insert("specializes".to_string(), serde_json::json!(s));
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "part def",
                name.clone(),
                range,
                attrs,
                parent_id,
            );
            let node_id = NodeId::new(uri, &qualified);
            relationships_from_part_def(pd_node, uri, container_prefix, &qualified, g);
            if let PartDefBody::Brace { elements } = &pd_node.body {
                for child in elements {
                    build_from_part_def_body_element(child, uri, Some(&qualified), &node_id, root, g);
                }
            }
            if let Some(ref s) = pd_node.specializes {
                add_specializes_edge_if_exists(g, uri, &qualified, s, container_prefix);
            }
        }
        PBE::PartUsage(pu_node) => {
            let name = &pu_node.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "part");
            let range = span_to_range(&pu_node.span);
            let mut attrs = HashMap::new();
            attrs.insert("partType".to_string(), serde_json::json!(&pu_node.type_name));
            if let Some(ref m) = pu_node.multiplicity {
                attrs.insert("multiplicity".to_string(), serde_json::json!(m));
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "part",
                name.clone(),
                range,
                attrs,
                parent_id,
            );
            let node_id = NodeId::new(uri, &qualified);
            add_typing_edge_if_exists(g, uri, &qualified, &pu_node.type_name, container_prefix);
            if let PartUsageBody::Brace { elements } = &pu_node.body {
                for child in elements {
                    build_from_part_usage_body_element(child, uri, Some(&qualified), &node_id, root, g);
                }
            }
            expand_typed_part_usage(root, uri, &qualified, &pu_node.type_name, container_prefix, &node_id, g);
        }
        PBE::PortDef(pd_node) => {
            let name = identification_name(&pd_node.identification);
            let qualified = qualified_name_for_node(g, uri, container_prefix, &name, "port def");
            let range = span_to_range(&pd_node.span);
            add_node_and_recurse(g, uri, &qualified, "port def", name.clone(), range, HashMap::new(), parent_id);
            let node_id = NodeId::new(uri, &qualified);
            if let PortDefBody::Brace { elements } = &pd_node.body {
                for child in elements {
                    build_from_port_def_body_element(child, uri, Some(&qualified), &node_id, g);
                }
            }
        }
        PBE::InterfaceDef(id_node) => {
            let name = identification_name(&id_node.identification);
            let qualified = qualified_name_for_node(g, uri, container_prefix, &name, "interface");
            let range = span_to_range(&id_node.span);
            add_node_and_recurse(g, uri, &qualified, "interface", name.clone(), range, HashMap::new(), parent_id);
            let _node_id = NodeId::new(uri, &qualified);
            if let InterfaceDefBody::Brace { elements } = &id_node.body {
                for _ in elements {
                    // EndDecl, RefDecl, ConnectStmt - we don't add graph nodes for them for now
                }
            }
        }
        PBE::AttributeDef(ad_node) => {
            let name = &ad_node.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "attribute def");
            let range = span_to_range(&ad_node.span);
            let mut attrs = HashMap::new();
            if let Some(ref t) = ad_node.typing {
                attrs.insert("attributeType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(g, uri, &qualified, "attribute def", name.clone(), range, attrs, parent_id);
        }
        PBE::ActionDef(ad_node) => {
            let name = identification_name(&ad_node.identification);
            let qualified = qualified_name_for_node(g, uri, container_prefix, &name, "action def");
            let range = span_to_range(&ad_node.span);
            add_node_and_recurse(g, uri, &qualified, "action def", name.clone(), range, HashMap::new(), parent_id);
        }
        PBE::ActionUsage(au_node) => {
            let name = &au_node.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "action");
            let range = span_to_range(&au_node.span);
            add_node_and_recurse(g, uri, &qualified, "action", name.clone(), range, HashMap::new(), parent_id);
        }
        PBE::Import(_) | PBE::AliasDef(_) => {}
        _ => {}
    }
}

fn build_from_part_def_body_element(
    node: &sysml_parser::Node<PartDefBodyElement>,
    uri: &Url,
    container_prefix: Option<&str>,
    parent_id: &NodeId,
    root: &RootNamespace,
    g: &mut SemanticGraph,
) {
    use sysml_parser::ast::PartDefBodyElement as PDBE;
    match &node.value {
        PDBE::AttributeDef(n) => {
            let name = &n.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "attribute def");
            let range = span_to_range(&n.span);
            let mut attrs = HashMap::new();
            if let Some(ref t) = n.typing {
                attrs.insert("attributeType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(g, uri, &qualified, "attribute def", name.clone(), range, attrs, Some(parent_id));
        }
        PDBE::PortUsage(n) => {
            let name = &n.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "port");
            let range = span_to_range(&n.span);
            let mut attrs = HashMap::new();
            if let Some(ref t) = n.type_name {
                attrs.insert("portType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(g, uri, &qualified, "port", name.clone(), range, attrs, Some(parent_id));
        }
        PDBE::PartUsage(n) => {
            let name = &n.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "part");
            let range = span_to_range(&n.span);
            let mut attrs = HashMap::new();
            attrs.insert("partType".to_string(), serde_json::json!(&n.type_name));
            if let Some(ref m) = n.multiplicity {
                attrs.insert("multiplicity".to_string(), serde_json::json!(m));
            }
            add_node_and_recurse(g, uri, &qualified, "part", name.clone(), range, attrs, Some(parent_id));
            let node_id = NodeId::new(uri, &qualified);
            add_typing_edge_if_exists(g, uri, &qualified, &n.type_name, container_prefix);
            if let PartUsageBody::Brace { elements } = &n.body {
                for child in elements {
                    build_from_part_usage_body_element(child, uri, Some(&qualified), &node_id, root, g);
                }
            }
            expand_typed_part_usage(root, uri, &qualified, &n.type_name, container_prefix, &node_id, g);
        }
        _ => {}
    }
}

fn build_from_part_usage_body_element(
    node: &sysml_parser::Node<PartUsageBodyElement>,
    uri: &Url,
    container_prefix: Option<&str>,
    parent_id: &NodeId,
    root: &RootNamespace,
    g: &mut SemanticGraph,
) {
    use sysml_parser::ast::PartUsageBodyElement as PUBE;
    match &node.value {
        PUBE::AttributeUsage(n) => {
            let name = &n.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "attribute");
            let range = span_to_range(&n.span);
            add_node_and_recurse(g, uri, &qualified, "attribute", name.clone(), range, HashMap::new(), Some(parent_id));
        }
        PUBE::PartUsage(n) => {
            let name = &n.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "part");
            let range = span_to_range(&n.span);
            let mut attrs = HashMap::new();
            attrs.insert("partType".to_string(), serde_json::json!(&n.type_name));
            if let Some(ref m) = n.multiplicity {
                attrs.insert("multiplicity".to_string(), serde_json::json!(m));
            }
            add_node_and_recurse(g, uri, &qualified, "part", name.clone(), range, attrs, Some(parent_id));
            let node_id = NodeId::new(uri, &qualified);
            if let PartUsageBody::Brace { elements } = &n.body {
                for child in elements {
                    build_from_part_usage_body_element(child, uri, Some(&qualified), &node_id, root, g);
                }
            }
            expand_typed_part_usage(root, uri, &qualified, &n.type_name, container_prefix, &node_id, g);
        }
        PUBE::PortUsage(n) => {
            let name = &n.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "port");
            let range = span_to_range(&n.span);
            let mut attrs = HashMap::new();
            if let Some(ref t) = n.type_name {
                attrs.insert("portType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(g, uri, &qualified, "port", name.clone(), range, attrs, Some(parent_id));
        }
        PUBE::Connect(c) => {
            let from_str = expr_node_to_qualified_string(&c.from);
            let to_str = expr_node_to_qualified_string(&c.to);
            let (src, tgt) = if let Some(p) = container_prefix {
                (format!("{}::{}", p, from_str), format!("{}::{}", p, to_str))
            } else {
                (from_str, to_str)
            };
            add_edge_if_both_exist(g, uri, &src, &tgt, RelationshipKind::Connection);
        }
        PUBE::Bind(b) => {
            let left_str = expr_node_to_qualified_string(&b.left);
            let right_str = expr_node_to_qualified_string(&b.right);
            let (src, tgt) = if let Some(p) = container_prefix {
                (format!("{}::{}", p, left_str), format!("{}::{}", p, right_str))
            } else {
                (left_str, right_str)
            };
            add_edge_if_both_exist(g, uri, &src, &tgt, RelationshipKind::Bind);
        }
        PUBE::InterfaceUsage(_) | PUBE::Perform(_) => {}
        _ => {}
    }
}

fn expr_node_to_qualified_string(n: &sysml_parser::Node<sysml_parser::Expression>) -> String {
    use sysml_parser::Expression;
    match &n.value {
        Expression::FeatureRef(s) => s.clone(),
        Expression::MemberAccess(box_base, member) => format!("{}::{}", expr_node_to_qualified_string(box_base), member),
        _ => "".to_string(),
    }
}

fn build_from_port_def_body_element(
    node: &sysml_parser::Node<PortDefBodyElement>,
    uri: &Url,
    container_prefix: Option<&str>,
    parent_id: &NodeId,
    g: &mut SemanticGraph,
) {
    use sysml_parser::ast::PortDefBodyElement as PDBE;
    match &node.value {
        PDBE::PortUsage(n) => {
            let name = &n.name;
            let qualified = qualified_name_for_node(g, uri, container_prefix, name, "port");
            let range = span_to_range(&n.span);
            let mut attrs = HashMap::new();
            if let Some(ref t) = n.type_name {
                attrs.insert("portType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(g, uri, &qualified, "port", name.clone(), range, attrs, Some(parent_id));
        }
        _ => {}
    }
}

fn relationships_from_part_def(
    _pd_node: &sysml_parser::PartDef,
    _uri: &Url,
    _container_prefix: Option<&str>,
    _qualified: &str,
    _g: &mut SemanticGraph,
) {
    // Specializes edge added in build_from_package_body_element for PartDef
}

fn qualified_name(container_prefix: Option<&str>, name: &str) -> String {
    match container_prefix {
        Some(p) if !p.is_empty() => format!("{}::{}", p, name),
        _ => name.to_string(),
    }
}

/// Returns a qualified name that is unique among siblings. When a node with the same
/// base qualified name already exists (e.g. package and part def with same name), appends
/// #kind to disambiguate.
fn qualified_name_for_node(
    g: &SemanticGraph,
    uri: &Url,
    container_prefix: Option<&str>,
    name: &str,
    kind: &str,
) -> String {
    let base = qualified_name(container_prefix, name);
    let kind_suffix = kind.replace(' ', "_");
    let node_id = NodeId::new(uri, &base);
    if g.node_index_by_id.contains_key(&node_id) {
        format!("{}#{}", base, kind_suffix)
    } else {
        base
    }
}

fn add_node_and_recurse(
    g: &mut SemanticGraph,
    uri: &Url,
    qualified: &str,
    kind: &str,
    name: String,
    range: Range,
    attrs: HashMap<String, serde_json::Value>,
    parent_id: Option<&NodeId>,
) {
    let node_id = NodeId::new(uri, qualified);
    let node = SemanticNode {
        id: node_id.clone(),
        element_kind: kind.to_string(),
        name,
        range,
        attributes: attrs,
        parent_id: parent_id.cloned(),
    };
    let idx = g.graph.add_node(node);
    g.node_index_by_id.insert(node_id.clone(), idx);
    g.nodes_by_uri
        .entry(uri.clone())
        .or_default()
        .push(node_id);
}

/// Expands a typed PartUsage by adding nodes for the type's nested parts and ports.
fn expand_typed_part_usage(
    root: &RootNamespace,
    uri: &Url,
    usage_qualified: &str,
    type_ref: &str,
    _container_prefix: Option<&str>,
    parent_id: &NodeId,
    g: &mut SemanticGraph,
) {
    let pkg_prefix = usage_qualified
        .split("::")
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let candidates = type_ref_candidates(Some(pkg_prefix), type_ref);
    if let Some((part_def_node, _q)) = candidates
        .iter()
        .find_map(|c| find_part_def_in_root(root, c))
    {
        expand_part_def_members(
            uri,
            usage_qualified,
            part_def_node,
            parent_id,
            g,
        );
    }
}

fn expand_part_def_members(
    uri: &Url,
    container_qualified: &str,
    part_def: &sysml_parser::Node<sysml_parser::PartDef>,
    parent_id: &NodeId,
    g: &mut SemanticGraph,
) {
    if let PartDefBody::Brace { elements } = &part_def.body {
        for node in elements {
            use sysml_parser::ast::PartDefBodyElement as PDBE;
            match &node.value {
                PDBE::AttributeDef(n) => {
                    let qualified = qualified_name_for_node(
                        g,
                        uri,
                        Some(container_qualified),
                        &n.name,
                        "attribute def",
                    );
                    add_node_if_not_exists(g, uri, &qualified, "attribute def", n.name.clone(), parent_id);
                }
                PDBE::PortUsage(n) => {
                    let qualified = qualified_name_for_node(
                        g,
                        uri,
                        Some(container_qualified),
                        &n.name,
                        "port",
                    );
                    add_node_if_not_exists(g, uri, &qualified, "port", n.name.clone(), parent_id);
                }
                _ => {}
            }
        }
    }
}

fn add_node_if_not_exists(
    g: &mut SemanticGraph,
    uri: &Url,
    qualified: &str,
    kind: &str,
    name: String,
    parent_id: &NodeId,
) {
    let node_id = NodeId::new(uri, qualified);
    if g.node_index_by_id.contains_key(&node_id) {
        return;
    }
    let node = SemanticNode {
        id: node_id.clone(),
        element_kind: kind.to_string(),
        name,
        range: Range::new(Position::new(0, 0), Position::new(0, 0)),
        attributes: HashMap::new(),
        parent_id: Some(parent_id.clone()),
    };
    let idx = g.graph.add_node(node);
    g.node_index_by_id.insert(node_id.clone(), idx);
    g.nodes_by_uri.entry(uri.clone()).or_default().push(node_id);
}
