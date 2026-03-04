//! SysML v2 (KerML) Parser
//!
//! This crate provides a parser for SysML v2 source text (`.sysml` files)
//! using Pest. It converts SysML v2 text into Rust structs that represent
//! the semantic model.

pub mod parser;
pub mod ast;
pub mod error;

#[cfg(test)]
mod validation_tests;

pub use parser::parse_sysml;
pub use error::{ParseError, Result};

