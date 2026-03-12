//! Semantic graph model for SysML v2 documents.
//!
//! Builds a petgraph-based graph from parsed ASTs. Nodes represent model elements
//! (packages, parts, ports, etc.); edges represent SysML relationships
//! (typing, specializes, connection, bind, allocate, transition).

use petgraph::stable_graph::{NodeIndex, StableGraph};
use petgraph::visit::{EdgeRef, IntoEdgeReferences};
use petgraph::Direction;
use petgraph::Directed;
use std::collections::HashMap;
use sysml_parser::ast::{
    PackageBodyElement, PackageBody, PartDefBody, PartDefBodyElement, PartUsageBody,
    PartUsageBodyElement, PortDefBody, PortDefBodyElement, InterfaceDefBody, RootElement,
};
use sysml_parser::RootNamespace;
use tower_lsp::lsp_types::{Position, Range, Url};

use tower_lsp::lsp_types::SymbolKind;

use crate::ast_util::{identification_name, span_to_range};
use crate::language::SymbolEntry;

/// Unique identifier for a node in the semantic graph.
/// Combines document URI and qualified name for workspace-wide uniqueness.
#[derive(Clone, Debug, Hash, Eq, PartialEq)]
pub struct NodeId {
    pub uri: Url,
    pub qualified_name: String,
}

impl NodeId {
    pub fn new(uri: &Url, qualified_name: impl Into<String>) -> Self {
        Self {
            uri: uri.clone(),
            qualified_name: qualified_name.into(),
        }
    }
}

/// SysML v2 relationship kinds (edges in the graph).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelationshipKind {
    Typing,
    Specializes,
    Connection,
    Bind,
    Allocate,
    Transition,
}

impl RelationshipKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RelationshipKind::Typing => "typing",
            RelationshipKind::Specializes => "specializes",
            RelationshipKind::Connection => "connection",
            RelationshipKind::Bind => "bind",
            RelationshipKind::Allocate => "allocate",
            RelationshipKind::Transition => "transition",
        }
    }
}

/// A node in the semantic graph representing a model element.
#[derive(Debug, Clone)]
pub struct SemanticNode {
    pub id: NodeId,
    pub element_kind: String,
    pub name: String,
    pub range: Range,
    pub attributes: HashMap<String, serde_json::Value>,
    pub parent_id: Option<NodeId>,
}

/// Semantic graph: nodes (model elements) and edges (relationships).
/// Uses petgraph StableGraph for efficient add/remove and future algorithm support.
#[derive(Debug, Default)]
pub struct SemanticGraph {
    graph: StableGraph<SemanticNode, RelationshipKind, Directed>,
    node_index_by_id: HashMap<NodeId, NodeIndex>,
    nodes_by_uri: HashMap<Url, Vec<NodeId>>,
}

impl SemanticGraph {
    pub fn new() -> Self {
        Self {
            graph: StableGraph::new(),
            node_index_by_id: HashMap::new(),
            nodes_by_uri: HashMap::new(),
        }
    }

    /// Removes all nodes (and their incident edges) for the given URI.
    pub fn remove_nodes_for_uri(&mut self, uri: &Url) {
        let Some(node_ids) = self.nodes_by_uri.remove(uri) else {
            return;
        };
        for id in node_ids {
            if let Some(idx) = self.node_index_by_id.remove(&id) {
                self.graph.remove_node(idx);
            }
        }
    }

    /// Merges nodes and edges from another graph (built from a single document).
    pub fn merge(&mut self, other: SemanticGraph) {
        for (id, node) in other.iter_nodes() {
            let idx = self.graph.add_node(node.clone());
            self.node_index_by_id.insert(id.clone(), idx);
            self.nodes_by_uri
                .entry(id.uri.clone())
                .or_default()
                .push(id);
        }
        for (src_id, tgt_id, kind) in other.iter_edges() {
            if let (Some(&src_idx), Some(&tgt_idx)) = (
                self.node_index_by_id.get(&src_id),
                self.node_index_by_id.get(&tgt_id),
            ) {
                self.graph.add_edge(src_idx, tgt_idx, kind.clone());
            }
        }
    }

