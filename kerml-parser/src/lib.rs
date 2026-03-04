//! SysML v2 (KerML) Parser
//!
//! This crate provides a parser for SysML v2 source text (`.sysml` files)
//! using Pest. It converts SysML v2 text into Rust structs that represent
//! the semantic model.
//!
//! The parser targets the [SysML v2 textual notation](https://www.omg.org/spec/SysML/2.0/Language/)
//! as exemplified by the [SysML v2 Release](https://github.com/Systems-Modeling/SysML-v2-Release)
//! (validation suite and standard library). Full OMG spec compliance is not asserted.

/// Validation suite identifier for compatibility testing (SysML-v2-Release tag or version).
pub const SYSML_V2_VALIDATION_SUITE: &str = "SysML-v2-Release-2026-01";

pub mod parser;
pub mod ast;
pub mod error;

#[cfg(test)]
mod validation_tests;

pub use parser::parse_sysml;
pub use error::{ParseError, Result};

