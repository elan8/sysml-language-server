//! Semantic tokenization for SysML: classifies tokens so the editor can apply
//! semantic highlighting (keyword, string, number, comment, operator, variable, type, namespace,
//! class, interface, property, function).
//!
//! We use the AST when available: the parser provides (SourceRange, SemanticRole) for definition
//! names, type references, etc., and we override the lexer’s token types for those spans. This
//! matches how other language servers (C#, TypeScript, Rust) drive semantic highlighting from
//! the AST. When the parse fails, we fall back to lexer-only heuristics (e.g. identifier after
//! `:` → type, identifier after `package` → namespace).

use kerml_parser::ast::{SemanticRole, SourceRange};
use tower_lsp::lsp_types::{
    SemanticToken, SemanticTokenType, SemanticTokens, SemanticTokensLegend,
};

/// Legend: token types we emit (indices 0..=11). Order must match the TYPE_* constants below.
pub fn legend() -> SemanticTokensLegend {
    SemanticTokensLegend {
        token_types: vec![
            SemanticTokenType::KEYWORD,
            SemanticTokenType::STRING,
            SemanticTokenType::NUMBER,
            SemanticTokenType::COMMENT,
            SemanticTokenType::OPERATOR,
            SemanticTokenType::VARIABLE,
            SemanticTokenType::TYPE,
            SemanticTokenType::NAMESPACE,
            SemanticTokenType::CLASS,
            SemanticTokenType::INTERFACE,
            SemanticTokenType::PROPERTY,
            SemanticTokenType::FUNCTION,
        ],
        token_modifiers: vec![],
    }
}

const TYPE_KEYWORD: u32 = 0;
const TYPE_STRING: u32 = 1;
const TYPE_NUMBER: u32 = 2;
const TYPE_COMMENT: u32 = 3;
const TYPE_OPERATOR: u32 = 4;
const TYPE_VARIABLE: u32 = 5;
const TYPE_TYPE: u32 = 6;
const TYPE_NAMESPACE: u32 = 7;
const TYPE_CLASS: u32 = 8;
const TYPE_INTERFACE: u32 = 9;
const TYPE_PROPERTY: u32 = 10;
const TYPE_FUNCTION: u32 = 11;

/// Map parser SemanticRole to legend index for use with apply_ast_semantic_ranges.
pub fn semantic_role_to_type_index(role: SemanticRole) -> u32 {
    match role {
        SemanticRole::Type => TYPE_TYPE,
        SemanticRole::Namespace => TYPE_NAMESPACE,
        SemanticRole::Class => TYPE_CLASS,
        SemanticRole::Interface => TYPE_INTERFACE,
        SemanticRole::Property => TYPE_PROPERTY,
        SemanticRole::Function => TYPE_FUNCTION,
    }
}

/// Build (SourceRange, token_type_index) from AST for semantic_tokens_full/range.
pub fn ast_semantic_ranges(doc: &kerml_parser::ast::SysMLDocument) -> Vec<(SourceRange, u32)> {
    kerml_parser::collect_semantic_ranges(doc)
        .into_iter()
        .map(|(r, role)| (r, semantic_role_to_type_index(role)))
        .collect()
}

fn is_keyword(w: &str) -> bool {
    crate::language::is_reserved_keyword(w)
}

