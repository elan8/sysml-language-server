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

/// Return (start_byte, end_byte) for the line at 0-based line index (end = before newline).
pub(crate) fn line_byte_range(source: &str, line: u32) -> Option<(usize, usize)> {
    let mut current = 0usize;
    for (i, line_str) in source.lines().enumerate() {
        if i as u32 == line {
            let end = current + line_str.len();
            return Some((current, end));
        }
        current += line_str.len() + 1;
    }
    None
}

/// Convert byte offset within a line to UTF-16 code unit offset (LSP spec).
fn byte_offset_to_utf16_in_line(line: &str, byte_offset: usize) -> u32 {
    let mut utf16_pos = 0u32;
    let mut byte_pos = 0usize;
    for c in line.chars() {
        if byte_pos + c.len_utf8() > byte_offset {
            break;
        }
        byte_pos += c.len_utf8();
        utf16_pos += c.len_utf16() as u32;
    }
    utf16_pos
}

/// Convert a byte offset in source to (line, character). 0-based.
/// Character offset is in UTF-16 code units per LSP spec.
pub(super) fn byte_offset_to_line_char(source: &str, byte_offset: usize) -> (u32, u32) {
    let mut current_pos = 0usize;
    for (line_num, line_str) in source.lines().enumerate() {
        let line_len = line_str.len() + 1;
        if current_pos + line_len > byte_offset {
            let byte_in_line = byte_offset - current_pos;
            let char_offset =
                byte_offset_to_utf16_in_line(line_str, byte_in_line.min(line_str.len()));
            return (line_num as u32, char_offset);
        }
        current_pos += line_len;
    }
    let line_count = source.lines().count().max(1);
    let lines: Vec<&str> = source.lines().collect();
    let last_line = lines.last().unwrap_or(&"");
    let last_char = byte_offset_to_utf16_in_line(last_line, last_line.len());
    ((line_count - 1) as u32, last_char)
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
