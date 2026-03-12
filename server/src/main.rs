//! SysML v2 language server (LSP over stdio).
#![allow(deprecated)] // LSP deprecated field in SymbolInformation; use tags in future

mod ast_util;
mod ibd;
mod language;
mod model;
mod semantic_model;
mod semantic_tokens;

use sysml_parser::RootNamespace;
use std::sync::Arc;
use std::time::Instant;
use tower_lsp::lsp_types::Range;

/// Applies an incremental content change (range + new text) to the document.
/// LSP uses line/character; we treat character as byte offset within the line (UTF-8).
fn apply_incremental_change(text: &str, range: &Range, new_text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let start_line = range.start.line as usize;
    let start_char = range.start.character as usize;
    let end_line = range.end.line as usize;
    let end_char = range.end.character as usize;
    if start_line >= lines.len() || end_line >= lines.len() {
        return None;
    }
    let mut start_byte = 0usize;
    for (i, line) in lines.iter().enumerate() {
        if i < start_line {
            start_byte += line.len() + 1;
        } else {
            start_byte += start_char.min(line.len());
            break;
        }
    }
    let mut end_byte = 0usize;
    for (i, line) in lines.iter().enumerate() {
        if i < end_line {
            end_byte += line.len() + 1;
        } else {
            end_byte += end_char.min(line.len());
            break;
        }
    }
    if start_byte > text.len() || end_byte > text.len() || start_byte > end_byte {
        return None;
    }
    let mut out = String::with_capacity(text.len() - (end_byte - start_byte) + new_text.len());
    out.push_str(&text[..start_byte]);
    out.push_str(new_text);
    out.push_str(&text[end_byte..]);
    Some(out)
}
use tokio::sync::RwLock;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use semantic_tokens::{ast_semantic_ranges, legend, semantic_tokens_full, semantic_tokens_range};
use tower_lsp::{Client, LanguageServer, LspService, Server};
use walkdir::WalkDir;
use serde::Serialize;

use language::{
    collect_definition_ranges, collect_document_symbols,
    completion_prefix, collect_folding_ranges,
    find_reference_ranges, format_document, is_reserved_keyword, keyword_doc, keyword_hover_markdown,
    line_prefix_at_position, suggest_wrap_in_package, sysml_keywords, word_at_position, SymbolEntry,
};

/// Per-file index entry: content and optional parsed AST (invalidated when content changes).
#[derive(Debug)]
struct IndexEntry {
    content: String,
    parsed: Option<RootNamespace>,
}

#[derive(Debug, Default)]
struct ServerState {
    /// Workspace root URIs from initialize (workspace_folders or root_uri).
    workspace_roots: Vec<Url>,
    /// Library path roots from config (e.g. SysML-v2-Release). Indexed like workspace_roots.
    library_paths: Vec<Url>,
    /// One source of truth: URI -> (content, parsed). Open docs and workspace-scanned files.
    index: std::collections::HashMap<Url, IndexEntry>,
    /// Workspace-wide symbol table: flat list of definable symbols, updated when index changes.
    symbol_table: Vec<SymbolEntry>,
    /// Semantic graph (nodes = elements, edges = relationships). Source for sysml/model.
    semantic_graph: semantic_model::SemanticGraph,
}

// -------------------------
// Custom requests (extension)
// -------------------------

/// Parse sysml/model params from JSON-RPC value. Accepts both object format
/// ({"textDocument":{"uri":"..."},"scope":[...]}) and positional array
/// (for clients that send params as array).
fn parse_sysml_model_params(v: &serde_json::Value) -> Result<(Url, Vec<String>)> {
    let (uri_str, scope_value) = if let Some(arr) = v.as_array() {
        // Positional: [uri_or_text_doc, scope?]
        let first = arr.get(0).ok_or_else(|| {
            tower_lsp::jsonrpc::Error::invalid_params("sysml/model params array must have at least one element")
        })?;
        let uri_str = if let Some(s) = first.as_str() {
            Some(s.to_string())
        } else if let Some(obj) = first.as_object() {
            obj.get("uri").and_then(|u| u.as_str()).map(String::from)
                .or_else(|| obj.get("textDocument").and_then(|td| td.get("uri")).and_then(|u| u.as_str()).map(String::from))
        } else {
            None
        };
        let scope_value = arr.get(1);
        (uri_str, scope_value)
    } else if let Some(obj) = v.as_object() {
        let uri_str = obj.get("uri").and_then(|u| u.as_str()).map(String::from)
            .or_else(|| obj.get("textDocument").and_then(|td| td.get("uri")).and_then(|u| u.as_str()).map(String::from));
        let scope_value = obj.get("scope");
        (uri_str, scope_value)
    } else {
        return Err(tower_lsp::jsonrpc::Error::invalid_params(
            "sysml/model params must be an object or array",
        ));
    };

    let uri = uri_str
        .as_ref()
        .ok_or_else(|| tower_lsp::jsonrpc::Error::invalid_params("sysml/model requires 'uri' or 'textDocument.uri'"))?;
    let uri = Url::parse(uri).map_err(|_| {
        tower_lsp::jsonrpc::Error::invalid_params("sysml/model: invalid URI")
    })?;
    let uri = normalize_file_uri(&uri);

    let scope: Vec<String> = scope_value
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    Ok((uri, scope))
}

#[derive(Debug, Serialize)]
struct PositionDto {
    line: u32,
    character: u32,
}

#[derive(Debug, Serialize)]
struct RangeDto {
    start: PositionDto,
    end: PositionDto,
}

#[derive(Debug, Serialize)]
struct RelationshipDto {
    #[serde(rename = "type")]
    rel_type: String,
    source: String,
    target: String,
    name: Option<String>,
}

/// Graph node for frontend (qualified name as id).
#[derive(Debug, Serialize)]
struct GraphNodeDto {
    id: String,
    #[serde(rename = "type")]
    element_type: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "parentId")]
    parent_id: Option<String>,
    range: RangeDto,
    attributes: std::collections::HashMap<String, serde_json::Value>,
}

/// Graph edge (source/target are node ids).
#[derive(Debug, Serialize)]
struct GraphEdgeDto {
    source: String,
    target: String,
    #[serde(rename = "type")]
    rel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Serialize)]