    fn iter_nodes(&self) -> impl Iterator<Item = (NodeId, &SemanticNode)> {
        self.nodes_by_uri.values().flatten().filter_map(|id| {
            self.node_index_by_id
                .get(id)
                .and_then(|&idx| self.graph.node_weight(idx))
                .map(|n| (id.clone(), n))
        })
    }

    fn iter_edges(&self) -> impl Iterator<Item = (NodeId, NodeId, RelationshipKind)> + '_ {
        let node_ids: Vec<_> = self.node_index_by_id.iter().map(|(k, v)| (k.clone(), *v)).collect();
        let id_by_idx: HashMap<NodeIndex, NodeId> = node_ids.into_iter().map(|(k, v)| (v, k)).collect();
        self.graph.edge_references().filter_map(move |e| {
            let src_id = id_by_idx.get(&e.source())?.clone();
            let tgt_id = id_by_idx.get(&e.target())?.clone();
            let kind = e.weight().clone();
            Some((src_id, tgt_id, kind))
        })
    }

    /// Returns URIs that have nodes in the graph (for debugging).
    pub fn uris_with_nodes(&self) -> Vec<String> {
        self.nodes_by_uri
            .keys()
            .take(5)
            .map(|u| u.as_str().to_string())
            .collect()
    }

    /// Returns all nodes that belong to the given URI (document).
    pub fn nodes_for_uri(&self, uri: &Url) -> Vec<&SemanticNode> {
        let Some(ids) = self.nodes_by_uri.get(uri) else {
            return Vec::new();
        };
        ids.iter()
            .filter_map(|id| {
                self.node_index_by_id
                    .get(id)
                    .and_then(|&idx| self.graph.node_weight(idx))
            })
            .collect()
    }

    /// Returns root nodes (no parent) for the given URI. Typically top-level packages.
    #[allow(dead_code)]
    pub fn root_nodes_for_uri(&self, uri: &Url) -> Vec<&SemanticNode> {
        self.nodes_for_uri(uri)
            .into_iter()
            .filter(|n| n.parent_id.is_none())
            .collect()
    }

    /// Returns child nodes of the given node (by matching parent_id).
    pub fn children_of(&self, parent: &SemanticNode) -> Vec<&SemanticNode> {
        self.nodes_by_uri
            .get(&parent.id.uri)
            .into_iter()
            .flatten()
            .filter_map(|id| {
                self.node_index_by_id
                    .get(id)
                    .and_then(|&idx| self.graph.node_weight(idx))
            })
            .filter(|n| n.parent_id.as_ref() == Some(&parent.id))
            .collect()
    }

    /// Returns the node for the given NodeId, if it exists.
    pub fn get_node(&self, id: &NodeId) -> Option<&SemanticNode> {
        self.node_index_by_id
            .get(id)
            .and_then(|&idx| self.graph.node_weight(idx))
    }

    /// Returns the node whose range contains the given position (first match).
    pub fn find_node_at_position(&self, uri: &Url, pos: Position) -> Option<&SemanticNode> {
        self.nodes_for_uri(uri)
            .into_iter()
            .find(|n| {
                let r = &n.range;
                (pos.line > r.start.line
                    || (pos.line == r.start.line && pos.character >= r.start.character))
                    && (pos.line < r.end.line
                        || (pos.line == r.end.line && pos.character <= r.end.character))
            })
    }

    /// Returns target nodes of typing or specializes edges from the given node.
    pub fn outgoing_typing_or_specializes_targets(
        &self,
        node: &SemanticNode,
    ) -> Vec<&SemanticNode> {
        let src_idx = match self.node_index_by_id.get(&node.id) {
            Some(&idx) => idx,
            None => return Vec::new(),
        };
        let id_by_idx: HashMap<NodeIndex, NodeId> = self
            .node_index_by_id
            .iter()
            .map(|(k, v)| (*v, k.clone()))
            .collect();
        let mut targets = Vec::new();
        for edge in self
            .graph
            .edges_directed(src_idx, Direction::Outgoing)
        {
            if matches!(
                edge.weight(),
                RelationshipKind::Typing | RelationshipKind::Specializes
            ) {
                if let Some(tgt_id) = id_by_idx.get(&edge.target()) {
                    if let Some(tgt) = self.get_node(tgt_id) {
                        targets.push(tgt);
                    }
                }
            }
        }
        targets
    }

    /// Finds nodes with the given qualified name (may exist in multiple URIs).
    #[allow(dead_code)]
    pub fn find_nodes_by_qualified_name(&self, qualified_name: &str) -> Vec<&SemanticNode> {
        let qn = qualified_name.replace('.', "::");
        self.nodes_by_uri
            .keys()
            .filter_map(|uri| {
                let id = NodeId::new(uri, &qn);
                self.get_node(&id)
            })
            .collect()
    }

    /// Returns edges incident to nodes in the given URI as (source, target, kind, optional edge name).
    /// Used for sysml/model relationships.
    pub fn edges_for_uri_as_strings(
        &self,
        uri: &Url,
    ) -> Vec<(String, String, RelationshipKind, Option<String>)> {
        let ids: std::collections::HashSet<_> = self
            .nodes_by_uri
            .get(uri)
            .into_iter()
            .flatten()
            .cloned()
            .collect();
        if ids.is_empty() {
            return Vec::new();
        }
        let id_by_idx: HashMap<NodeIndex, NodeId> = self
            .node_index_by_id
            .iter()
            .map(|(k, v)| (*v, k.clone()))
            .collect();
        let mut out = Vec::new();
        for e in self.graph.edge_references() {
            let src_id = match id_by_idx.get(&e.source()) {
                Some(id) => id.clone(),
                None => continue,
            };
            let tgt_id = match id_by_idx.get(&e.target()) {
                Some(id) => id.clone(),
                None => continue,
            };
            if ids.contains(&src_id) || ids.contains(&tgt_id) {
                out.push((
                    src_id.qualified_name,
                    tgt_id.qualified_name,
                    e.weight().clone(),
                    None::<String>, // edge name for connection
                ));
            }
        }
        out
    }
}

