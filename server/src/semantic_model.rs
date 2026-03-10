//! Semantic graph model for SysML v2 documents.
//!
//! Builds a petgraph-based graph from parsed ASTs. Nodes represent model elements
//! (packages, parts, ports, etc.); edges represent SysML relationships
//! (typing, specializes, connection, bind, allocate, transition).

use kerml_parser::ast::{Member, PartDef, SourcePosition, SourceRange, SysMLDocument};
use petgraph::stable_graph::{NodeIndex, StableGraph};
use petgraph::visit::{EdgeRef, IntoEdgeReferences};
use petgraph::Direction;
use petgraph::Directed;
use std::collections::HashMap;
use tower_lsp::lsp_types::{Position, Range, Url};

use tower_lsp::lsp_types::SymbolKind;

use crate::language::{
    format_multiplicity, selection_contained_in, source_position_to_range, source_range_to_range,
    SymbolEntry,
};

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

/// Builds a semantic graph from a parsed SysML document.
pub fn build_graph_from_doc(doc: &SysMLDocument, uri: &Url) -> SemanticGraph {
    let mut g = SemanticGraph::new();
    for pkg in &doc.packages {
        build_from_package(pkg, uri, None, doc, &mut g);
    }
    g
}

fn build_from_package(
    pkg: &kerml_parser::ast::Package,
    uri: &Url,
    container_prefix: Option<&str>,
    doc: &SysMLDocument,
    g: &mut SemanticGraph,
) {
    let name = if pkg.name.is_empty() {
        "(top level)"
    } else {
        pkg.name.as_str()
    };
    let qualified = match container_prefix {
        Some(p) => format!("{}::{}", p, name),
        None => name.to_string(),
    };
    let node_id = NodeId::new(uri, &qualified);
    let selection_range = pkg
        .name_position
        .as_ref()
        .map(source_position_to_range)
        .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
    let range = pkg
        .range
        .as_ref()
        .map(source_range_to_range)
        .unwrap_or(selection_range);

    let node = SemanticNode {
        id: node_id.clone(),
        element_kind: "package".to_string(),
        name: name.to_string(),
        range,
        attributes: HashMap::new(),
        parent_id: container_prefix.map(|p| NodeId::new(uri, p)),
    };

    let idx = g.graph.add_node(node);
    g.node_index_by_id.insert(node_id.clone(), idx);
    g.nodes_by_uri.entry(uri.clone()).or_default().push(node_id.clone());

    let prefix = if pkg.name.is_empty() {
        container_prefix.map(String::from)
    } else {
        Some(match container_prefix {
            Some(p) => format!("{}::{}", p, name),
            None => name.to_string(),
        })
    };

    for m in &pkg.members {
        build_from_member(m, uri, prefix.as_deref(), &node_id, doc, g);
    }
}

fn member_range(
    range: Option<&SourceRange>,
    name_position: Option<&SourcePosition>,
) -> Range {
    let sel = name_position
        .map(source_position_to_range)
        .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
    let r = range
        .map(source_range_to_range)
        .unwrap_or(sel);
    selection_contained_in(sel, r)
}

