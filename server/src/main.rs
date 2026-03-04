//! SysML v2 language server (LSP over stdio).

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