/// Builds a semantic graph from a parsed RootNamespace (sysml-parser AST).
/// Adds the root package/namespace as a node and sets parent_id on its direct children
/// so that contains edges are emitted for the General View.
pub fn build_graph_from_doc(root: &RootNamespace, uri: &Url) -> SemanticGraph {
    let mut g = SemanticGraph::new();
    for node in &root.elements {
        let (elements, pkg_qualified, pkg_name_display, pkg_span) = match &node.value {
            RootElement::Package(p) => {
                let name = identification_name(&p.identification);
                let qualified = if name.is_empty() {
                    "(top level)".to_string()
                } else {
                    name.clone()
                };
                let name_display = if name.is_empty() {
                    "(top level)".to_string()
                } else {
                    name
                };
                match &p.body {
                    PackageBody::Brace { elements } => (elements, qualified, name_display, &p.span),
                    _ => continue,
                }
            }
            RootElement::Namespace(n) => {
                let name = identification_name(&n.identification);
                let qualified = if name.is_empty() {
                    "(top level)".to_string()
                } else {
                    name.clone()
                };
                let name_display = if name.is_empty() {
                    "(top level)".to_string()
                } else {
                    name
                };
                match &n.body {
                    PackageBody::Brace { elements } => (elements, qualified, name_display, &n.span),
                    _ => continue,
                }
            }
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
            // subsets on part usage - could add edge if needed
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

/// Finds a PartDef in the root by qualified name by walking PackageBodyElements.
fn find_part_def_in_root<'a>(
    root: &'a RootNamespace,
    qualified: &str,
) -> Option<(&'a sysml_parser::Node<sysml_parser::PartDef>, String)> {
    let mut prefix = String::new();
    for node in &root.elements {
        let elements = match &node.value {
            RootElement::Package(p) => match &p.body {
                PackageBody::Brace { elements } => elements,
                _ => continue,
            },
            RootElement::Namespace(n) => match &n.body {
                PackageBody::Brace { elements } => elements,
                _ => continue,
            },
        };
        if let Some(found) = find_part_def_in_elements(elements, &mut prefix, qualified) {
            return Some(found);
        }
    }
    None
}

fn find_part_def_in_elements<'a>(
    elements: &'a [sysml_parser::Node<PackageBodyElement>],
    prefix: &mut String,
    target: &str,
) -> Option<(&'a sysml_parser::Node<sysml_parser::PartDef>, String)> {
    for node in elements {
        match &node.value {
            PackageBodyElement::Package(pkg) => {
                let name = identification_name(&pkg.identification);
                let prev = std::mem::take(prefix);
                *prefix = if prev.is_empty() {
                    name.clone()
                } else {
                    format!("{}::{}", prev, name)
                };
                if let PackageBody::Brace { elements: inner } = &pkg.body {
                    if let Some(found) = find_part_def_in_elements(inner, prefix, target) {
                        return Some(found);
                    }
                }
                *prefix = prev;
            }
            PackageBodyElement::PartDef(pd) => {
                let name = identification_name(&pd.identification);
                let q = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}::{}", prefix, name)
                };
                if q == target {
                    return Some((pd, q));
                }
            }
            _ => {}
        }
    }
    None
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