fn build_from_member(
    member: &Member,
    uri: &Url,
    container_prefix: Option<&str>,
    parent_id: &NodeId,
    doc: &SysMLDocument,
    g: &mut SemanticGraph,
) {
    use kerml_parser::ast::Member as M;
    match member {
        M::PartDef(p) => {
            let range = member_range(p.range.as_ref(), p.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &p.name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = p.type_ref {
                attrs.insert("partType".to_string(), serde_json::json!(t));
            }
            if let Some(ref s) = p.specializes {
                attrs.insert("specializes".to_string(), serde_json::json!(s));
            }
            if let Some(ref m) = p.multiplicity {
                attrs.insert(
                    "multiplicity".to_string(),
                    serde_json::json!(format_multiplicity(m)),
                );
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "part def",
                p.name.clone(),
                range,
                attrs,
                parent_id,
            );
            let node_id = NodeId::new(uri, &qualified);
            relationships_from_member(member, uri, container_prefix, g);
            recurse_members(&p.members, uri, Some(&qualified), g, &node_id, doc);
        }
        M::PartUsage(p) => {
            let name = p.name.as_deref().unwrap_or("(anonymous)");
            let range = member_range(p.range.as_ref(), p.name_position.as_ref());
            let qualified = qualified_name(container_prefix, name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = p.type_ref {
                attrs.insert("partType".to_string(), serde_json::json!(t));
            }
            if let Some(ref s) = p.specializes {
                attrs.insert("specializes".to_string(), serde_json::json!(s));
            }
            if let Some(ref m) = p.multiplicity {
                attrs.insert(
                    "multiplicity".to_string(),
                    serde_json::json!(format_multiplicity(m)),
                );
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "part",
                name.to_string(),
                range,
                attrs,
                parent_id,
            );
            let node_id = NodeId::new(uri, &qualified);
            relationships_from_member(member, uri, container_prefix, g);
            recurse_members(&p.members, uri, Some(&qualified), g, &node_id, doc);
            if let Some(ref t) = p.type_ref {
                expand_typed_part_usage(doc, uri, &qualified, t, container_prefix, &node_id, g);
            }
        }
        M::AttributeDef(a) => {
            let range = member_range(a.range.as_ref(), a.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &a.name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = a.type_ref {
                attrs.insert("attributeType".to_string(), serde_json::json!(t));
            }
            if let Some(ref m) = a.multiplicity {
                attrs.insert(
                    "multiplicity".to_string(),
                    serde_json::json!(format_multiplicity(m)),
                );
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "attribute def",
                a.name.clone(),
                range,
                attrs,
                parent_id,
            );
            recurse_members(&a.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::AttributeUsage(a) => {
            let range = member_range(a.range.as_ref(), a.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &a.name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = a.type_ref {
                attrs.insert("attributeType".to_string(), serde_json::json!(t));
            }
            if let Some(ref m) = a.multiplicity {
                attrs.insert(
                    "multiplicity".to_string(),
                    serde_json::json!(format_multiplicity(m)),
                );
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "attribute",
                a.name.clone(),
                range,
                attrs,
                parent_id,
            );
        }
        M::PortDef(p) => {
            let range = member_range(p.range.as_ref(), p.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &p.name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = p.type_ref {
                attrs.insert("portType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "port def",
                p.name.clone(),
                range,
                attrs,
                parent_id,
            );
            let node_id = NodeId::new(uri, &qualified);
            relationships_from_member(member, uri, container_prefix, g);
            recurse_members(&p.members, uri, Some(&qualified), g, &node_id, doc);
        }
        M::PortUsage(p) => {
            let name = p.name.as_deref().unwrap_or("(anonymous)");
            let range = member_range(p.range.as_ref(), p.name_position.as_ref());
            let qualified = qualified_name(container_prefix, name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = p.type_ref {
                attrs.insert("portType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "port",
                name.to_string(),
                range,
                attrs,
                parent_id,
            );
            let node_id = NodeId::new(uri, &qualified);
            relationships_from_member(member, uri, container_prefix, g);
            recurse_members(&p.members, uri, Some(&qualified), g, &node_id, doc);
        }
        M::InterfaceDef(i) => {
            let range = member_range(i.range.as_ref(), i.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &i.name);
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "interface",
                i.name.clone(),
                range,
                HashMap::new(),
                parent_id,
            );
            recurse_members(&i.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::ConnectionUsage(c) => {
            let name = c.name.as_deref().unwrap_or("(connection)");
            let range = member_range(c.range.as_ref(), c.name_position.as_ref());
            let qualified = qualified_name(container_prefix, name);
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "connection",
                name.to_string(),
                range,
                HashMap::new(),
                parent_id,
            );
            relationships_from_member(member, uri, container_prefix, g);
        }
        M::ItemDef(i) => {
            let range = member_range(i.range.as_ref(), i.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &i.name);
            let mut attrs = HashMap::new();
            if let Some(ref s) = i.specializes {
                attrs.insert("specializes".to_string(), serde_json::json!(s));
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "item def",
                i.name.clone(),
                range,
                attrs,
                parent_id,
            );
            recurse_members(&i.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::ItemUsage(i) => {
            let range = member_range(i.range.as_ref(), i.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &i.name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = i.type_ref {
                attrs.insert("itemType".to_string(), serde_json::json!(t));
            }
            if let Some(ref m) = i.multiplicity {
                attrs.insert(
                    "multiplicity".to_string(),
                    serde_json::json!(format_multiplicity(m)),
                );
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "item",
                i.name.clone(),
                range,
                attrs,
                parent_id,
            );
        }
        M::RequirementDef(r) => {
            let range = member_range(r.range.as_ref(), r.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &r.name);
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "requirement def",
                r.name.clone(),
                range,
                HashMap::new(),
                parent_id,
            );
            recurse_members(&r.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::RequirementUsage(r) => {
            let range = member_range(r.range.as_ref(), r.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &r.name);
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "requirement",
                r.name.clone(),
                range,
                HashMap::new(),
                parent_id,
            );
            recurse_members(&r.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::ActionDef(a) => {
            let range = member_range(a.range.as_ref(), a.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &a.name);
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "action def",
                a.name.clone(),
                range,
                HashMap::new(),
                parent_id,
            );
        }
        M::StateDef(s) => {
            let range = member_range(s.range.as_ref(), s.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &s.name);
            // StateDef as child of StateDef = state usage in state machine; use "state" so
            // state-transition-view recognizes it (it filters for type including 'state' but not 'def').
            let parent_is_state_def = g
                .get_node(parent_id)
                .map(|p| p.element_kind == "state def")
                .unwrap_or(false);
            let kind = if parent_is_state_def {
                "state"
            } else {
                "state def"
            };
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                kind,
                s.name.clone(),
                range,
                HashMap::new(),
                parent_id,
            );
            recurse_members(&s.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::ExhibitState(s) => {
            let range = member_range(s.range.as_ref(), s.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &s.name);
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "state",
                s.name.clone(),
                range,
                HashMap::new(),
                parent_id,
            );
            recurse_members(&s.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::UseCase(u) => {
            let range = member_range(u.range.as_ref(), u.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &u.name);
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "use case def",
                u.name.clone(),
                range,
                HashMap::new(),
                parent_id,
            );
            recurse_members(&u.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::ActorDef(a) => {
            let range = member_range(a.range.as_ref(), a.name_position.as_ref());
            let qualified = qualified_name(container_prefix, &a.name);
            let mut attrs = HashMap::new();
            if let Some(ref t) = a.type_ref {
                attrs.insert("actorType".to_string(), serde_json::json!(t));
            }
            add_node_and_recurse(
                g,
                uri,
                &qualified,
                "actor def",
                a.name.clone(),
                range,
                attrs,
                parent_id,
            );
            recurse_members(&a.members, uri, Some(&qualified), g, &NodeId::new(uri, &qualified), doc);
        }
        M::Package(p) => {
            build_from_package(p, uri, container_prefix, doc, g);
        }
        M::BindStatement(_) | M::AllocateStatement(_) | M::TransitionStatement(_) => {
            relationships_from_member(member, uri, container_prefix, g);
        }
        _ => {}
    }
}

fn qualified_name(container_prefix: Option<&str>, name: &str) -> String {
    match container_prefix {
        Some(p) if !p.is_empty() => format!("{}::{}", p, name),
        _ => name.to_string(),
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
    parent_id: &NodeId,
) {
    let node_id = NodeId::new(uri, qualified);
    let node = SemanticNode {
        id: node_id.clone(),
        element_kind: kind.to_string(),
        name,
        range,
        attributes: attrs,
        parent_id: Some(parent_id.clone()),
    };
    let idx = g.graph.add_node(node);
    g.node_index_by_id.insert(node_id.clone(), idx);
    g.nodes_by_uri
        .entry(uri.clone())
        .or_default()
        .push(node_id);
}

fn recurse_members(
    members: &[Member],
    uri: &Url,
    prefix: Option<&str>,
    g: &mut SemanticGraph,
    parent_id: &NodeId,
    doc: &SysMLDocument,
) {
    for m in members {
        build_from_member(m, uri, prefix, parent_id, doc, g);
    }
}

/// Finds a PartDef in the document by qualified name (e.g. "SurveillanceDrone::FlightControlAndSensing").
fn find_part_def_in_doc<'a>(
    doc: &'a SysMLDocument,
    qualified: &str,
) -> Option<&'a PartDef> {
    for pkg in &doc.packages {
        let prefix = if pkg.name.is_empty() {
            ""
        } else {
            pkg.name.as_str()
        };
        if let Some(found) = find_part_def_in_members(&pkg.members, prefix, qualified) {
            return Some(found);
        }
    }
    None
}

fn find_part_def_in_members<'a>(
    members: &'a [Member],
    prefix: &str,
    target: &str,
) -> Option<&'a PartDef> {
    use kerml_parser::ast::Member as M;
    for m in members {
        match m {
            M::PartDef(p) => {
                let q = qualified_name(
                    if prefix.is_empty() {
                        None
                    } else {
                        Some(prefix)
                    },
                    &p.name,
                );
                if q == target {
                    return Some(p);
                }
                if let Some(found) = find_part_def_in_members(&p.members, &q, target) {
                    return Some(found);
                }
            }
            M::Package(pkg) => {
                let q = qualified_name(
                    if prefix.is_empty() {
                        None
                    } else {
                        Some(prefix)
                    },
                    &pkg.name,
                );
                if let Some(found) = find_part_def_in_members(&pkg.members, &q, target) {
                    return Some(found);
                }
            }
            _ => {}
        }
    }
    None
}

/// Expands a typed PartUsage by adding nodes for the type's nested parts and ports.
/// This ensures connection endpoints like "flightControl.flightController.motorCmd" exist.
fn expand_typed_part_usage(
    doc: &SysMLDocument,
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
    let part_def = candidates
        .iter()
        .find_map(|c| find_part_def_in_doc(doc, c));
    let Some(part_def) = part_def else { return };
    expand_part_def_members(
        doc,
        uri,
        usage_qualified,
        part_def,
        parent_id,
        g,
    );
}

fn expand_part_def_members(
    doc: &SysMLDocument,
    uri: &Url,
    container_qualified: &str,
    part_def: &PartDef,
    parent_id: &NodeId,
    g: &mut SemanticGraph,
) {
    use kerml_parser::ast::Member as M;
    for m in &part_def.members {
        match m {
            M::PartDef(p) => {
                let qualified = format!("{}::{}", container_qualified, p.name);
                add_node_if_not_exists(g, uri, &qualified, "part def", p.name.clone(), parent_id);
                if let Some(ref t) = p.type_ref {
                    let def = type_ref_candidates(
                        container_qualified.split("::").next(),
                        t,
                    )
                    .iter()
                    .find_map(|c| find_part_def_in_doc(doc, c));
                    if let Some(inner) = def {
                        expand_part_def_members(
                            doc,
                            uri,
                            &qualified,
                            inner,
                            &NodeId::new(uri, &qualified),
                            g,
                        );
                    }
                }
            }
            M::PartUsage(p) => {
                let name = p.name.as_deref().unwrap_or("(anonymous)");
                let qualified = format!("{}::{}", container_qualified, name);
                add_node_if_not_exists(g, uri, &qualified, "part", name.to_string(), parent_id);
                if let Some(ref t) = p.type_ref {
                    let def = type_ref_candidates(
                        container_qualified.split("::").next(),
                        t,
                    )
                    .iter()
                    .find_map(|c| find_part_def_in_doc(doc, c));
                    if let Some(inner) = def {
                        expand_part_def_members(
                            doc,
                            uri,
                            &qualified,
                            inner,
                            &NodeId::new(uri, &qualified),
                            g,
                        );
                    }
                }
            }
            M::PortDef(p) => {
                let qualified = format!("{}::{}", container_qualified, p.name);
                add_node_if_not_exists(g, uri, &qualified, "port def", p.name.clone(), parent_id);
            }
            M::PortUsage(p) => {
                let name = p.name.as_deref().unwrap_or("(anonymous)");
                let qualified = format!("{}::{}", container_qualified, name);
                add_node_if_not_exists(g, uri, &qualified, "port", name.to_string(), parent_id);
            }
            _ => {}
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

fn relationships_from_member(
    member: &Member,
    uri: &Url,
    container_prefix: Option<&str>,
    g: &mut SemanticGraph,
) {
    use kerml_parser::ast::Member as M;
    match member {
        M::ConnectionUsage(c) => {
            let (src, tgt) = if let Some(p) = container_prefix {
                (
                    format!("{}::{}", p, c.source),
                    format!("{}::{}", p, c.target),
                )
            } else {
                (c.source.clone(), c.target.clone())
            };
            add_edge_if_both_exist(g, uri, &src, &tgt, RelationshipKind::Connection);
        }
        M::BindStatement(b) => {
            add_edge_if_both_exist(g, uri, &b.logical, &b.physical, RelationshipKind::Bind);
        }
        M::AllocateStatement(a) => {
            add_edge_if_both_exist(g, uri, &a.source, &a.target, RelationshipKind::Allocate);
        }
        M::PartDef(p) => {
            if let Some(ref s) = p.specializes {
                let src = match container_prefix {
                    Some(pfx) => format!("{}::{}", pfx, p.name),
                    None => p.name.clone(),
                };
                add_specializes_edge_if_exists(g, uri, &src, s, container_prefix);
            }
        }
        M::PartUsage(p) => {
            if let Some(ref s) = p.specializes {
                let name = p.name.as_deref().unwrap_or("(anonymous)");
                let src = match container_prefix {
                    Some(pfx) => format!("{}::{}", pfx, name),
                    None => name.to_string(),
                };
                add_specializes_edge_if_exists(g, uri, &src, s, container_prefix);
            }
            if let Some(ref t) = p.type_ref {
                let name = p.name.as_deref().unwrap_or("(anonymous)");
                let src = match container_prefix {
                    Some(pfx) => format!("{}::{}", pfx, name),
                    None => name.to_string(),
                };
                add_typing_edge_if_exists(g, uri, &src, t, container_prefix);
            }
        }
        M::PortDef(p) => {
            if let Some(ref s) = p.specializes {
                let src = match container_prefix {
                    Some(pfx) => format!("{}::{}", pfx, p.name),
                    None => p.name.clone(),
                };
                add_specializes_edge_if_exists(g, uri, &src, s, container_prefix);
            }
        }
        M::PortUsage(p) => {
            if let Some(ref t) = p.type_ref {
                let name = p.name.as_deref().unwrap_or("(anonymous)");
                let src = match container_prefix {
                    Some(pfx) => format!("{}::{}", pfx, name),
                    None => name.to_string(),
                };
                add_typing_edge_if_exists(g, uri, &src, t, container_prefix);
            }
        }
        M::TransitionStatement(t) => {
            if let Some(ref target) = t.target {
                let source = t
                    .source
                    .as_ref()
                    .map(String::from)
                    .or_else(|| container_prefix.map(str::to_string))
                    .unwrap_or_default();
                let (src, tgt) = if let Some(pfx) = container_prefix {
                    (
                        format!("{}::{}", pfx, source),
                        format!("{}::{}", pfx, target),
                    )
                } else {
                    (source, target.clone())
                };
                add_edge_if_both_exist(g, uri, &src, &tgt, RelationshipKind::Transition);
            }
        }
        _ => {}
    }
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

/// Adds a typing edge if source exists and target can be resolved. Tries type_ref as-is,
/// then qualified with package prefixes from container_prefix.
fn add_typing_edge_if_exists(
    g: &mut SemanticGraph,
    uri: &Url,
    source_qualified: &str,
    type_ref: &str,
    container_prefix: Option<&str>,
) {
    for tgt in type_ref_candidates(container_prefix, type_ref) {
        if add_edge_if_both_exist(g, uri, source_qualified, &tgt, RelationshipKind::Typing) {
            break;
        }
    }
}

/// Adds a specializes edge if source exists and target can be resolved. Same resolution as typing:
/// specializes target may be unqualified (e.g. "SurveillanceQuadrotorDrone") while the node
/// has qualified name (e.g. "SurveillanceDrone::SurveillanceQuadrotorDrone").
fn add_specializes_edge_if_exists(
    g: &mut SemanticGraph,
    uri: &Url,
    source_qualified: &str,
    specializes_ref: &str,
    container_prefix: Option<&str>,
) {
    for tgt in type_ref_candidates(container_prefix, specializes_ref) {
        if add_edge_if_both_exist(g, uri, source_qualified, &tgt, RelationshipKind::Specializes) {
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
fn add_typing_edge_cross_document(
    g: &mut SemanticGraph,
    src_id: &NodeId,
    type_ref: &str,
    container_prefix: Option<&str>,
    kind: RelationshipKind,
) {
    let src_idx = match g.node_index_by_id.get(src_id) {
        Some(&idx) => idx,
        None => return,
    };
    for tgt_qualified in type_ref_candidates(container_prefix, type_ref) {
        let tgt_qualified = normalize_for_lookup(&tgt_qualified);
        for uri in g.nodes_by_uri.keys() {
            let tgt_id = NodeId::new(uri, &tgt_qualified);
            if let Some(&tgt_idx) = g.node_index_by_id.get(&tgt_id) {
                g.graph.add_edge(src_idx, tgt_idx, kind.clone());
                return;
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
    let src_key = normalize_for_lookup(source_qualified);
    let tgt_key = normalize_for_lookup(target_qualified);
    let src_id = NodeId::new(uri, &src_key);
    let tgt_id = NodeId::new(uri, &tgt_key);
    let (Some(&src_idx), Some(&tgt_idx)) = (
        g.node_index_by_id.get(&src_id),
        g.node_index_by_id.get(&tgt_id),
    ) else {
        return false;
    };
    g.graph.add_edge(src_idx, tgt_idx, kind);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use kerml_parser::parse_sysml;

    #[test]
    fn state_machine_graph_has_transition_edges() {
        let input = r#"
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
        let doc = parse_sysml(input).expect("parse");
        // Verify M has TransitionStatement with source/target
        let pkg = doc.packages.first().unwrap();
        let m = pkg.members.iter().find_map(|m| {
            if let Member::StateDef(s) = m {
                if s.name == "M" {
                    return Some(s);
                }
            }
            None
        }).expect("state def M");
        let trans = m.members.iter().find_map(|m| {
            if let Member::TransitionStatement(t) = m {
                Some(t)
            } else {
                None
            }
        }).expect("M should have TransitionStatement");
        assert_eq!(trans.source.as_deref(), Some("a"), "transition source");
        assert_eq!(trans.target.as_deref(), Some("b"), "transition target");

        let uri = Url::parse("file:///test.sysml").unwrap();
        let g = build_graph_from_doc(&doc, &uri);
        let edges = g.edges_for_uri_as_strings(&uri);
        let transition_edges: Vec<_> = edges
            .iter()
            .filter(|(_, _, kind, _)| *kind == RelationshipKind::Transition)
            .collect();
        assert!(!transition_edges.is_empty(), "expected transition edges: {:?}", edges);
    }

    #[test]
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
        let doc = parse_sysml(input).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let g = build_graph_from_doc(&doc, &uri);

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
}