struct SysmlGraphDto {
    nodes: Vec<GraphNodeDto>,
    edges: Vec<GraphEdgeDto>,
}

#[derive(Debug, Serialize)]
struct SysmlElementDto {
    #[serde(rename = "type")]
    element_type: String,
    name: String,
    range: RangeDto,
    children: Vec<SysmlElementDto>,
    attributes: std::collections::HashMap<String, serde_json::Value>,
    relationships: Vec<RelationshipDto>,
    errors: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct SysmlModelStatsDto {
    #[serde(rename = "totalElements")]
    total_elements: u32,
    #[serde(rename = "resolvedElements")]
    resolved_elements: u32,
    #[serde(rename = "unresolvedElements")]
    unresolved_elements: u32,
    #[serde(rename = "parseTimeMs")]
    parse_time_ms: u32,
    #[serde(rename = "modelBuildTimeMs")]
    model_build_time_ms: u32,
    #[serde(rename = "parseCached")]
    parse_cached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SysmlModelResultDto {
    version: u32,
    graph: Option<SysmlGraphDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activity_diagrams: Option<Vec<model::ActivityDiagramDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequence_diagrams: Option<Vec<model::SequenceDiagramDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ibd: Option<ibd::IbdDataDto>,
    stats: Option<SysmlModelStatsDto>,
}

#[derive(Debug, Serialize)]
struct SysmlServerStatsDto {
    uptime: u64,
    memory: SysmlServerMemoryDto,
    caches: SysmlServerCachesDto,
}

#[derive(Debug, Serialize)]
struct SysmlServerMemoryDto {
    /// Resident set size in MB (best-effort). Currently 0 when not available.
    rss: u64,
}

#[derive(Debug, Serialize)]
struct SysmlServerCachesDto {
    documents: usize,
    #[serde(rename = "symbolTables")]
    symbol_tables: usize,
    #[serde(rename = "semanticTokens")]
    semantic_tokens: usize,
}

#[derive(Debug, Serialize)]
struct SysmlClearCacheResultDto {
    documents: usize,
    #[serde(rename = "symbolTables")]
    symbol_tables: usize,
    #[serde(rename = "semanticTokens")]
    semantic_tokens: usize,
}

fn range_to_dto(r: Range) -> RangeDto {
    RangeDto {
        start: PositionDto {
            line: r.start.line,
            character: r.start.character,
        },
        end: PositionDto {
            line: r.end.line,
            character: r.end.character,
        },
    }
}

#[allow(dead_code)]
fn semantic_node_to_dto(
    node: &semantic_model::SemanticNode,
    graph: &semantic_model::SemanticGraph,
) -> SysmlElementDto {
    let mut relationships = Vec::new();
    if let Some(v) = node
        .attributes
        .get("partType")
        .or_else(|| node.attributes.get("portType"))
        .or_else(|| node.attributes.get("actorType"))
    {
        if let Some(t) = v.as_str() {
            relationships.push(RelationshipDto {
                rel_type: "typing".to_string(),
                source: node.name.clone(),
                target: t.to_string(),
                name: None,
            });
        }
    }
    if let Some(v) = node.attributes.get("specializes") {
        if let Some(s) = v.as_str() {
            relationships.push(RelationshipDto {
                rel_type: "specializes".to_string(),
                source: node.name.clone(),
                target: s.to_string(),
                name: None,
            });
        }
    }
    let children = graph
        .children_of(node)
        .into_iter()
        .map(|c| semantic_node_to_dto(c, graph))
        .collect();
    SysmlElementDto {
        element_type: node.element_kind.clone(),
        name: node.name.clone(),
        range: range_to_dto(node.range),
        children,
        attributes: node.attributes.clone(),
        relationships,
        errors: None,
    }
}

#[allow(dead_code)] // Kept as fallback; sysml/model now uses semantic graph
fn model_element_to_dto(el: &language::ModelElement) -> SysmlElementDto {
    let mut relationships = Vec::new();
    if let Some(v) = el
        .attributes
        .get("partType")
        .or_else(|| el.attributes.get("portType"))
        .or_else(|| el.attributes.get("actorType"))
    {
        if let Some(t) = v.as_str() {
            relationships.push(RelationshipDto {
                rel_type: "typing".to_string(),
                source: el.name.clone(),
                target: t.to_string(),
                name: None,
            });
        }
    }
    if let Some(v) = el.attributes.get("specializes") {
        if let Some(s) = v.as_str() {
            relationships.push(RelationshipDto {
                rel_type: "specializes".to_string(),
                source: el.name.clone(),
                target: s.to_string(),
                name: None,
            });
        }
    }
    SysmlElementDto {
        element_type: el.element_type.clone(),
        name: el.name.clone(),
        range: range_to_dto(el.range),
        children: el.children.iter().map(model_element_to_dto).collect(),
        attributes: el.attributes.clone(),
        relationships,
        errors: None,
    }
}

#[allow(dead_code)]
fn count_elements(elements: &[SysmlElementDto]) -> u32 {
    fn rec(e: &SysmlElementDto) -> u32 {
        1 + e.children.iter().map(rec).sum::<u32>()
    }
    elements.iter().map(rec).sum()
}

/// Removes all symbol table entries for `uri`, then appends `new_entries` if provided.
fn update_symbol_table_for_uri(
    state: &mut ServerState,
    uri: &Url,
    new_entries: Option<&[SymbolEntry]>,
) {
    state.symbol_table.retain(|e| e.uri != *uri);
    if let Some(entries) = new_entries {
        state.symbol_table.extend(entries.iter().cloned());
    }
}

/// Removes all symbol table entries for `uri`.
fn remove_symbol_table_entries_for_uri(state: &mut ServerState, uri: &Url) {
    state.symbol_table.retain(|e| e.uri != *uri);
}

/// Normalize file URIs so that file:///C:/... and file:///c%3A/... (from client) match in the index.
/// Uses lowercase drive letter and decoded path so both server (from_file_path) and client URIs align.
fn normalize_file_uri(uri: &Url) -> Url {
    if uri.scheme() != "file" {
        return uri.clone();
    }
    let path = uri.path();
    if path.len() >= 3 {
        let mut chars: Vec<char> = path.chars().collect();
        if chars[0] == '/' && chars[1].is_ascii_alphabetic() && chars.get(2) == Some(&':') {
            chars[1] = chars[1].to_lowercase().next().unwrap_or(chars[1]);
            let new_path: String = chars.into_iter().collect();
            if let Ok(u) = Url::parse(&format!("file://{}", new_path)) {
                return u;
            }
        }
    }
    uri.clone()
}

/// When parse fails, get diagnostic messages from parse_with_diagnostics for logging.
fn parse_failure_diagnostics(content: &str, max_errors: usize) -> Vec<String> {
    let result = sysml_parser::parse_with_diagnostics(content);
    result
        .errors
        .iter()
        .take(max_errors)
        .map(|e| {
            let loc = e
                .to_lsp_range()
                .map(|(sl, sc, _, _)| format!("{}:{}", sl, sc))
                .unwrap_or_else(|| format!("{:?}:{:?}", e.line, e.column));
            format!("{} {}", loc, e.message)
        })
        .collect()
}

/// Updates the semantic graph for a URI: removes existing nodes, then merges new graph from parsed doc.
fn update_semantic_graph_for_uri(
    state: &mut ServerState,
    uri: &Url,
    doc: Option<&RootNamespace>,
) {
    state.semantic_graph.remove_nodes_for_uri(uri);
    if let Some(d) = doc {
        let new_graph = semantic_model::build_graph_from_doc(d, uri);
        state.semantic_graph.merge(new_graph);
        semantic_model::add_cross_document_edges_for_uri(&mut state.semantic_graph, uri);
    }
}

/// Returns true if `uri` is under any of the library path roots (path prefix check).
fn uri_under_any_library(uri: &Url, library_paths: &[Url]) -> bool {
    let uri_path = match uri.to_file_path() {
        Ok(p) => p,
        Err(_) => return false,
    };
    for lib in library_paths {
        if let Ok(lib_path) = lib.to_file_path() {
            if uri_path.starts_with(&lib_path) {
                return true;
            }
        }
    }
    false
}

/// Parse library paths from LSP config (initialization_options or didChangeConfiguration settings).
fn parse_library_paths_from_value(value: Option<&serde_json::Value>) -> Vec<Url> {
    value
        .and_then(|opts| opts.get("libraryPaths"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str())
                .filter_map(|path_str| {
                    let path = std::path::PathBuf::from(path_str);
                    Url::from_file_path(path).ok()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Builds Markdown for symbol hover: title (kind + name), code block with signature or description, container, optional location.
fn symbol_hover_markdown(entry: &SymbolEntry, show_location: bool) -> String {
    let kind = entry
        .detail
        .as_deref()
        .unwrap_or("symbol");
    let name = &entry.name;
    let mut md = format!("**{}** `{}`\n\n", kind, name);
    let code_block = entry
        .signature
        .as_deref()
        .or(entry.description.as_deref())
        .unwrap_or(name.as_str());
    md.push_str("```sysml\n");
    md.push_str(code_block);
    md.push_str("\n```\n\n");
    if let Some(ref pkg) = entry.container_name {
        if pkg != "(top level)" {
            md.push_str(&format!("*Package:* `{}`\n\n", pkg));
        }
    }
    if show_location {
        md.push_str(&format!("*Defined in:* {}", entry.uri.path()));
    }
    md
}

#[derive(Debug)]
struct Backend {
    client: Client,
    state: Arc<RwLock<ServerState>>,
    start_time: Instant,
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        let roots: Vec<Url> = params
            .workspace_folders
            .as_ref()
            .filter(|f| !f.is_empty())
            .map(|folders| folders.iter().map(|f| f.uri.clone()).collect())
            .or_else(|| params.root_uri.as_ref().map(|u| vec![u.clone()]))
            .unwrap_or_default();
        let library_paths: Vec<Url> = parse_library_paths_from_value(params.initialization_options.as_ref());
        {
            let mut state = self.state.write().await;
            state.workspace_roots = roots;
            state.library_paths = library_paths;
        }
        Ok(InitializeResult {
            server_info: Some(ServerInfo {
                name: "sysml-language-server".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::INCREMENTAL,
                )),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                completion_provider: Some(CompletionOptions::default()),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                rename_provider: Some(OneOf::Right(RenameOptions {
                    prepare_provider: Some(true),
                    work_done_progress_options: WorkDoneProgressOptions::default(),
                })),
                document_symbol_provider: Some(OneOf::Left(true)),
                folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
                workspace_symbol_provider: Some(OneOf::Left(true)),
                code_action_provider: Some(CodeActionProviderCapability::Simple(true)),
                document_formatting_provider: Some(OneOf::Left(true)),
                semantic_tokens_provider: Some(
                    SemanticTokensServerCapabilities::SemanticTokensOptions(SemanticTokensOptions {
                        work_done_progress_options: WorkDoneProgressOptions::default(),
                        legend: legend(),
                        range: Some(true),
                        full: Some(SemanticTokensFullOptions::Bool(true)),
                    }),
                ),
                ..ServerCapabilities::default()
            },
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "sysml-language-server initialized")
            .await;
        let state = Arc::clone(&self.state);
        let (workspace_roots, library_paths) = {
            let st = state.read().await;
            (
                st.workspace_roots.clone(),
                st.library_paths.clone(),
            )
        };
        let scan_roots: Vec<Url> = workspace_roots
            .into_iter()
            .chain(library_paths)
            .collect();
        if scan_roots.is_empty() {
            return;
        }
        tokio::spawn(async move {
            let entries: Vec<(Url, String)> = tokio::task::spawn_blocking(move || {
                let mut out = Vec::new();
                for root in scan_roots {
                    let path = match root.to_file_path() {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    for entry in WalkDir::new(path)
                        .follow_links(false)
                        .into_iter()
                        .filter_map(|e| e.ok())
                    {
                        if !entry.file_type().is_file() {
                            continue;
                        }
                        let ext = entry.path().extension().and_then(|e| e.to_str());
                        if ext != Some("sysml") && ext != Some("kerml") {
                            continue;
                        }
                        if let Ok(content) = std::fs::read_to_string(entry.path()) {
                            if let Ok(uri) = Url::from_file_path(entry.path()) {
                                out.push((uri, content));
                            }
                        }
                    }
                }
                out
            })
            .await
            .unwrap_or_default();
            let mut st = state.write().await;
            let mut uris_loaded = Vec::new();
            for (uri, content) in entries {
                let uri_norm = normalize_file_uri(&uri);
                let parsed = sysml_parser::parse(&content).ok();
                if parsed.is_none() {
                    let errs = parse_failure_diagnostics(&content, 5);
                    eprintln!(
                        "[sysml-ls] workspace scan: parse failed for {} ({} diagnostics): {:?}",
                        uri_norm.as_str(),
                        errs.len(),
                        errs,
                    );
                    if errs.is_empty() {
                        eprintln!(
                            "[sysml-ls] parse() returned None but parse_with_diagnostics had 0 errors (parser may fail without filling diagnostics)",
                        );
                    }
                }
                update_semantic_graph_for_uri(&mut st, &uri_norm, parsed.as_ref());
                uris_loaded.push(uri_norm.clone());
                st.index.insert(
                    uri_norm.clone(),
                    IndexEntry {
                        content,
                        parsed,
                    },
                );
                let new_entries = semantic_model::symbol_entries_for_uri(&st.semantic_graph, &uri_norm);
                update_symbol_table_for_uri(&mut st, &uri_norm, Some(&new_entries));
            }
            for u in &uris_loaded {
                semantic_model::add_cross_document_edges_for_uri(&mut st.semantic_graph, u);
            }
            eprintln!(
                "[sysml-ls] workspace scan complete: {} URIs in index. Sample: {:?}",
                uris_loaded.len(),
                uris_loaded.iter().take(5).map(|u| u.as_str()).collect::<Vec<_>>(),
            );
        });
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        let uri_norm = normalize_file_uri(&uri);
        let text = params.text_document.text;
        let parsed = sysml_parser::parse(&text).ok();
        if parsed.is_none() {
            let errs = parse_failure_diagnostics(&text, 5);
            let msg = if errs.is_empty() {
                format!(
                    "sysml parse failed for {} (0 diagnostics; parser returned no AST and no error list)",
                    uri_norm.as_str(),
                )
            } else {
                format!(
                    "sysml parse failed for {} ({} error(s)): {}",
                    uri_norm.as_str(),
                    errs.len(),
                    errs.join("; "),
                )
            };
            self.client.log_message(MessageType::WARNING, msg).await;
        }
        {
            let mut state = self.state.write().await;
            update_semantic_graph_for_uri(&mut state, &uri_norm, parsed.as_ref());
            state.index.insert(
                uri_norm.clone(),
                IndexEntry {
                    content: text.clone(),
                    parsed,
                },
            );
            let new_entries = semantic_model::symbol_entries_for_uri(&state.semantic_graph, &uri_norm);
            update_symbol_table_for_uri(&mut state, &uri_norm, Some(&new_entries));
        }
        self.publish_diagnostics_for_document(uri, &text).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        let uri_norm = normalize_file_uri(&uri);
        {
            let mut state = self.state.write().await;
            let should_update = if let Some(entry) = state.index.get_mut(&uri_norm) {
                for change in params.content_changes {
                    if let Some(range) = change.range {
                        if let Some(new_text) =
                            apply_incremental_change(&entry.content, &range, &change.text)
                        {
                            entry.content = new_text;
                        }
                    } else {
                        entry.content = change.text;
                    }
                }
                entry.parsed = sysml_parser::parse(&entry.content).ok();
                true
            } else {
                false
            };
            if should_update {
                let doc_for_graph = state
                    .index
                    .get(&uri_norm)
                    .and_then(|e| e.parsed.as_ref())
                    .map(|root| semantic_model::build_graph_from_doc(root, &uri_norm));
                if let Some(new_graph) = doc_for_graph {
                    state.semantic_graph.remove_nodes_for_uri(&uri_norm);
                    state.semantic_graph.merge(new_graph);
                    semantic_model::add_cross_document_edges_for_uri(
                        &mut state.semantic_graph,
                        &uri_norm,
                    );
                } else {
                    state.semantic_graph.remove_nodes_for_uri(&uri_norm);
                }
                let new_entries = semantic_model::symbol_entries_for_uri(&state.semantic_graph, &uri_norm);
                update_symbol_table_for_uri(&mut state, &uri_norm, Some(&new_entries));
            }
        }
        let state = self.state.read().await;
        let text = state
            .index
            .get(&uri_norm)
            .map(|e| e.content.as_str())
            .unwrap_or("");
        let text = text.to_string();
        drop(state);
        self.publish_diagnostics_for_document(uri, &text).await;
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        // Keep index entry (last known content) so workspace features still see it until watch/scan.
        self.client
            .publish_diagnostics(params.text_document.uri, vec![], None)
            .await;
    }

    async fn did_change_watched_files(
        &self,
        params: tower_lsp::lsp_types::DidChangeWatchedFilesParams,
    ) {
        use tower_lsp::lsp_types::FileChangeType;
        let mut state = self.state.write().await;
        for event in params.changes {
            let uri_norm = normalize_file_uri(&event.uri);
            if event.typ == FileChangeType::CREATED || event.typ == FileChangeType::CHANGED {
                if let Ok(path) = event.uri.to_file_path() {
                    if let Ok(content) = tokio::fs::read_to_string(&path).await {
                        let parsed = sysml_parser::parse(&content).ok();
                        update_semantic_graph_for_uri(
                            &mut state,
                            &uri_norm,
                            parsed.as_ref(),
                        );
                        state.index.insert(
                            uri_norm.clone(),
                            IndexEntry { content, parsed },
                        );
                        let new_entries = semantic_model::symbol_entries_for_uri(
                            &state.semantic_graph,
                            &uri_norm,
                        );
                        update_symbol_table_for_uri(
                            &mut state,
                            &uri_norm,
                            Some(&new_entries),
                        );
                    }
                }
            } else if event.typ == FileChangeType::DELETED {
                state.index.remove(&uri_norm);
                remove_symbol_table_entries_for_uri(&mut state, &uri_norm);
                state.semantic_graph.remove_nodes_for_uri(&uri_norm);
            }
        }
    }

    async fn did_change_configuration(&self, params: tower_lsp::lsp_types::DidChangeConfigurationParams) {
        let new_library_paths = params
            .settings
            .get("sysml-language-server")
            .map(|v| parse_library_paths_from_value(Some(v)))
            .unwrap_or_else(|| parse_library_paths_from_value(Some(&params.settings)));
        let mut state = self.state.write().await;
        let old_library_paths = std::mem::take(&mut state.library_paths);
        if new_library_paths == old_library_paths {
            state.library_paths = old_library_paths;
            return;
        }
        let uris_to_remove: Vec<Url> = state
            .index
            .keys()
            .filter(|uri| uri_under_any_library(uri, &old_library_paths))
            .cloned()
            .collect();
        for uri in &uris_to_remove {
            state.index.remove(uri);
            remove_symbol_table_entries_for_uri(&mut state, uri);
            state.semantic_graph.remove_nodes_for_uri(uri);
        }
        state.library_paths = new_library_paths.clone();
        drop(state);
        let state = Arc::clone(&self.state);
        tokio::spawn(async move {
            let entries: Vec<(Url, String)> = tokio::task::spawn_blocking(move || {
                let mut out = Vec::new();
                for root in new_library_paths {
                    let path = match root.to_file_path() {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    for entry in WalkDir::new(path)
                        .follow_links(false)
                        .into_iter()
                        .filter_map(|e| e.ok())
                    {
                        if !entry.file_type().is_file() {
                            continue;
                        }
                        let ext = entry.path().extension().and_then(|e| e.to_str());
                        if ext != Some("sysml") && ext != Some("kerml") {
                            continue;
                        }
                        if let Ok(content) = std::fs::read_to_string(entry.path()) {
                            if let Ok(uri) = Url::from_file_path(entry.path()) {
                                out.push((uri, content));
                            }
                        }
                    }
                }
                out
            })
            .await
            .unwrap_or_default();
            let mut st = state.write().await;
            let mut uris_loaded = Vec::new();
            for (uri, content) in entries {
                let uri_norm = normalize_file_uri(&uri);
                let parsed = sysml_parser::parse(&content).ok();
                update_semantic_graph_for_uri(&mut st, &uri_norm, parsed.as_ref());
                uris_loaded.push(uri_norm.clone());
                st.index.insert(
                    uri_norm.clone(),
                    IndexEntry {
                        content,
                        parsed,
                    },
                );
                let new_entries = semantic_model::symbol_entries_for_uri(&st.semantic_graph, &uri_norm);
                update_symbol_table_for_uri(&mut st, &uri_norm, Some(&new_entries));
            }
            for u in &uris_loaded {
                semantic_model::add_cross_document_edges_for_uri(&mut st.semantic_graph, u);
            }
        });
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = params.text_document_position_params.text_document.uri.clone();
        let uri_norm = normalize_file_uri(&uri);
        let pos = params.text_document_position_params.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        let (line, char_start, char_end, word) = match word_at_position(
            &text,
            pos.line,
            pos.character,
        ) {
            Some(t) => t,
            None => return Ok(None),
        };

        let range = Range::new(
            Position::new(line, char_start),
            Position::new(line, char_end),
        );

        // Prefer keyword hover (case-insensitive) so "attribute" shows keyword help, not a symbol named "attribute"
        if let Some(md) = keyword_hover_markdown(&word.to_lowercase()) {
            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: md,
                }),
                range: Some(range),
            }));
        }

        // Look up in symbol table: collect all matches (same file first) to handle name collisions.
        let same_file: Vec<_> = state
            .symbol_table
            .iter()
            .filter(|e| e.name == word && e.uri == uri_norm)
            .collect();
        let other_files: Vec<_> = state
            .symbol_table
            .iter()
            .filter(|e| e.name == word && e.uri != uri_norm)
            .collect();
        let all_matches = if same_file.is_empty() { &other_files } else { &same_file };
        if let Some(entry) = all_matches.first() {
            let value = if all_matches.len() > 1 {
                let mut md = format!("**{}** — {} definitions (use Go to Definition to choose):\n\n", word, all_matches.len());
                for e in all_matches.iter() {
                    let kind = e.detail.as_deref().unwrap_or("element");
                    let container = e.container_name.as_deref().unwrap_or("(top level)");
                    md.push_str(&format!("• `{}` in `{}`\n", kind, container));
                }
                md.push_str("\n");
                md.push_str(&symbol_hover_markdown(entry, entry.uri != uri_norm));
                md
            } else {
                symbol_hover_markdown(entry, entry.uri != uri_norm)
            };
            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value,
                }),
                range: Some(range),
            }));
        }

        Ok(None)
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let uri = params.text_document_position.text_document.uri;
        let uri_norm = normalize_file_uri(&uri);
        let pos = params.text_document_position.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        let line_prefix = line_prefix_at_position(&text, pos.line, pos.character);
        let prefix = completion_prefix(&line_prefix);

        let mut items = Vec::new();

        for kw in sysml_keywords() {
            if prefix.is_empty() || kw.starts_with(prefix) {
                items.push(CompletionItem {
                    label: (*kw).to_string(),
                    kind: Some(CompletionItemKind::KEYWORD),
                    detail: keyword_doc(kw).map(String::from),
                    ..Default::default()
                });
            }
        }

        let mut seen = std::collections::HashSet::<String>::new();
        for entry in &state.symbol_table {
            if (prefix.is_empty() || entry.name.starts_with(prefix)) && seen.insert(entry.name.clone()) {
                items.push(CompletionItem {
                    label: entry.name.clone(),
                    kind: Some(CompletionItemKind::REFERENCE),
                    detail: entry.description.clone().or_else(|| entry.detail.clone()),
                    ..Default::default()
                });
            }
        }

        Ok(Some(CompletionResponse::Array(items)))
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let uri = params.text_document_position_params.text_document.uri.clone();
        let uri_norm = normalize_file_uri(&uri);
        let pos = params.text_document_position_params.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        let (_, _, _, word) = match word_at_position(&text, pos.line, pos.character) {
            Some(t) => t,
            None => return Ok(None),
        };

        if is_reserved_keyword(&word) {
            return Ok(None);
        }

        // 2.2: Try graph-based resolution via typing/specializes edges (works cross-file).
        if let Some(node) = state.semantic_graph.find_node_at_position(&uri_norm, pos) {
            for target in state.semantic_graph.outgoing_typing_or_specializes_targets(node) {
                if target.name == word || target.id.qualified_name.ends_with(&format!("::{}", word))
                {
                    return Ok(Some(GotoDefinitionResponse::Scalar(Location {
                        uri: target.id.uri.clone(),
                        range: target.range,
                    })));
                }
            }
        }

        // Fall back to symbol table: collect all matches to handle name collisions (e.g. package and part def same name).
        let same_file: Vec<_> = state
            .symbol_table
            .iter()
            .filter(|e| e.name == word && e.uri == uri_norm)
            .map(|e| Location { uri: e.uri.clone(), range: e.range })
            .collect();
        let other_files: Vec<_> = state
            .symbol_table
            .iter()
            .filter(|e| e.name == word && e.uri != uri_norm)
            .map(|e| Location { uri: e.uri.clone(), range: e.range })
            .collect();
        let locations = if same_file.is_empty() { other_files } else { same_file };
        if locations.len() == 1 {
            return Ok(Some(GotoDefinitionResponse::Scalar(locations.into_iter().next().unwrap())));
        }
        if !locations.is_empty() {
            return Ok(Some(GotoDefinitionResponse::Array(locations)));
        }
        Ok(None)
    }

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let uri = params.text_document_position.text_document.uri.clone();
        let uri_norm = normalize_file_uri(&uri);
        let pos = params.text_document_position.position;
        let include_declaration = params.context.include_declaration;
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        let (_, _, _, word) = match word_at_position(&text, pos.line, pos.character) {
            Some(t) => t,
            None => return Ok(None),
        };

        let mut def_locations: Vec<(Url, Range)> = Vec::new();
        for (u, entry) in state.index.iter() {
            if let Some(ref doc) = entry.parsed {
                for (name, range) in collect_definition_ranges(doc) {
                    if name == word {
                        def_locations.push((u.clone(), range));
                    }
                }
            }
        }

        let mut locations: Vec<Location> = Vec::new();
        for (u, entry) in state.index.iter() {
            for range in find_reference_ranges(&entry.content, &word) {
                locations.push(Location {
                    uri: u.clone(),
                    range,
                });
            }
        }

        if !include_declaration {
            for (def_uri, def_range) in &def_locations {
                locations.retain(|loc| !(loc.uri == *def_uri && loc.range == *def_range));
            }
        }

        Ok(Some(locations))
    }

    async fn prepare_rename(
        &self,
        params: TextDocumentPositionParams,
    ) -> Result<Option<PrepareRenameResponse>> {
        let uri = params.text_document.uri;
        let uri_norm = normalize_file_uri(&uri);
        let pos = params.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        let (line, char_start, char_end, word) = match word_at_position(&text, pos.line, pos.character) {
            Some(t) => t,
            None => return Ok(None),
        };
        if is_reserved_keyword(&word) {
            return Ok(None);
        }
        let range = Range::new(
            Position::new(line, char_start),
            Position::new(line, char_end),
        );
        Ok(Some(PrepareRenameResponse::Range(range)))
    }

    async fn rename(&self, params: RenameParams) -> Result<Option<WorkspaceEdit>> {
        let uri = params.text_document_position.text_document.uri.clone();
        let uri_norm = normalize_file_uri(&uri);
        let pos = params.text_document_position.position;
        let new_name = params.new_name;
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        let (_, _, _, word) = match word_at_position(&text, pos.line, pos.character) {
            Some(t) => t,
            None => return Ok(None),
        };
        if is_reserved_keyword(&word) {
            return Ok(None);
        }

        let mut locations: Vec<Location> = Vec::new();
        for (u, entry) in state.index.iter() {
            for range in find_reference_ranges(&entry.content, &word) {
                locations.push(Location {
                    uri: u.clone(),
                    range,
                });
            }
        }

        if locations.is_empty() {
            return Ok(Some(WorkspaceEdit::default()));
        }

        let mut changes: std::collections::HashMap<Url, Vec<TextEdit>> = std::collections::HashMap::new();
        for loc in locations {
            changes
                .entry(loc.uri.clone())
                .or_default()
                .push(TextEdit {
                    range: loc.range,
                    new_text: new_name.clone(),
                });
        }
        Ok(Some(WorkspaceEdit {
            changes: Some(changes),
            document_changes: None,
            change_annotations: None,
        }))
    }

    async fn document_symbol(
        &self,
        params: DocumentSymbolParams,
    ) -> Result<Option<DocumentSymbolResponse>> {
        let uri = params.text_document.uri;
        let uri_norm = normalize_file_uri(&uri);
        let state = self.state.read().await;
        let entry = match state.index.get(&uri_norm) {
            Some(e) => e,
            None => return Ok(None),
        };
        let doc = match &entry.parsed {
            Some(d) => d,
            None => return Ok(None),
        };
        let symbols = collect_document_symbols(doc);
        Ok(Some(DocumentSymbolResponse::Nested(symbols)))
    }

    async fn folding_range(
        &self,
        params: FoldingRangeParams,
    ) -> Result<Option<Vec<FoldingRange>>> {
        let uri = params.text_document.uri;
        let uri_norm = normalize_file_uri(&uri);
        let state = self.state.read().await;
        let entry = match state.index.get(&uri_norm) {
            Some(e) => e,
            None => return Ok(None),
        };
        let doc = match &entry.parsed {
            Some(d) => d,
            None => return Ok(None),
        };
        Ok(Some(collect_folding_ranges(doc)))
    }

    async fn symbol(
        &self,
        params: tower_lsp::lsp_types::WorkspaceSymbolParams,
    ) -> Result<Option<Vec<tower_lsp::lsp_types::SymbolInformation>>> {
        let query = params.query.to_lowercase();
        let state = self.state.read().await;
        let out: Vec<SymbolInformation> = state
            .symbol_table
            .iter()
            .filter(|e| query.is_empty() || e.name.to_lowercase().contains(&query))
            .map(|e| SymbolInformation {
                name: e.name.clone(),
                kind: e.kind,
                tags: None,
                deprecated: None,
                location: Location {
                    uri: e.uri.clone(),
                    range: e.range,
                },
                container_name: e.container_name.clone(),
            })
            .collect();
        Ok(Some(out))
    }

    async fn code_action(
        &self,
        params: CodeActionParams,
    ) -> Result<Option<CodeActionResponse>> {
        let uri = params.text_document.uri.clone();
        let uri_norm = normalize_file_uri(&uri);
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        drop(state);

        let mut actions: Vec<CodeActionOrCommand> = Vec::new();
        if let Some(action) = suggest_wrap_in_package(&text, &uri) {
            actions.push(CodeActionOrCommand::CodeAction(action));
        }
        Ok(Some(actions))
    }

    async fn formatting(
        &self,
        params: DocumentFormattingParams,
    ) -> Result<Option<Vec<TextEdit>>> {
        let uri = params.text_document.uri;
        let uri_norm = normalize_file_uri(&uri);
        let state = self.state.read().await;
        let text = match state.index.get(&uri_norm).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        drop(state);
        Ok(Some(format_document(&text, &params.options)))
    }

    async fn semantic_tokens_full(
        &self,
        params: SemanticTokensParams,
    ) -> Result<Option<SemanticTokensResult>> {
        let uri = params.text_document.uri;
        let uri_norm = normalize_file_uri(&uri);
        let state = self.state.read().await;
        let (text, ast_ranges) = match state.index.get(&uri_norm) {
            Some(e) => (
                e.content.clone(),
                e.parsed.as_ref().map(ast_semantic_ranges),
            ),
            None => return Ok(None),
        };
        drop(state);
        let (tokens, log_lines) = semantic_tokens_full(&text, ast_ranges.as_deref());
        for line in &log_lines {
            self.client
                .log_message(MessageType::LOG, line)
                .await;
        }
        Ok(Some(SemanticTokensResult::Tokens(tokens)))
    }

    async fn semantic_tokens_range(
        &self,
        params: SemanticTokensRangeParams,
    ) -> Result<Option<SemanticTokensRangeResult>> {
        let uri = params.text_document.uri;
        let uri_norm = normalize_file_uri(&uri);
        let range = params.range;
        let state = self.state.read().await;
        let (text, ast_ranges) = match state.index.get(&uri_norm) {
            Some(e) => (
                e.content.clone(),
                e.parsed.as_ref().map(ast_semantic_ranges),
            ),
            None => return Ok(None),
        };
        drop(state);
        let (tokens, log_lines) = semantic_tokens_range(
            &text,
            range.start.line,
            range.start.character,
            range.end.line,
            range.end.character,
            ast_ranges.as_deref(),
        );
        for line in &log_lines {
            self.client
                .log_message(MessageType::LOG, line)
                .await;
        }
        Ok(Some(SemanticTokensRangeResult::Tokens(tokens)))
    }
}