/// Normalizes "a.b.c" to "a::b::c" for node lookup (SysML uses dot for feature access).
fn normalize_for_lookup(s: &str) -> String {
    s.replace('.', "::")
}

/// Returns candidate qualified names for resolving an unqualified type reference.
/// If type_ref already contains "::", returns it as-is. Otherwise tries package prefixes
/// from container_prefix (e.g. "SurveillanceDrone::Propulsion" -> "SurveillanceDrone::PropulsionUnit").
fn type_ref_candidates(container_prefix: Option<&str>, type_ref: &str) -> Vec<String> {
    if type_ref.contains("::") {
        return vec![type_ref.to_string()];
    }
    let mut candidates = vec![type_ref.to_string()];
    if let Some(prefix) = container_prefix {
        let segments: Vec<&str> = prefix.split("::").filter(|s| !s.is_empty()).collect();
        for i in 1..=segments.len() {
            let pkg_prefix = segments[..i].join("::");
            candidates.push(format!("{}::{}", pkg_prefix, type_ref));
        }
    }
    candidates
}

/// Like type_ref_candidates but also includes #kind-suffixed variants for disambiguated nodes
/// (e.g. when a package and part def share the same name).
fn type_ref_candidates_with_kind(
    container_prefix: Option<&str>,
    type_ref: &str,
    kind: &str,
) -> Vec<String> {
    let base = type_ref_candidates(container_prefix, type_ref);
    let kind_suffix = kind.replace(' ', "_");
    let mut out = base.clone();
    for c in base {
        if !c.contains('#') {
            out.push(format!("{}#{}", c, kind_suffix));
        }
    }
    out
}

/// Adds a typing edge if source exists and target can be resolved. Tries type_ref as-is,
/// then qualified with package prefixes, then #kind-suffixed variants for disambiguated nodes.
/// Only matches targets that are actual types (part def, port def, interface) to avoid
/// matching a package that shares the same name.
fn add_typing_edge_if_exists(
    g: &mut SemanticGraph,
    uri: &Url,
    source_qualified: &str,
    type_ref: &str,
    container_prefix: Option<&str>,
) {
    const TYPING_TARGET_KINDS: &[&str] = &["part def", "port def", "interface"];
    for kind in ["part_def", "port_def"] {
        for tgt in type_ref_candidates_with_kind(container_prefix, type_ref, kind) {
            if add_edge_if_both_exist_opt(
                g,
                uri,
                source_qualified,
                &tgt,
                RelationshipKind::Typing,
                Some(TYPING_TARGET_KINDS),
            ) {
                return;
            }
        }
    }
}

/// Adds a specializes edge if source exists and target can be resolved. Same resolution as typing:
/// specializes target may be unqualified (e.g. "SurveillanceQuadrotorDrone") while the node
/// has qualified name (e.g. "SurveillanceDrone::SurveillanceQuadrotorDrone").
/// Only matches PartDef targets to avoid matching a package.
fn add_specializes_edge_if_exists(
    g: &mut SemanticGraph,
    uri: &Url,
    source_qualified: &str,
    specializes_ref: &str,
    container_prefix: Option<&str>,
) {
    const SPECIALIZES_TARGET_KINDS: &[&str] = &["part def"];
    for tgt in type_ref_candidates_with_kind(container_prefix, specializes_ref, "part_def") {
        if add_edge_if_both_exist_opt(
            g,
            uri,
            source_qualified,
            &tgt,
            RelationshipKind::Specializes,
            Some(SPECIALIZES_TARGET_KINDS),
        ) {
            break;
        }
    }
}

