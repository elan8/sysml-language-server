//! Error types for the parser

use thiserror::Error;

/// Result type alias for parser operations
pub type Result<T> = std::result::Result<T, ParseError>;

/// Parser error types
#[derive(Debug, Error)]
pub enum ParseError {
    /// Pest parsing error (message, optional (line_0based, character_0based) for LSP)
    #[error("Parse error: {0}")]
    PestError(String, Option<(u32, u32)>),

    /// General parse / semantic error message
    #[error("Parse error: {0}")]
    Message(String),

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl ParseError {
    /// Returns (line, character) in 0-based LSP form if available.
    pub fn position(&self) -> Option<(u32, u32)> {
        match self {
            ParseError::PestError(_, pos) => *pos,
            _ => None,
        }
    }
}

























