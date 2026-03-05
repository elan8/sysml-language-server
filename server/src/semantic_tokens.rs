//! Semantic tokenization for SysML: classifies tokens so the editor can apply
//! semantic highlighting (keyword, string, number, comment, operator, variable, type).
//!
//! When the parser has successfully built an AST, we use it to refine type references
//! (parser knows exactly which identifiers are types); otherwise we use heuristics (e.g. after `:`).

use kerml_parser::ast::SourceRange;
use tower_lsp::lsp_types::{
    SemanticToken, SemanticTokenType, SemanticTokens, SemanticTokensLegend,
};

/// Legend: token types we emit (indices 0..=6).
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

static KEYWORDS: &[&str] = &[
    "package", "library", "import", "part", "def", "attribute", "port", "connection",
    "interface", "item", "value", "action", "requirement", "ref", "alias", "view",
    "metadata", "filter", "connector", "bind", "allocate", "connect", "variant",
    "abstract", "occurrence", "calc", "constraint", "exhibit", "transition", "accept",
    "entry", "exit", "do", "then", "first", "if", "send", "new", "to", "for", "perform",
    "assert", "assume", "require", "doc", "standard", "expose", "verify", "position",
    "satisfy", "return", "in", "out", "provides", "requires", "nonunique", "ordered",
    "redefines", "subsets", "default", "istype", "at", "when", "render", "pin", "connect",
    "state", "individual", "flow", "succession", "end",
];

static KEYWORDS_OTHER: &[&str] = &["private", "public", "true", "false"];

fn is_keyword(w: &str) -> bool {
    KEYWORDS.contains(&w) || KEYWORDS_OTHER.contains(&w)
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
                TYPE_KEYWORD
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

/// Returns true if the token span is entirely inside one of the type ref ranges.
fn token_in_type_ref_range(
    line: u32,
    start_char: u32,
    length: u32,
    type_ref_ranges: &[SourceRange],
) -> bool {
    let end_char = start_char + length;
    for r in type_ref_ranges {
        if line >= r.start_line && line <= r.end_line {
            let range_start = if line == r.start_line { r.start_character } else { 0 };
            let range_end = if line == r.end_line {
                r.end_character
            } else {
                u32::MAX
            };
            if start_char >= range_start && end_char <= range_end {
                return true;
            }
        }
    }
    false
}

/// Refine variable tokens to type when they fall inside parser-known type ref ranges.
fn apply_type_ref_ranges(
    tokens: &mut [(u32, u32, u32, u32)],
    type_ref_ranges: &[SourceRange],
) {
    for (line, start, len, type_idx) in tokens.iter_mut() {
        if *type_idx == TYPE_VARIABLE && token_in_type_ref_range(*line, *start, *len, type_ref_ranges) {
            *type_idx = TYPE_TYPE;
        }
    }
}

/// Encode tokens into LSP semantic tokens (delta encoding).
fn encode(tokens: &[(u32, u32, u32, u32)]) -> Vec<SemanticToken> {
    let mut data = Vec::with_capacity(tokens.len());
    let mut prev_line = 0u32;
    let mut prev_start = 0u32;

    for &(line, start_char, length, token_type) in tokens {
        let delta_line = line - prev_line;
        let delta_start = if line == prev_line {
            start_char - prev_start
        } else {
            start_char
        };
        data.push(SemanticToken {
            delta_line,
            delta_start,
            length,
            token_type,
            token_modifiers_bitset: 0,
        });
        prev_line = line;
        prev_start = start_char;
    }

    data
}

/// Produce semantic tokens for the full document.
/// When `type_ref_ranges` is Some (from a successful parse), those ranges classify
/// identifiers as type; otherwise the lexer uses heuristics (e.g. identifier after `:`).
pub fn semantic_tokens_full(
    text: &str,
    type_ref_ranges: Option<&[SourceRange]>,
) -> SemanticTokens {
    let mut all_tokens = Vec::new();
    let mut in_block_comment = false;
    for (line_index, line) in text.lines().enumerate() {
        let (line_tokens, still_in) = tokenize_line(line, line_index as u32, in_block_comment);
        in_block_comment = still_in;
        all_tokens.extend(line_tokens);
    }
    if let Some(ranges) = type_ref_ranges {
        apply_type_ref_ranges(&mut all_tokens, ranges);
    }
    SemanticTokens {
        result_id: None,
        data: encode(&all_tokens),
    }
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
/// When `type_ref_ranges` is Some, those ranges refine variable -> type.
pub fn semantic_tokens_range(
    text: &str,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    type_ref_ranges: Option<&[SourceRange]>,
) -> SemanticTokens {
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

    if let Some(ranges) = type_ref_ranges {
        apply_type_ref_ranges(&mut all_tokens, ranges);
    }

    SemanticTokens {
        result_id: None,
        data: encode(&all_tokens),
    }
}