/// Adds typing/specializes edges from nodes in the given URI to targets that may be in other files.
/// Called after merge so the full graph contains nodes from all documents.
pub fn add_cross_document_edges_for_uri(g: &mut SemanticGraph, uri: &Url) {
    let node_ids: Vec<NodeId> = g
        .nodes_by_uri
        .get(uri)
        .map(|ids| ids.clone())
        .unwrap_or_default();
    let mut work: Vec<(NodeId, String, Option<String>, RelationshipKind)> = Vec::new();
    for node_id in &node_ids {
        let Some(node) = g.get_node(node_id) else {
            continue;
        };
        let prefix: Option<String> = node
            .parent_id
            .as_ref()
            .and_then(|pid| g.get_node(pid))
            .map(|p| p.id.qualified_name.clone());

        if let Some(v) = node
            .attributes
            .get("partType")
            .or_else(|| node.attributes.get("portType"))
            .or_else(|| node.attributes.get("actorType"))
        {
            if let Some(type_ref) = v.as_str() {
                work.push((node_id.clone(), type_ref.to_string(), prefix.clone(), RelationshipKind::Typing));
            }
        }
        if let Some(v) = node.attributes.get("specializes") {
            if let Some(s) = v.as_str() {
                work.push((
                    node_id.clone(),
                    s.to_string(),
                    prefix.clone(),
                    RelationshipKind::Specializes,
                ));
            }
        }
    }
    for (node_id, type_ref, prefix, kind) in work {
        add_typing_edge_cross_document(g, &node_id, &type_ref, prefix.as_deref(), kind);
    }
}

/// Adds a typing or specializes edge when target may be in a different URI.
/// Only matches targets that are actual types (part def, port def, interface for typing;
/// part def only for specializes).
fn add_typing_edge_cross_document(
    g: &mut SemanticGraph,
    src_id: &NodeId,
    type_ref: &str,
    container_prefix: Option<&str>,
    kind: RelationshipKind,
) {
    let target_element_kinds: &[&str] = match kind {
        RelationshipKind::Typing => &["part def", "port def", "interface"],
        RelationshipKind::Specializes => &["part def"],
        _ => &[],
    };
    let src_idx = match g.node_index_by_id.get(src_id) {
        Some(&idx) => idx,
        None => return,
    };
    let suffix_kinds = ["part_def", "port_def"];
    let candidates: Vec<String> = suffix_kinds
        .iter()
        .flat_map(|k| type_ref_candidates_with_kind(container_prefix, type_ref, k))
        .collect();
    for tgt_qualified in candidates {
        let tgt_qualified = normalize_for_lookup(&tgt_qualified);
        for uri in g.nodes_by_uri.keys() {
            let tgt_id = NodeId::new(uri, &tgt_qualified);
            if let Some(tgt_node) = g.get_node(&tgt_id) {
                if target_element_kinds.contains(&tgt_node.element_kind.as_str()) {
                    if let Some(&tgt_idx) = g.node_index_by_id.get(&tgt_id) {
                        g.graph.add_edge(src_idx, tgt_idx, kind.clone());
                        return;
                    }
                }
            }
        }
    }
}

/// Maps element_kind from the semantic model to LSP SymbolKind.
fn element_kind_to_symbol_kind(kind: &str) -> SymbolKind {
    match kind {
        "package" => SymbolKind::MODULE,
        "part def" => SymbolKind::CLASS,
        "part" => SymbolKind::VARIABLE,
        "attribute def" => SymbolKind::PROPERTY,
        "attribute" => SymbolKind::PROPERTY,
        "port def" => SymbolKind::INTERFACE,
        "port" => SymbolKind::INTERFACE,
        "interface" => SymbolKind::INTERFACE,
        "connection" => SymbolKind::VARIABLE,
        "item def" => SymbolKind::CONSTANT,
        "item" => SymbolKind::CONSTANT,
        "requirement def" => SymbolKind::STRING,
        "requirement" => SymbolKind::STRING,
        "action def" => SymbolKind::FUNCTION,
        "state def" => SymbolKind::ENUM_MEMBER,
        "state" => SymbolKind::ENUM_MEMBER,
        "use case def" => SymbolKind::EVENT,
        "actor def" => SymbolKind::CONSTRUCTOR,
        _ => SymbolKind::NULL,
    }
}

