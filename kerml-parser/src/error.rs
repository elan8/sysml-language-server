//! Error types for the parser

use thiserror::Error;

/// Result type alias for parser operations
pub type Result<T> = std::result::Result<T, ParseError>;

/// Parser error types
#[derive(Debug, Error)]
pub enum ParseError {
    /// Pest parsing error
    #[error("Parse error: {0}")]
    PestError(String),

    /// General parse / semantic error message
    #[error("Parse error: {0}")]
    Message(String),

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

























