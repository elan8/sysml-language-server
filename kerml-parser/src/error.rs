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
    
    /// Invalid syntax error
    #[error("Invalid syntax: {0}")]
    InvalidSyntax(String),
    
    /// Unexpected token error
    #[error("Unexpected token: {0}")]
    UnexpectedToken(String),
    
    /// General parse error
    #[error("Parse error: {0}")]
    ParseError(String),
    
    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

























