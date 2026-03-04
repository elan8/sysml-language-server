//! Span and source-position utilities for the parser.
//! Converts Pest byte-offset spans to line/character for LSP and diagnostics.

use crate::ast::{SourcePosition, SourceRange};

/// Convert a Pest span to SourcePosition
/// The span contains byte offsets, we need to convert to line/character
pub(super) fn span_to_position(span: pest::Span<'_>, source: &str) -> SourcePosition {
    let start = span.start();
    let end = span.end();

    // Calculate line and character from byte offset
    let mut line = 0u32;
    let mut character = 0u32;
    let mut current_pos = 0usize;

    for (line_num, line_str) in source.lines().enumerate() {
        let line_len = line_str.len() + 1; // +1 for newline

        if current_pos + line_len > start {
            // The position is on this line
            line = line_num as u32;
            character = (start - current_pos) as u32;
            break;
        }

        current_pos += line_len;
    }

    let length = (end - start) as u32;

    SourcePosition {
        line,
        character,
        length,
    }
}

/// Convert a byte offset in source to (line, character). 0-based.
pub(super) fn byte_offset_to_line_char(source: &str, byte_offset: usize) -> (u32, u32) {
    let mut current_pos = 0usize;
    for (line_num, line_str) in source.lines().enumerate() {
        let line_len = line_str.len() + 1;
        if current_pos + line_len > byte_offset {
            return (line_num as u32, (byte_offset - current_pos) as u32);
        }
        current_pos += line_len;
    }
    let line_count = source.lines().count().max(1);
    let last_line_len = source.lines().last().map(|s| s.len()).unwrap_or(0);
    ((line_count - 1) as u32, last_line_len as u32)
}

/// Convert a Pest span to SourceRange (start and end line/character).
pub(super) fn span_to_source_range(span: pest::Span<'_>, source: &str) -> SourceRange {
    let (start_line, start_character) = byte_offset_to_line_char(source, span.start());
    let (end_line, end_character) = byte_offset_to_line_char(source, span.end());
    SourceRange {
        start_line,
        start_character,
        end_line,
        end_character,
    }
}