fn empty_model_response(build_start: Instant) -> SysmlModelResultDto {
    SysmlModelResultDto {
        version: 0,
        graph: Some(SysmlGraphDto {
            nodes: vec![],
            edges: vec![],
        }),
        activity_diagrams: None,
        sequence_diagrams: None,
        ibd: None,
        stats: Some(SysmlModelStatsDto {
            total_elements: 0,
            resolved_elements: 0,
            unresolved_elements: 0,
            parse_time_ms: 0,
            model_build_time_ms: build_start.elapsed().as_millis() as u32,
            parse_cached: true,
        }),
    }
}

impl Backend {
    async fn sysml_model(&self, params: serde_json::Value) -> Result<SysmlModelResultDto> {
        let (uri, scope) = parse_sysml_model_params(&params)?;
        let want_graph = scope.is_empty() || scope.iter().any(|s| s == "graph") || scope.iter().any(|s| s == "elements") || scope.iter().any(|s| s == "relationships");
        let want_stats = scope.is_empty() || scope.iter().any(|s| s == "stats");
        let want_activity_diagrams = scope.is_empty() || scope.iter().any(|s| s == "activityDiagrams");
        let want_sequence_diagrams = scope.is_empty() || scope.iter().any(|s| s == "sequenceDiagrams");

        let build_start = Instant::now();
        let state = self.state.read().await;
        let entry = match state.index.get(&uri) {
            Some(e) => e,
            None => {
                let uri_display = uri.as_str();
                let index_len = state.index.len();
                let indexed_uris: Vec<String> = state
                    .index
                    .keys()
                    .map(|u| u.as_str().to_string())
                    .collect();
                self.client
                    .log_message(
                        MessageType::WARNING,
                        format!(
                            "sysml/model: document not in index. request_uri={} (len={}) index_size={} \
                            indexed_uris_count={}. First 5 indexed: {:?}. \
                            Check URI normalization (e.g. drive letter casing on Windows).",
                            uri_display,
                            uri_display.len(),
                            index_len,
                            indexed_uris.len(),
                            indexed_uris.iter().take(5).collect::<Vec<_>>(),
                        ),
                    )
                    .await;
                return Ok(empty_model_response(build_start));
            }
        };

        let graph = if want_graph {
            let sg_nodes = state.semantic_graph.nodes_for_uri(&uri);
            let node_count = sg_nodes.len();
            let graph_uris = state.semantic_graph.uris_with_nodes();
            let parsed_ok = entry.parsed.is_some();
            if !parsed_ok {
                let errs = parse_failure_diagnostics(&entry.content, 5);
                self.client
                    .log_message(
                        MessageType::WARNING,
                        format!(
                            "sysml/model: document in index but parse failed (parsed_ok=false). uri={} parse_errors={}",
                            uri.as_str(),
                            errs.join("; "),
                        ),
                    )
                    .await;
            }
            self.client
                .log_message(
                    MessageType::INFO,
                    format!(
                        "sysml/model: req_uri={} index_ok=true parsed_ok={} semantic_nodes={} graph_uris_count={} graph_uris_sample={:?}",
                        uri.as_str(),
                        parsed_ok,
                        node_count,
                        graph_uris.len(),
                        graph_uris.iter().take(3).collect::<Vec<_>>(),
                    ),
                )
                .await;
            let nodes: Vec<GraphNodeDto> = sg_nodes
                .into_iter()
                .map(|n| GraphNodeDto {
                    id: n.id.qualified_name.clone(),
                    element_type: n.element_kind.clone(),
                    name: n.name.clone(),
                    parent_id: n.parent_id.as_ref().map(|p| p.qualified_name.clone()),
                    range: range_to_dto(n.range),
                    attributes: n.attributes.clone(),
                })
                .collect();

            let mut edges: Vec<GraphEdgeDto> = state
                .semantic_graph
                .edges_for_uri_as_strings(&uri)
                .into_iter()
                .map(|(src, tgt, kind, name)| GraphEdgeDto {
                    source: src,
                    target: tgt,
                    rel_type: kind.as_str().to_string(),
                    name,
                })
                .collect();

            for n in state.semantic_graph.nodes_for_uri(&uri) {
                if let Some(ref pid) = n.parent_id {
                    edges.push(GraphEdgeDto {
                        source: pid.qualified_name.clone(),
                        target: n.id.qualified_name.clone(),
                        rel_type: "contains".to_string(),
                        name: None,
                    });
                }
            }

            Some(SysmlGraphDto { nodes, edges })
        } else {
            None
        };

        let doc = entry.parsed.as_ref();

        let activity_diagrams = if want_activity_diagrams {
            Some(
                doc.map(model::extract_activity_diagrams)
                    .unwrap_or_default(),
            )
        } else {
            None
        };

        let sequence_diagrams = if want_sequence_diagrams {
            Some(
                doc.map(model::extract_sequence_diagrams)
                    .unwrap_or_default(),
            )
        } else {
            None
        };

        let stats = if want_stats {
            let total = graph.as_ref().map(|g| g.nodes.len() as u32).unwrap_or(0);
            Some(SysmlModelStatsDto {
                total_elements: total,
                resolved_elements: 0,
                unresolved_elements: 0,
                parse_time_ms: 0,
                model_build_time_ms: build_start.elapsed().as_millis() as u32,
                parse_cached: true,
            })
        } else {
            None
        };

        let node_count = graph.as_ref().map(|g| g.nodes.len()).unwrap_or(0);
        let edge_count = graph.as_ref().map(|g| g.edges.len()).unwrap_or(0);
        self.client
            .log_message(
                MessageType::INFO,
                format!(
                    "sysml/model: uri={} scope={:?} -> graph nodes={} edges={}",
                    uri.as_str(),
                    scope,
                    node_count,
                    edge_count,
                ),
            )
            .await;

        let ibd = if want_graph && graph.is_some() {
            Some(ibd::build_ibd_for_uri(&state.semantic_graph, &uri))
        } else {
            None
        };

        Ok(SysmlModelResultDto {
            version: 0,
            graph,
            activity_diagrams,
            sequence_diagrams,
            ibd,
            stats,
        })
    }

