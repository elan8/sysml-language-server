//! SysML v2 language server (LSP over stdio).
#![allow(deprecated)] // LSP deprecated field in SymbolInformation; use tags in future

mod language;
mod model;
mod semantic_tokens;

use kerml_parser::ast::SysMLDocument;
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
    collect_definition_ranges, collect_document_symbols, collect_model_elements,
    collect_relationships, collect_symbol_entries, completion_prefix, collect_folding_ranges,
    find_reference_ranges, format_document, is_reserved_keyword, keyword_doc, keyword_hover_markdown,
    line_prefix_at_position, suggest_wrap_in_package, sysml_keywords, word_at_position, SymbolEntry,
};

/// Per-file index entry: content and optional parsed AST (invalidated when content changes).
#[derive(Debug)]
struct IndexEntry {
    content: String,
    parsed: Option<SysMLDocument>,
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
    elements: Option<Vec<SysmlElementDto>>,
    relationships: Option<Vec<RelationshipDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activity_diagrams: Option<Vec<model::ActivityDiagramDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequence_diagrams: Option<Vec<model::SequenceDiagramDto>>,
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

fn model_element_to_dto(el: &language::ModelElement) -> SysmlElementDto {
    SysmlElementDto {
        element_type: el.element_type.clone(),
        name: el.name.clone(),
        range: range_to_dto(el.range),
        children: el.children.iter().map(model_element_to_dto).collect(),
        attributes: el.attributes.clone(),
        relationships: vec![],
        errors: None,
    }
}

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
            for (uri, content) in entries {
                let parsed = kerml_parser::parse_sysml(&content).ok();
                let new_entries = parsed.as_ref().map(|doc| collect_symbol_entries(doc, &uri));
                st.index.insert(
                    uri.clone(),
                    IndexEntry {
                        content,
                        parsed,
                    },
                );
                update_symbol_table_for_uri(&mut st, &uri, new_entries.as_deref());
            }
        });
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        let text = params.text_document.text;
        let parsed = kerml_parser::parse_sysml(&text).ok();
        {
            let mut state = self.state.write().await;
            let new_entries = parsed.as_ref().map(|doc| collect_symbol_entries(doc, &uri));
            state.index.insert(
                uri.clone(),
                IndexEntry {
                    content: text.clone(),
                    parsed,
                },
            );
            update_symbol_table_for_uri(&mut state, &uri, new_entries.as_deref());
        }
        self.publish_diagnostics_for_document(uri, &text).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        {
            let mut state = self.state.write().await;
            let (should_update, new_entries) = if let Some(entry) = state.index.get_mut(&uri) {
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
                entry.parsed = kerml_parser::parse_sysml(&entry.content).ok();
                let new_entries = entry
                    .parsed
                    .as_ref()
                    .map(|doc| collect_symbol_entries(doc, &uri));
                (true, new_entries)
            } else {
                (false, None)
            };
            if should_update {
                update_symbol_table_for_uri(&mut state, &uri, new_entries.as_deref());
            }
        }
        let state = self.state.read().await;
        let text = state
            .index
            .get(&uri)
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
            if event.typ == FileChangeType::CREATED || event.typ == FileChangeType::CHANGED {
                if let Ok(path) = event.uri.to_file_path() {
                    if let Ok(content) = tokio::fs::read_to_string(&path).await {
                        let parsed = kerml_parser::parse_sysml(&content).ok();
                        let new_entries =
                            parsed.as_ref().map(|doc| collect_symbol_entries(doc, &event.uri));
                        state.index.insert(
                            event.uri.clone(),
                            IndexEntry { content, parsed },
                        );
                        update_symbol_table_for_uri(
                            &mut state,
                            &event.uri,
                            new_entries.as_deref(),
                        );
                    }
                }
            } else if event.typ == FileChangeType::DELETED {
                state.index.remove(&event.uri);
                remove_symbol_table_entries_for_uri(&mut state, &event.uri);
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
            for (uri, content) in entries {
                let parsed = kerml_parser::parse_sysml(&content).ok();
                let new_entries = parsed.as_ref().map(|doc| collect_symbol_entries(doc, &uri));
                st.index.insert(
                    uri.clone(),
                    IndexEntry {
                        content,
                        parsed,
                    },
                );
                update_symbol_table_for_uri(&mut st, &uri, new_entries.as_deref());
            }
        });
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = params.text_document_position_params.text_document.uri.clone();
        let pos = params.text_document_position_params.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
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

        // Look up in symbol table: current file first, then others.
        if let Some(entry) = state
            .symbol_table
            .iter()
            .find(|e| e.name == word && e.uri == uri)
        {
            let value = symbol_hover_markdown(entry, false);
            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value,
                }),
                range: Some(range),
            }));
        }
        if let Some(entry) = state
            .symbol_table
            .iter()
            .find(|e| e.name == word && e.uri != uri)
        {
            let value = symbol_hover_markdown(entry, true);
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
        let pos = params.text_document_position.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
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
        let pos = params.text_document_position_params.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
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

        // Look up in symbol table: same file first, then rest of workspace.
        if let Some(entry) = state
            .symbol_table
            .iter()
            .find(|e| e.name == word && e.uri == uri)
        {
            return Ok(Some(GotoDefinitionResponse::Scalar(Location {
                uri: entry.uri.clone(),
                range: entry.range,
            })));
        }
        if let Some(entry) = state
            .symbol_table
            .iter()
            .find(|e| e.name == word && e.uri != uri)
        {
            return Ok(Some(GotoDefinitionResponse::Scalar(Location {
                uri: entry.uri.clone(),
                range: entry.range,
            })));
        }
        Ok(None)
    }

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let uri = params.text_document_position.text_document.uri.clone();
        let pos = params.text_document_position.position;
        let include_declaration = params.context.include_declaration;
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
            Some(t) => t.to_string(),
            None => return Ok(None),
        };
        let (_, _, _, word) = match word_at_position(&text, pos.line, pos.character) {
            Some(t) => t,
            None => return Ok(None),
        };

        let mut def_location: Option<(Url, Range)> = None;
        for (u, entry) in state.index.iter() {
            if let Some(ref doc) = entry.parsed {
                if let Some((_, range)) = collect_definition_ranges(doc)
                    .into_iter()
                    .find(|(name, _)| name == &word)
                {
                    def_location = Some((u.clone(), range));
                    break;
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
            if let Some((def_uri, def_range)) = &def_location {
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
        let pos = params.position;
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
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
        let pos = params.text_document_position.position;
        let new_name = params.new_name;
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
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
        let state = self.state.read().await;
        let entry = match state.index.get(&uri) {
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
        let state = self.state.read().await;
        let entry = match state.index.get(&uri) {
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
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
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
        let state = self.state.read().await;
        let text = match state.index.get(&uri).map(|e| e.content.as_str()) {
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
        let state = self.state.read().await;
        let (text, ast_ranges) = match state.index.get(&uri) {
            Some(e) => (
                e.content.clone(),
                e.parsed.as_ref().map(ast_semantic_ranges),
            ),
            None => return Ok(None),
        };
        drop(state);
        let tokens = semantic_tokens_full(&text, ast_ranges.as_deref());
        Ok(Some(SemanticTokensResult::Tokens(tokens)))
    }

    async fn semantic_tokens_range(
        &self,
        params: SemanticTokensRangeParams,
    ) -> Result<Option<SemanticTokensRangeResult>> {
        let uri = params.text_document.uri;
        let range = params.range;
        let state = self.state.read().await;
        let (text, ast_ranges) = match state.index.get(&uri) {
            Some(e) => (
                e.content.clone(),
                e.parsed.as_ref().map(ast_semantic_ranges),
            ),
            None => return Ok(None),
        };
        drop(state);
        let tokens = semantic_tokens_range(
            &text,
            range.start.line,
            range.start.character,
            range.end.line,
            range.end.character,
            ast_ranges.as_deref(),
        );
        Ok(Some(SemanticTokensRangeResult::Tokens(tokens)))
    }
}

fn empty_model_response(build_start: Instant) -> SysmlModelResultDto {
    SysmlModelResultDto {
        version: 0,
        elements: Some(vec![]),
        relationships: Some(vec![]),
        activity_diagrams: None,
        sequence_diagrams: None,
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
        let want_elements = scope.is_empty() || scope.iter().any(|s| s == "elements");
        let want_stats = scope.is_empty() || scope.iter().any(|s| s == "stats");
        let want_relationships = scope.iter().any(|s| s == "relationships");
        let want_activity_diagrams = scope.is_empty() || scope.iter().any(|s| s == "activityDiagrams");
        let want_sequence_diagrams = scope.is_empty() || scope.iter().any(|s| s == "sequenceDiagrams");

        let build_start = Instant::now();
        let state = self.state.read().await;
        let entry = match state.index.get(&uri) {
            Some(e) => e,
            None => {
                return Ok(empty_model_response(build_start));
            }
        };
        let doc = match &entry.parsed {
            Some(d) => d,
            None => {
                return Ok(SysmlModelResultDto {
                    version: 0,
                    elements: Some(vec![]),
                    relationships: Some(vec![]),
                    activity_diagrams: None,
                    sequence_diagrams: None,
                    stats: None,
                });
            }
        };

        let elements = if want_elements {
            let model_elements = collect_model_elements(doc);
            Some(model_elements.iter().map(model_element_to_dto).collect::<Vec<_>>())
        } else {
            None
        };

        let relationships = if want_relationships {
            let rels = collect_relationships(doc);
            Some(
                rels.iter()
                    .map(|r| RelationshipDto {
                        rel_type: r.rel_type.clone(),
                        source: r.source.clone(),
                        target: r.target.clone(),
                        name: r.name.clone(),
                    })
                    .collect(),
            )
        } else {
            None
        };

        let activity_diagrams = if want_activity_diagrams {
            Some(model::extract_activity_diagrams(doc))
        } else {
            None
        };

        let sequence_diagrams = if want_sequence_diagrams {
            Some(model::extract_sequence_diagrams(doc))
        } else {
            None
        };

        let stats = if want_stats {
            let total = elements.as_ref().map(|e| count_elements(e)).unwrap_or(0);
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

        Ok(SysmlModelResultDto {
            version: 0,
            elements,
            relationships,
            activity_diagrams,
            sequence_diagrams,
            stats,
        })
    }

    async fn sysml_server_stats(&self, _params: serde_json::Value) -> Result<SysmlServerStatsDto> {
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

    async fn sysml_clear_cache(&self, _params: serde_json::Value) -> Result<SysmlClearCacheResultDto> {
        let mut state = self.state.write().await;
        let docs = state.index.len();
        let syms = state.symbol_table.len();
        state.index.clear();
        state.symbol_table.clear();
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
        let (_result, errors) = kerml_parser::parse_sysml_collect_errors(text);
        for e in errors {
            let (line, character) = e.position().unwrap_or((0, 0));
            diagnostics.push(Diagnostic {
                range: Range {
                    start: Position::new(line, character),
                    end: Position::new(line, character),
                },
                severity: Some(DiagnosticSeverity::ERROR),
                code: None,
                code_description: None,
                source: Some("sysml".to_string()),
                message: e.to_string(),
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