/// Token: (line, start_char, length, type_index).
/// Returns (tokens, still_inside_block_comment).
fn tokenize_line(line: &str, line_index: u32, in_block_comment: bool) -> (Vec<(u32, u32, u32, u32)>, bool) {
    let mut tokens = Vec::new();
    let mut i = 0;
    let chars: Vec<char> = line.chars().collect();
    let n = chars.len();
    let mut still_in_block_comment = in_block_comment;
    let mut already_continued_block = false;
    let mut last_was_colon = false;
    let mut expect_package_name = false;

    while i < n {
        // If we're inside a block comment (from a previous line), look for */ or treat rest of line as comment (once per line)
        if !already_continued_block && (in_block_comment || still_in_block_comment) {
            already_continued_block = true;
            let start = i;
            while i + 1 < n {
                if chars[i] == '*' && chars[i + 1] == '/' {
                    i += 2;
                    still_in_block_comment = false;
                    tokens.push((line_index, start as u32, (i - start) as u32, TYPE_COMMENT));
                    break;
                }
                i += 1;
            }
            if still_in_block_comment {
                tokens.push((line_index, start as u32, (n - start) as u32, TYPE_COMMENT));
                i = n;
            }
            continue;
        }

        // Skip whitespace
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }

        // Line comment (not block)
        if i + 1 < n && chars[i] == '/' && chars[i + 1] == '/' && (i + 2 >= n || chars[i + 2] != '*') {
            let start = i;
            while i < n {
                i += 1;
            }
            last_was_colon = false;
            tokens.push((line_index, start as u32, (i - start) as u32, TYPE_COMMENT));
            continue;
        }

        // Block comment /* ... */ or //* ... */
        if chars[i] == '/' && i + 1 < n {
            if chars[i + 1] == '*' {
                let start = i;
                i += 2;
                let mut found_closing = false;
                while i + 1 < n {
                    if chars[i] == '*' && chars[i + 1] == '/' {
                        i += 2;
                        found_closing = true;
                        break;
                    }
                    i += 1;
                }
                if !found_closing {
                    still_in_block_comment = true;
                }
                last_was_colon = false;
                tokens.push((line_index, start as u32, (i - start) as u32, TYPE_COMMENT));
                continue;
            }
            if i + 2 < n && chars[i + 1] == '/' && chars[i + 2] == '*' {
                let start = i;
                i += 3;
                let mut found_closing = false;
                while i + 1 < n {
                    if chars[i] == '*' && chars[i + 1] == '/' {
                        i += 2;
                        found_closing = true;
                        break;
                    }
                    i += 1;
                }
                if !found_closing {
                    still_in_block_comment = true;
                }
                last_was_colon = false;
                tokens.push((line_index, start as u32, (i - start) as u32, TYPE_COMMENT));
                continue;
            }
        }

        // Single-quoted string
        if chars[i] == '\'' {
            let start = i;
            i += 1;
            while i < n && chars[i] != '\'' {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            if i < n {
                i += 1;
            }
            last_was_colon = false;
            tokens.push((line_index, start as u32, (i - start) as u32, TYPE_STRING));
            continue;
        }

        // Double-quoted string
        if chars[i] == '"' {
            let start = i;
            i += 1;
            while i < n && chars[i] != '"' {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            if i < n {
                i += 1;
            }
            last_was_colon = false;
            tokens.push((line_index, start as u32, (i - start) as u32, TYPE_STRING));
            continue;
        }

        // Metadata @name
        if chars[i] == '@' {
            let start = i;
            i += 1;
            while i < n && (chars[i].is_alphanumeric() || chars[i] == '_' || (chars[i] == ':' && i + 1 < n && chars[i + 1] == ':')) {
                if chars[i] == ':' && i + 1 < n && chars[i + 1] == ':' {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            last_was_colon = false;
            tokens.push((line_index, start as u32, (i - start) as u32, TYPE_VARIABLE));
            continue;
        }

        // Operators :> :>> :: .. ->
        if chars[i] == ':' && i + 1 < n && chars[i + 1] == '>' {
            let start = i;
            i += 2;
            if i < n && chars[i] == '>' {
                i += 1; // :>>
            }
            last_was_colon = false;
            tokens.push((line_index, start as u32, (i - start) as u32, TYPE_OPERATOR));
            continue;
        }
        if chars[i] == ':' && i + 1 < n && chars[i + 1] == ':' {
            last_was_colon = false;
            tokens.push((line_index, i as u32, 2, TYPE_OPERATOR));
            i += 2;
            continue;
        }
        if chars[i] == '.' && i + 1 < n && chars[i + 1] == '.' {
            last_was_colon = false;
            tokens.push((line_index, i as u32, 2, TYPE_OPERATOR));
            i += 2;
            continue;
        }
        if chars[i] == '-' && i + 1 < n && chars[i + 1] == '>' {
            last_was_colon = false;
            tokens.push((line_index, i as u32, 2, TYPE_OPERATOR));
            i += 2;
            continue;
        }

        // Numbers: integer or float
        if chars[i].is_ascii_digit() || (chars[i] == '-' && i + 1 < n && chars[i + 1].is_ascii_digit()) {
            let start = i;
            if chars[i] == '-' {
                i += 1;
            }
            while i < n && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < n && chars[i] == '.' && i + 1 < n && chars[i + 1].is_ascii_digit() {
                i += 1;
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < n && (chars[i] == 'e' || chars[i] == 'E') {
                i += 1;
                if i < n && (chars[i] == '+' || chars[i] == '-') {
                    i += 1;
                }
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            last_was_colon = false;
            tokens.push((line_index, start as u32, (i - start) as u32, TYPE_NUMBER));
            continue;
        }

        // Identifier or keyword: letters/numbers/underscore/hyphen (word boundary)
        if chars[i].is_alphabetic() || chars[i] == '_' {
            let start = i;
            while i < n && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '-') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let len = (i - start) as u32;
            let token_type = if is_keyword(&word) {
                last_was_colon = false;
                if word == "package" {
                    expect_package_name = true;
                }
                TYPE_KEYWORD
            } else if expect_package_name {
                expect_package_name = false;
                TYPE_NAMESPACE
            } else if last_was_colon {
                last_was_colon = false;
                TYPE_TYPE
            } else {
                TYPE_VARIABLE
            };
            tokens.push((line_index, start as u32, len, token_type));
            continue;
        }

        // Single-char operator or other: skip one char so we don't loop forever
        if chars[i] == ';' || chars[i] == ',' || chars[i] == '(' || chars[i] == ')' || chars[i] == '{' || chars[i] == '}' || chars[i] == '[' || chars[i] == ']' || chars[i] == '=' || chars[i] == '.' || chars[i] == ':' || chars[i] == '>' || chars[i] == '-' {
            let start = i;
            last_was_colon = chars[i] == ':';
            i += 1;
            tokens.push((line_index, start as u32, (i - start) as u32, TYPE_OPERATOR));
            continue;
        }

        i += 1;
    }

    (tokens, still_in_block_comment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_utf16_conversion_ascii() {
        // ASCII: char count = UTF-16 count
        let lines = &["\tin panAngle : Real;"];
        let (start, len) = to_utf16_units(lines, 0, 4, 8);
        assert_eq!((start, len), (4, 8), "panAngle at char 4, len 8");
    }

    #[test]
    fn test_utf16_conversion_non_bmp() {
        // Non-BMP: 1 char = 2 UTF-16 units (e.g. emoji U+1F44D)
        let lines = &["in pan\u{1F44D}gle : Real;"];
        let (start, len) = to_utf16_units(lines, 0, 4, 7); // "pan👋gle" = 7 chars
        assert_eq!((start, len), (4, 8), "pan👋gle: p at 4, 7 chars = 8 UTF-16 (👋=2)");
    }

    #[test]
    fn test_position_is_not_a_keyword() {
        // Regression: "position" is a common attribute name (e.g. telemetry),
        // and is not a reserved keyword in SysML v2. It should not be colored as keyword
        // in the lexer-only fallback.
        let line = "\tout position : String;";
        let (tokens, _still_in_comment) = tokenize_line(line, 0, false);

        let mut saw_position = false;
        for (ln, start, len, ty) in tokens {
            assert_eq!(ln, 0);
            if &line[start as usize..(start + len) as usize] == "position" {
                saw_position = true;
                assert_eq!(ty, TYPE_VARIABLE);
            }
        }
        assert!(saw_position, "expected to tokenize 'position'");
    }
}

const TYPE_NAMES: [&str; 12] = [
    "KEYWORD", "STRING", "NUMBER", "COMMENT", "OPERATOR", "VARIABLE",
    "TYPE", "NAMESPACE", "CLASS", "INTERFACE", "PROPERTY", "FUNCTION",
];

/// Returns the AST semantic type for a token span if it is entirely inside one of the given ranges.
/// When multiple ranges match (e.g. a bogus large TYPE range and a correct PROPERTY range),
/// returns the one with the smallest span (most specific). Also returns that span's length
/// so the caller can skip overriding when the range is much larger than the token (parser span bug).
fn token_ast_type(
    line: u32,
    start_char: u32,
    length: u32,
    ast_ranges: &[(SourceRange, u32)],
) -> Option<(u32, usize, u32)> {
    let end_char = start_char + length;
    let mut best: Option<(u32, usize, u32)> = None; // (token_type, index, span_length)
    for (i, (r, token_type)) in ast_ranges.iter().enumerate() {
        if line >= r.start_line && line <= r.end_line {
            let range_start = if line == r.start_line {
                r.start_character
            } else {
                0
            };
            let range_end = if line == r.end_line {
                r.end_character
            } else {
                u32::MAX
            };
            if start_char >= range_start && end_char <= range_end {
                let span_len = range_end.saturating_sub(range_start);
                let replace = best.map_or(true, |(_, _, len)| span_len < len);
                if replace {
                    best = Some((*token_type, i, span_len));
                }
            }
        }
    }
    best
}

/// Override token types using AST-derived (range, type) pairs. VARIABLE, NAMESPACE, and KEYWORD
/// tokens are overridden when the AST has a role for that span (e.g. Property, Class).
/// When log_out is Some, appends debug lines (AST ranges and each override) for LSP log_message.
fn apply_ast_semantic_ranges(
    tokens: &mut [(u32, u32, u32, u32)],
    ast_ranges: &[(SourceRange, u32)],
    lines: &[&str],
    mut log_out: Option<&mut Vec<String>>,
) {
    if let Some(log) = log_out.as_mut() {
        if !ast_ranges.is_empty() {
            log.push(format!(
                "[SYSML semantic tokens] AST ranges ({} total, first 20):",
                ast_ranges.len()
            ));
            for (i, (r, ty)) in ast_ranges.iter().enumerate().take(20) {
                let text: String = lines
                    .get(r.start_line as usize)
                    .map(|l| {
                        l.chars()
                            .skip(r.start_character as usize)
                            .take((r.end_character.saturating_sub(r.start_character)) as usize)
                            .collect::<String>()
                    })
                    .unwrap_or_default()
                    .replace('\n', "\\n");
                log.push(format!(
                    "  #{} {}:{}..{} {} \"{}\"",
                    i,
                    r.start_line,
                    r.start_character,
                    r.end_character,
                    TYPE_NAMES[*ty as usize],
                    text
                ));
            }
            if ast_ranges.len() > 20 {
                log.push(format!("  ... and {} more", ast_ranges.len() - 20));
            }
        }
    }
    for (line, start, len, type_idx) in tokens.iter_mut() {
        // Override lexer type when AST has a more specific role. Include TYPE so that property
        // names wrongly lexed as type (e.g. "current" / "velocity" after "out name :") get PROPERTY.
        let can_override = *type_idx == TYPE_VARIABLE
            || *type_idx == TYPE_NAMESPACE
            || *type_idx == TYPE_KEYWORD
            || *type_idx == TYPE_TYPE;
        if can_override {
            if let Some((ast_type, range_idx, span_len)) =
                token_ast_type(*line, *start, *len, ast_ranges)
            {
                // Skip override when the matching range is much larger than the token (parser
                // sometimes attaches a parent span to type_ref, so we'd wrongly override "in"/name).
                if span_len > 2 * *len {
                    continue;
                }
                if let Some(log) = log_out.as_mut() {
                    let token_text: String = lines
                        .get(*line as usize)
                        .map(|l| {
                            l.chars()
                                .skip(*start as usize)
                                .take(*len as usize)
                                .collect::<String>()
                        })
                        .unwrap_or_default();
                    let (r, _) = &ast_ranges[range_idx];
                    log.push(format!(
                        "[SYSML semantic tokens] OVERRIDE token \"{}\" at {}:{} len {}: {} -> {} (matched AST range #{}: {}:{}..{} {})",
                        token_text.replace('\n', "\\n"),
                        line,
                        start,
                        len,
                        TYPE_NAMES[*type_idx as usize],
                        TYPE_NAMES[ast_type as usize],
                        range_idx,
                        r.start_line,
                        r.start_character,
                        r.end_character,
                        TYPE_NAMES[ast_type as usize]
                    ));
                }
                *type_idx = ast_type;
            }
        }
    }
}

/// Convert character indices to UTF-16 code units (LSP spec requires UTF-16).
/// For ASCII/BMP, char count equals UTF-16; for non-BMP (e.g. emoji), 1 char = 2 UTF-16 units.
fn to_utf16_units(lines: &[&str], line: u32, start_char: u32, length: u32) -> (u32, u32) {
    let line_str = lines.get(line as usize).unwrap_or(&"");
    let mut start_utf16 = 0u32;
    let mut len_utf16 = 0u32;
    for (i, c) in line_str.chars().enumerate() {
        let u16 = c.len_utf16() as u32;
        if i < start_char as usize {
            start_utf16 += u16;
        } else if i < (start_char + length) as usize {
            len_utf16 += u16;
        } else {
            break;
        }
    }
    (start_utf16, len_utf16)
}

/// Encode tokens into LSP semantic tokens (delta encoding).
/// Positions are converted to UTF-16 code units per LSP spec.
fn encode(tokens: &[(u32, u32, u32, u32)], lines: &[&str]) -> Vec<SemanticToken> {
    let mut data = Vec::with_capacity(tokens.len());
    let mut prev_line = 0u32;
    let mut prev_start_utf16 = 0u32;

    for &(line, start_char, length, token_type) in tokens {
        let (start_utf16, len_utf16) = to_utf16_units(lines, line, start_char, length);
        let delta_line = line - prev_line;
        let delta_start = if line == prev_line {
            start_utf16.saturating_sub(prev_start_utf16)
        } else {
            start_utf16
        };
        data.push(SemanticToken {
            delta_line,
            delta_start,
            length: len_utf16,
            token_type,
            token_modifiers_bitset: 0,
        });
        prev_line = line;
        prev_start_utf16 = start_utf16;
    }

    data
}

/// Produce semantic tokens for the full document.
/// When `ast_ranges` is Some (from a successful parse), those (range, token_type) pairs
/// override variable/namespace tokens for AST-driven highlighting; otherwise the lexer uses heuristics.
/// Returns (tokens, debug_log_lines). When ast_ranges is Some, debug_log_lines contains AST range and override details for LSP logging.
pub fn semantic_tokens_full(
    text: &str,
    ast_ranges: Option<&[(SourceRange, u32)]>,
) -> (SemanticTokens, Vec<String>) {
    let lines: Vec<&str> = text.lines().collect();
    let mut all_tokens = Vec::new();
    let mut in_block_comment = false;
    for (line_index, line) in lines.iter().enumerate() {
        let (line_tokens, still_in) = tokenize_line(line, line_index as u32, in_block_comment);
        in_block_comment = still_in;
        all_tokens.extend(line_tokens);
    }
    let mut log_lines = Vec::new();
    if let Some(ranges) = ast_ranges {
        apply_ast_semantic_ranges(&mut all_tokens, ranges, &lines, Some(&mut log_lines));
    }
    let tokens = SemanticTokens {
        result_id: None,
        data: encode(&all_tokens, &lines),
    };
    (tokens, log_lines)
}

/// Compute whether we're inside a block comment at the end of the given line index (0 = after first line).
fn block_comment_state_after_line(lines: &[&str], through_line: u32) -> bool {
    let mut in_block = false;
    for (line_index, line) in lines.iter().take(through_line as usize + 1).enumerate() {
        let (_, still_in) = tokenize_line(line, line_index as u32, in_block);
        in_block = still_in;
    }
    in_block
}

/// Produce semantic tokens for a range (for textDocument/semanticTokens/range).
/// Only tokens that overlap the given range are included.
/// When `ast_ranges` is Some, those (range, type) pairs override variable/namespace tokens.
/// Returns (tokens, debug_log_lines) like semantic_tokens_full.
pub fn semantic_tokens_range(
    text: &str,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    ast_ranges: Option<&[(SourceRange, u32)]>,
) -> (SemanticTokens, Vec<String>) {
    let mut all_tokens = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let max_line = lines.len().saturating_sub(1) as u32;
    let line_end = end_line.min(max_line);

    let mut in_block_comment = if start_line > 0 {
        block_comment_state_after_line(&lines, start_line - 1)
    } else {
        false
    };

    for line_index in start_line..=line_end {
        let line = lines.get(line_index as usize).unwrap_or(&"");
        let (line_tokens, still_in) = tokenize_line(line, line_index, in_block_comment);
        in_block_comment = still_in;

        for (ln, start_char, length, token_type) in line_tokens {
            let token_end_char = start_char + length;
            let range_start_char = if ln == start_line { start_character } else { 0 };
            let range_end_char = if ln == end_line {
                end_character
            } else {
                u32::MAX
            };
            if token_end_char <= range_start_char || start_char >= range_end_char {
                continue;
            }
            all_tokens.push((ln, start_char, length, token_type));
        }
    }

    let mut log_lines = Vec::new();
    if let Some(ranges) = ast_ranges {
        apply_ast_semantic_ranges(&mut all_tokens, ranges, &lines, Some(&mut log_lines));
    }

    let tokens = SemanticTokens {
        result_id: None,
        data: encode(&all_tokens, &lines),
    };
    (tokens, log_lines)
}