    async fn sysml_server_stats(&self) -> Result<SysmlServerStatsDto> {
        let state = self.state.read().await;
        Ok(SysmlServerStatsDto {
            uptime: self.start_time.elapsed().as_secs(),
            memory: SysmlServerMemoryDto { rss: 0 },
            caches: SysmlServerCachesDto {
                documents: state.index.len(),
                symbol_tables: state.symbol_table.len(),
                semantic_tokens: 0,
            },
        })
    }

    async fn sysml_clear_cache(&self) -> Result<SysmlClearCacheResultDto> {
        let mut state = self.state.write().await;
        let docs = state.index.len();
        let syms = state.symbol_table.len();
        state.index.clear();
        state.symbol_table.clear();
        state.semantic_graph = semantic_model::SemanticGraph::default();
        Ok(SysmlClearCacheResultDto {
            documents: docs,
            symbol_tables: syms,
            semantic_tokens: 0,
        })
    }

    async fn publish_diagnostics_for_document(
        &self,
        uri: tower_lsp::lsp_types::Url,
        text: &str,
    ) {
        let mut diagnostics = Vec::new();
        let result = sysml_parser::parse_with_diagnostics(text);
        for e in result.errors {
            let range = e.to_lsp_range().map(|(sl, sc, el, ec)| Range {
                start: Position::new(sl, sc),
                end: Position::new(el, ec),
            }).unwrap_or_else(|| Range {
                start: Position::new(0, 0),
                end: Position::new(0, 0),
            });
            let severity = e.severity.map(|s| match s {
                sysml_parser::DiagnosticSeverity::Error => DiagnosticSeverity::ERROR,
                sysml_parser::DiagnosticSeverity::Warning => DiagnosticSeverity::WARNING,
            }).unwrap_or(DiagnosticSeverity::ERROR);
            diagnostics.push(Diagnostic {
                range,
                severity: Some(severity),
                code: e.code.map(tower_lsp::lsp_types::NumberOrString::String),
                code_description: None,
                source: Some("sysml".to_string()),
                message: e.message.clone(),
                related_information: None,
                tags: None,
                data: None,
            });
        }
        self.client
            .publish_diagnostics(uri, diagnostics, None)
            .await;
    }
}

#[tokio::main]
async fn main() {
    let (stdin, stdout) = (tokio::io::stdin(), tokio::io::stdout());
    let state = Arc::new(RwLock::new(ServerState::default()));
    let start_time = Instant::now();
    let (service, socket) = LspService::build(move |client| Backend {
        client,
        state: Arc::clone(&state),
        start_time,
    })
    .custom_method("sysml/model", Backend::sysml_model)
    .custom_method("sysml/serverStats", Backend::sysml_server_stats)
    .custom_method("sysml/clearCache", Backend::sysml_clear_cache)
    .finish();
    Server::new(stdin, stdout, socket).serve(service).await;
}
