//! SysML v2 language server (LSP over stdio).

mod language;

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
use tower_lsp::{Client, LanguageServer, LspService, Server};

use language::{
    collect_definition_ranges, collect_document_symbols, collect_named_elements, completion_prefix,
    find_reference_ranges, format_document, keyword_doc, line_prefix_at_position,
    suggest_wrap_in_package, sysml_keywords, word_at_position,
};

#[derive(Debug, Default)]
struct ServerState {
    /// Open documents: URI -> content.
    documents: std::collections::HashMap<tower_lsp::lsp_types::Url, String>,
}

#[derive(Debug)]
struct Backend {
    client: Client,
    state: Arc<RwLock<ServerState>>,
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _params: InitializeParams) -> Result<InitializeResult> {
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
                document_symbol_provider: Some(OneOf::Left(true)),
                code_action_provider: Some(CodeActionProviderCapability::Simple(true)),
                document_formatting_provider: Some(OneOf::Left(true)),
                ..ServerCapabilities::default()
            },
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "sysml-language-server initialized")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        let text = params.text_document.text;
        {
            let mut state = self.state.write().await;
            state.documents.insert(uri.clone(), text.clone());
        }
        self.publish_diagnostics_for_document(uri, &text).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        {
            let mut state = self.state.write().await;
            if let Some(text) = state.documents.get_mut(&uri) {
                for change in params.content_changes {
                    if let Some(range) = change.range {
                        if let Some(new_text) = apply_incremental_change(text, &range, &change.text)
                        {
                            *text = new_text;
                        }
                    } else {
                        *text = change.text;
                    }
                }
            }
        }
        let state = self.state.read().await;
        let text = state.documents.get(&uri).cloned().unwrap_or_default();
        drop(state);
        self.publish_diagnostics_for_document(uri, &text).await;
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let mut state = self.state.write().await;
        state.documents.remove(&params.text_document.uri);
        self.client
            .publish_diagnostics(params.text_document.uri, vec![], None)
            .await;
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;
        let state = self.state.read().await;
        let text = match state.documents.get(&uri) {
            Some(t) => t.clone(),
            None => return Ok(None),
        };
        drop(state);

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

        if let Ok(ast) = kerml_parser::parse_sysml(&text) {
            let elements = collect_named_elements(&ast);
            if let Some((_, desc)) = elements.into_iter().find(|(name, _)| name == &word) {
                return Ok(Some(Hover {
                    contents: HoverContents::Scalar(MarkedString::String(desc)),
                    range: Some(range),
                }));
            }
        }

        Ok(None)
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;
        let state = self.state.read().await;
        let text = match state.documents.get(&uri) {
            Some(t) => t.clone(),
            None => return Ok(None),
        };
        drop(state);

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

        if let Ok(ast) = kerml_parser::parse_sysml(&text) {
            let elements = collect_named_elements(&ast);
            for (name, desc) in elements {
                if prefix.is_empty() || name.starts_with(prefix) {
                    items.push(CompletionItem {
                        label: name.clone(),
                        kind: Some(CompletionItemKind::REFERENCE),
                        detail: Some(desc),
                        ..Default::default()
                    });
                }
            }
        }

        Ok(Some(CompletionResponse::Array(items)))
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;
        let state = self.state.read().await;
        let text = match state.documents.get(&uri) {
            Some(t) => t.clone(),
            None => return Ok(None),
        };
        drop(state);

        let (_, _, _, word) = match word_at_position(&text, pos.line, pos.character) {
            Some(t) => t,
            None => return Ok(None),
        };

        if language::sysml_keywords().contains(&word.as_str()) {
            return Ok(None);
        }

        let doc = match kerml_parser::parse_sysml(&text) {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };
        let defs = collect_definition_ranges(&doc);
        if let Some((_, range)) = defs.into_iter().find(|(name, _)| name == &word) {
            return Ok(Some(GotoDefinitionResponse::Scalar(Location { uri, range })));
        }
        Ok(None)
    }

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let uri = params.text_document_position.text_document.uri.clone();
        let pos = params.text_document_position.position;
        let include_declaration = params.context.include_declaration;
        let state = self.state.read().await;
        let text = match state.documents.get(&uri) {
            Some(t) => t.clone(),
            None => return Ok(None),
        };
        drop(state);

        let (_, _, _, word) = match word_at_position(&text, pos.line, pos.character) {
            Some(t) => t,
            None => return Ok(None),
        };

        let def_range = kerml_parser::parse_sysml(&text)
            .ok()
            .and_then(|doc| {
                collect_definition_ranges(&doc)
                    .into_iter()
                    .find(|(name, _)| name == &word)
                    .map(|(_, r)| r)
            });

        let mut locations: Vec<Location> = find_reference_ranges(&text, &word)
            .into_iter()
            .map(|range| Location {
                uri: uri.clone(),
                range,
            })
            .collect();

        if !include_declaration {
            if let Some(def_range) = def_range {
                locations.retain(|loc| loc.range != def_range);
            }
        }

        Ok(Some(locations))
    }

    async fn document_symbol(
        &self,
        params: DocumentSymbolParams,
    ) -> Result<Option<DocumentSymbolResponse>> {
        let uri = params.text_document.uri;
        let state = self.state.read().await;
        let text = match state.documents.get(&uri) {
            Some(t) => t.clone(),
            None => return Ok(None),
        };
        drop(state);

        let doc = match kerml_parser::parse_sysml(&text) {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };
        let symbols = collect_document_symbols(&doc);
        Ok(Some(DocumentSymbolResponse::Nested(symbols)))
    }

    async fn code_action(
        &self,
        params: CodeActionParams,
    ) -> Result<Option<CodeActionResponse>> {
        let uri = params.text_document.uri.clone();
        let state = self.state.read().await;
        let text = match state.documents.get(&uri) {
            Some(t) => t.clone(),
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
        let text = match state.documents.get(&uri) {
            Some(t) => t.clone(),
            None => return Ok(None),
        };
        drop(state);
        Ok(Some(format_document(&text, &params.options)))
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
                diagnostics.push(Diagnostic {
                    range: Range {
                        start: Position::new(0, 0),
                        end: Position::new(0, 0),
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