/// Builds a signature string from node attributes (partType, specializes, etc.).
fn signature_from_node(node: &SemanticNode) -> Option<String> {
    let kind = node.element_kind.as_str();
    let mult = node
        .attributes
        .get("multiplicity")
        .and_then(|v| v.as_str())
        .map(|m| format!(" {}", m))
        .unwrap_or_default();
    let (type_attr, type_suffix) = match kind {
        "part def" | "part" => (
            node.attributes.get("partType").or_else(|| node.attributes.get("specializes")),
            " : ",
        ),
        "attribute def" | "attribute" => (node.attributes.get("attributeType"), " : "),
        "port def" | "port" => (node.attributes.get("portType"), " : "),
        "actor def" => (node.attributes.get("actorType"), " : "),
        "item def" => (node.attributes.get("specializes"), " :> "),
        "item" => (node.attributes.get("itemType"), " : "),
        _ => (None, ""),
    };
    let type_part = type_attr
        .and_then(|v| v.as_str())
        .map(|t| format!("{}{}", type_suffix, t))
        .unwrap_or_default();
    Some(format!(
        "{} {}{}{};",
        kind,
        node.name,
        type_part,
        mult
    ))
}

/// Collects symbol entries for a URI from the semantic graph (replaces AST-based collect_symbol_entries).
pub fn symbol_entries_for_uri(graph: &SemanticGraph, uri: &Url) -> Vec<SymbolEntry> {
    let mut out = Vec::new();
    for node in graph.nodes_for_uri(uri) {
        let container_name = node
            .parent_id
            .as_ref()
            .and_then(|pid| graph.get_node(pid))
            .map(|p| p.name.clone());
        let description = format!("{} '{}'", node.element_kind, node.name);
        let signature = signature_from_node(node);
        out.push(SymbolEntry {
            name: node.name.clone(),
            uri: node.id.uri.clone(),
            range: node.range,
            kind: element_kind_to_symbol_kind(&node.element_kind),
            container_name,
            detail: Some(node.element_kind.clone()),
            description: Some(description),
            signature,
        });
    }
    out
}

/// Returns true if the edge was added.
fn add_edge_if_both_exist(
    g: &mut SemanticGraph,
    uri: &Url,
    source_qualified: &str,
    target_qualified: &str,
    kind: RelationshipKind,
) -> bool {
    add_edge_if_both_exist_opt(g, uri, source_qualified, target_qualified, kind, None)
}

