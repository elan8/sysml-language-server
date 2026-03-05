//! SysML v2 language server (LSP over stdio).

mod language;
mod semantic_tokens;

use kerml_parser::ast::SysMLDocument;
use std::sync::Arc;
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
use semantic_tokens::{legend, semantic_tokens_full, semantic_tokens_range};
use tower_lsp::{Client, LanguageServer, LspService, Server};
use walkdir::WalkDir;

use language::{
    collect_definition_ranges, collect_document_symbols, collect_symbol_entries, completion_prefix,
    find_reference_ranges, format_document, keyword_doc, line_prefix_at_position,
    suggest_wrap_in_package, sysml_keywords, word_at_position, SymbolEntry,
};

/// Per-file index entry: content and optional parsed AST (invalidated when content changes).
#[derive(Debug)]
struct IndexEntry {
    content: String,
    parsed: Option<SysMLDocument>,
}

#[derive(Debug)]
struct ServerState {
    /// Workspace root URIs from initialize (workspace_folders or root_uri).
    workspace_roots: Vec<Url>,
    /// One source of truth: URI -> (content, parsed). Open docs and workspace-scanned files.
    index: std::collections::HashMap<Url, IndexEntry>,
    /// Workspace-wide symbol table: flat list of definable symbols, updated when index changes.
    symbol_table: Vec<SymbolEntry>,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            workspace_roots: Vec::new(),
            index: std::collections::HashMap::new(),
            symbol_table: Vec::new(),
        }
    }
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

#[derive(Debug)]
struct Backend {
    client: Client,
    state: Arc<RwLock<ServerState>>,
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
        {
            let mut state = self.state.write().await;
            state.workspace_roots = roots;
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
        let roots = state.read().await.workspace_roots.clone();
        if roots.is_empty() {
            return;
        }
        tokio::spawn(async move {
            let entries: Vec<(Url, String)> = tokio::task::spawn_blocking(move || {
                let mut out = Vec::new();
                for root in roots {
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

        if let Some(doc) = keyword_doc(&word) {
            return Ok(Some(Hover {
                contents: HoverContents::Scalar(MarkedString::String(doc.to_string())),
                range: Some(range),
            }));
        }

        // Look up in symbol table: current file first, then others.
        if let Some(entry) = state
            .symbol_table
            .iter()
            .find(|e| e.name == word && e.uri == uri)
        {
            let contents = entry
                .description
                .clone()
                .unwrap_or_else(|| entry.name.clone());
            return Ok(Some(Hover {
                contents: HoverContents::Scalar(MarkedString::String(contents)),
                range: Some(range),
            }));
        }
        if let Some(entry) = state
            .symbol_table
            .iter()
            .find(|e| e.name == word && e.uri != uri)
        {
            let contents = entry.description.clone().unwrap_or_else(|| entry.name.clone());
            let location_note = format!("Defined in {}", entry.uri.path());
            return Ok(Some(Hover {
                contents: HoverContents::Scalar(MarkedString::String(format!(
                    "{}\n\n{}",
                    contents,
                    location_note
                ))),
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

        if language::sysml_keywords().contains(&word.as_str()) {
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
        if language::sysml_keywords().contains(&word.as_str()) {
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
        if language::sysml_keywords().contains(&word.as_str()) {
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
        let (text, type_ref_ranges) = match state.index.get(&uri) {
            Some(e) => (
                e.content.clone(),
                e.parsed.as_ref().map(kerml_parser::collect_type_ref_ranges),
            ),
            None => return Ok(None),
        };
        drop(state);
        let tokens = semantic_tokens_full(&text, type_ref_ranges.as_deref());
        Ok(Some(SemanticTokensResult::Tokens(tokens)))
    }

    async fn semantic_tokens_range(
        &self,
        params: SemanticTokensRangeParams,
    ) -> Result<Option<SemanticTokensRangeResult>> {
        let uri = params.text_document.uri;
        let range = params.range;
        let state = self.state.read().await;
        let (text, type_ref_ranges) = match state.index.get(&uri) {
            Some(e) => (
                e.content.clone(),
                e.parsed.as_ref().map(kerml_parser::collect_type_ref_ranges),
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
            type_ref_ranges.as_deref(),
        );
        Ok(Some(SemanticTokensRangeResult::Tokens(tokens)))
    }
}

impl Backend {
    async fn publish_diagnostics_for_document(
        &self,
        uri: tower_lsp::lsp_types::Url,
        text: &str,
    ) {
        let mut diagnostics = Vec::new();
        match kerml_parser::parse_sysml(text) {
            Ok(_) => {}
            Err(e) => {
                let (line, character) = e
                    .position()
                    .unwrap_or((0, 0));
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
    let (service, socket) = LspService::new(move |client| Backend {
        client,
        state: Arc::clone(&state),
    });
    Server::new(stdin, stdout, socket).serve(service).await;
}