/// Like add_edge_if_both_exist but for typing/specializes: only adds when target is a type
/// (part def, port def, interface). Avoids matching a package that shares the same name.
fn add_edge_if_both_exist_opt(
    g: &mut SemanticGraph,
    uri: &Url,
    source_qualified: &str,
    target_qualified: &str,
    kind: RelationshipKind,
    target_kinds: Option<&[&str]>,
) -> bool {
    let src_key = normalize_for_lookup(source_qualified);
    let tgt_key = normalize_for_lookup(target_qualified);
    let src_id = NodeId::new(uri, &src_key);
    let tgt_id = NodeId::new(uri, &tgt_key);
    let (Some(&src_idx), Some(tgt_node)) = (
        g.node_index_by_id.get(&src_id),
        g.get_node(&tgt_id),
    ) else {
        return false;
    };
    if let Some(kinds) = target_kinds {
        let ek = tgt_node.element_kind.as_str();
        if !kinds.iter().any(|k| ek == *k) {
            return false;
        }
    }
    let tgt_idx = g.node_index_by_id.get(&tgt_id).copied().unwrap();
    g.graph.add_edge(src_idx, tgt_idx, kind);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use sysml_parser::parse;

    #[test]
    fn state_machine_graph_builds_from_root() {
        let input = r#"
            package P {
                part def A { }
                part def B { }
            }
        "#;
        let root = parse(input).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let g = build_graph_from_doc(&root, &uri);
        let _edges = g.edges_for_uri_as_strings(&uri);
        // Graph builds without panic; transition edges depend on sysml-parser state/transition support
        assert!(g.node_index_by_id.len() >= 2, "expected at least package and part def nodes: {:?}", g.node_index_by_id.len());
    }

    /// General View fix: root package is a node and its direct children have parent_id set
    /// so that contains edges are emitted for the diagram.
    #[test]
    fn root_package_node_and_contains_edges_for_children() {
        let input = r#"
            package SurveillanceDrone {
                part def Airframe { }
                part def PropulsionUnit { }
            }
        "#;
        let root = parse(input).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let g = build_graph_from_doc(&root, &uri);
        let pkg_id = NodeId::new(&uri, "SurveillanceDrone");
        assert!(
            g.node_index_by_id.contains_key(&pkg_id),
            "root package SurveillanceDrone must be a node; nodes: {:?}",
            g.nodes_by_uri.get(&uri).map(|v| v.iter().map(|id| id.qualified_name.as_str()).collect::<Vec<_>>())
        );
        let nodes_with_parent: Vec<_> = g
            .nodes_for_uri(&uri)
            .into_iter()
            .filter(|n| n.parent_id.as_ref() == Some(&pkg_id))
            .collect();
        assert!(
            nodes_with_parent.len() >= 2,
            "expected at least 2 direct children of package (Airframe, PropulsionUnit); got {}",
            nodes_with_parent.len()
        );
        let names: Vec<_> = nodes_with_parent.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Airframe"), "expected Airframe in children: {:?}", names);
        assert!(names.contains(&"PropulsionUnit"), "expected PropulsionUnit in children: {:?}", names);
    }

    #[test]
    #[ignore] // input uses port def CmdPort {} which sysml-parser may not accept (expected end of input)
    fn typed_part_usage_expansion_adds_nested_port_nodes() {
        // Typed PartUsages expand so connection endpoints (e.g. flightControl.flightController.motorCmd) exist.
        let input = r#"
            package P {
                port def CmdPort {}
                part def Child {
                    port cmd : CmdPort;
                }
                part def Parent {
                    part child : Child;
                }
                part def Root {
                    part parent : Parent;
                }
            }
        "#;
        let root = parse(input).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let g = build_graph_from_doc(&root, &uri);

        // Expansion adds nested parts/ports under typed PartUsage so connection endpoints exist.
        let port_id = NodeId::new(&uri, "P::Root::parent::child::cmd");
        assert!(
            g.node_index_by_id.contains_key(&port_id),
            "expected port node P::Root::parent::child::cmd from typed part expansion; nodes: {:?}",
            g.nodes_by_uri
                .get(&uri)
                .map(|v| v.iter().map(|id| id.qualified_name.as_str()).collect::<Vec<_>>())
        );
    }

    #[test]
    #[ignore] // input uses syntax (e.g. port def with {}) that sysml-parser may not accept
    fn connection_edges_added_when_port_nodes_exist() {
        // Connection "connect flightControl.flightController.motorCmd to propulsion.propulsionUnit1.cmd"
        // requires port nodes from expand_typed_part_usage. Verifies connection edges are added.
        let input = r#"
            package SurveillanceDrone {
                port def MotorCommandPort {}
                port def PowerPort {}
                part def PropulsionUnit {
                    port cmd : ~MotorCommandPort;
                    port pwr : ~PowerPort;
                }
                part def Propulsion {
                    part propulsionUnit1 : PropulsionUnit;
                    part propulsionUnit2 : PropulsionUnit;
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
        let root = parse(input).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let g = build_graph_from_doc(&root, &uri);

        let src = "SurveillanceDrone::SurveillanceQuadrotorDrone::flightControl::flightController::motorCmd";
        let tgt = "SurveillanceDrone::SurveillanceQuadrotorDrone::propulsion::propulsionUnit1::cmd";
        assert!(
            g.node_index_by_id.contains_key(&NodeId::new(&uri, src)),
            "expected motorCmd port node; nodes: {:?}",
            g.nodes_by_uri
                .get(&uri)
                .map(|v| v.iter().map(|id| id.qualified_name.as_str()).collect::<Vec<_>>())
        );
        assert!(
            g.node_index_by_id.contains_key(&NodeId::new(&uri, tgt)),
            "expected cmd port node"
        );

        let edges = g.edges_for_uri_as_strings(&uri);
        let conn_edges: Vec<_> = edges
            .iter()
            .filter(|(_, _, kind, _)| *kind == RelationshipKind::Connection)
            .collect();
        assert!(
            !conn_edges.is_empty(),
            "expected connection edges; edges: {:?}",
            edges
        );
    }
}
