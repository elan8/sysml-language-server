//! Helpers for hover and completion: position/word resolution, keywords, and AST name collection.
//! Also provides definition/reference ranges for Go to definition and Find references.
#![allow(deprecated)] // LSP deprecated field in DocumentSymbol/SymbolInformation; use tags in future

use kerml_parser::ast::{Member, Multiplicity, SourcePosition, SourceRange, SysMLDocument};
use tower_lsp::lsp_types::{
    CodeAction, DocumentSymbol, FormattingOptions, Location, OneOf,
    OptionalVersionedTextDocumentIdentifier, Position, Range, SymbolInformation, SymbolKind,
    TextDocumentEdit, TextEdit, Url, WorkspaceEdit,
};

/// Converts (line, character) to byte offset in `text`. LSP uses 0-based line and character.
#[allow(dead_code)] // used by tests and for future LSP features (e.g. range resolution)
pub fn position_to_byte_offset(text: &str, line: u32, character: u32) -> Option<usize> {
    let lines: Vec<&str> = text.split('\n').collect();
    let line_usize = line as usize;
    if line_usize >= lines.len() {
        return None;
    }
    let mut offset = 0usize;
    for (i, ln) in lines.iter().enumerate() {
        if i == line_usize {
            let char_off = character as usize;
            if char_off > ln.len() {
                return None;
            }
            return Some(offset + char_off);
        }
        offset += ln.len() + 1; // +1 for newline
    }
    None
}

/// Returns the LSP (line, start_char, end_char) and the word at the given position.
/// A word is a contiguous run of identifier characters (alphanumeric, underscore, or `:` for qualified names).
pub fn word_at_position(
    text: &str,
    line: u32,
    character: u32,
) -> Option<(u32, u32, u32, String)> {
    fn is_ident_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_' || c == ':' || c == '>'
    }
    let line_str = text.lines().nth(line as usize)?;
    let char_in_line = character as usize;
    let line_chars: Vec<char> = line_str.chars().collect();
    if line_chars.is_empty() || char_in_line > line_chars.len() {
        return None;
    }
    let mut start = char_in_line;
    while start > 0 && is_ident_char(line_chars[start - 1]) {
        start -= 1;
    }
    let mut end = char_in_line;
    while end < line_chars.len() && is_ident_char(line_chars[end]) {
        end += 1;
    }
    if start >= end {
        return None;
    }
    let word: String = line_chars[start..end].iter().collect();
    Some((line, start as u32, end as u32, word))
}

/// Returns the text of the line up to (but not including) the given (line, character).
pub fn line_prefix_at_position(text: &str, line: u32, character: u32) -> String {
    let line_str = match text.lines().nth(line as usize) {
        Some(l) => l,
        None => return String::new(),
    };
    line_str
        .chars()
        .take(character as usize)
        .collect()
}

/// Returns the last token (identifier or keyword prefix) before the cursor for completion.
pub fn completion_prefix(line_prefix: &str) -> &str {
    let trimmed = line_prefix.trim_end();
    let end = trimmed.len();
    if end == 0 {
        return trimmed;
    }
    let mut start = end;
    while start > 0 {
        let c = trimmed[start - 1..].chars().next().unwrap();
        if !c.is_alphanumeric() && c != '_' && c != ':' && c != '>' {
            break;
        }
        start -= 1;
    }
    trimmed.get(start..end).unwrap_or("")
}

/// SysML/KerML keywords used for hover docs and completion.
pub fn sysml_keywords() -> &'static [&'static str] {
    &[
        "package", "library", "part", "attribute", "port", "connection", "interface", "item",
        "value", "action", "requirement", "ref", "in", "out", "provides", "requires", "bind",
        "allocate", "abstract", "def", "variant", "references", "private", "public",
        "entry", "exit", "state", "do", "then", "transition", "constraint", "exhibit",
    ]
}

/// Short documentation for a keyword. Returns None if unknown.
pub fn keyword_doc(keyword: &str) -> Option<&'static str> {
    let doc = match keyword {
        "package" => "Package: namespace for members (parts, actions, etc.).",
        "part" => "Part: structural element; can be definition (part def) or usage.",
        "attribute" => "Attribute: property with optional type and default.",
        "port" => "Port: interaction point (e.g. for connections).",
        "connection" => "Connection: links between ports.",
        "interface" => "Interface: contract for ports.",
        "action" => "Action: behavior definition or usage.",
        "requirement" => "Requirement: requirement definition or usage.",
        "ref" => "Ref: reference to an element (e.g. ref action, ref individual).",
        "in" | "out" => "In/out: input or output (e.g. in action, in attribute).",
        "provides" => "Provides: part provides a capability (e.g. Execution = MCU).",
        "requires" => "Requires: part requires a capability.",
        "bind" => "Bind: bind logical port to physical port.",
        "allocate" => "Allocate: allocate logical to physical (e.g. allocate x to y).",
        "abstract" => "Abstract: abstract part or element.",
        "def" => "Def: definition (e.g. part def, attribute def).",
        "variant" => "Variant: variant part.",
        "library" => "Library: library package.",
        "value" => "Value: value definition or usage.",
        "item" => "Item: item definition or usage.",
        "references" => "References: requirement references.",
        "private" | "public" => "Visibility: private or public.",
        "entry" => "Entry: entry action or behavior when entering a state.",
        "exit" => "Exit: exit action or behavior when leaving a state.",
        "state" => "State: state definition or usage in a state machine.",
        "do" => "Do: activity performed while in a state.",
        "then" => "Then: target state or action in a transition.",
        "transition" => "Transition: transition between states.",
        "constraint" => "Constraint: invariant or constraint block.",
        "exhibit" => "Exhibit: exhibit state machine (e.g. exhibit state name { }).",
        _ => return None,
    };
    Some(doc)
}

/// Returns Markdown string for keyword hover (bold keyword, description, optional syntax hint). None if unknown.
pub fn keyword_hover_markdown(keyword: &str) -> Option<String> {
    let (desc, syntax): (&str, Option<&str>) = match keyword {
        "package" => ("Namespace for members (parts, actions, etc.).", Some("`package name { }`")),
        "part" => ("Structural element; can be definition (part def) or usage.", Some("`part def Name : Type;` or `part name : Type;`")),
        "attribute" => ("Property with optional type and default.", Some("`attribute def name : Type;`")),
        "port" => ("Interaction point (e.g. for connections).", Some("`port def name : Interface;`")),
        "connection" => ("Links between ports.", Some("`connection name (a, b);`")),
        "interface" => ("Contract for ports.", Some("`interface def name { }`")),
        "action" => ("Behavior definition or usage.", Some("`action def name;`")),
        "requirement" => ("Requirement definition or usage.", Some("`requirement def name;`")),
        "ref" => ("Reference to an element (e.g. ref action, ref individual).", Some("`ref name;`")),
        "in" | "out" => ("Input or output (e.g. in action, in attribute).", Some("`in name : Type;`")),
        "provides" => ("Part provides a capability.", Some("`provides name = value;`")),
        "requires" => ("Part requires a capability.", Some("`requires name = value;`")),
        "bind" => ("Bind logical port to physical port.", Some("`bind a to b;`")),
        "allocate" => ("Allocate logical to physical.", Some("`allocate x to y;`")),
        "abstract" => ("Abstract part or element.", Some("`abstract part def Name;`")),
        "def" => ("Definition (e.g. part def, attribute def).", Some("`part def`, `attribute def`, etc.")),
        "variant" => ("Variant part.", None),
        "library" => ("Library package.", Some("`library package name { }`")),
        "value" => ("Value definition or usage.", None),
        "item" => ("Item definition or usage.", None),
        "references" => ("Requirement references.", None),
        "private" | "public" => ("Visibility: private or public.", None),
        "entry" => ("Entry action or behavior when entering a state.", Some("`entry action name;`")),
        "exit" => ("Exit action or behavior when leaving a state.", Some("`exit action name;`")),
        "state" => ("State definition or usage in a state machine.", Some("`state name { }`")),
        "do" => ("Activity performed while in a state.", Some("`do action name;`")),
        "then" => ("Target state or action in a transition.", Some("`transition ev then target;`")),
        "transition" => ("Transition between states.", Some("`transition event then target;`")),
        "constraint" => ("Invariant or constraint block.", None),
        "exhibit" => ("Exhibit state machine.", Some("`exhibit state name { }`")),
        _ => return None,
    };
    let mut md = format!("**{}**\n\n{}", keyword, desc);
    if let Some(syn) = syntax {
        md.push_str(&format!("\n\nSyntax: {}", syn));
    }
    md.push_str("\n\n*See SysML v2 specification for full syntax.*");
    Some(md)
}

/// Converts AST source position (line, character, length) to an LSP Range.
pub fn source_position_to_range(pos: &SourcePosition) -> Range {
    Range::new(
        Position::new(pos.line, pos.character),
        Position::new(pos.line, pos.character + pos.length),
    )
}

/// Converts AST source range (start/end line and character) to an LSP Range.
pub fn source_range_to_range(r: &SourceRange) -> Range {
    Range::new(
        Position::new(r.start_line, r.start_character),
        Position::new(r.end_line, r.end_character),
    )
}

/// Ensures selection_range is contained in full range (LSP requirement).
/// If selection is outside or partially outside full_range, returns a clamped selection or full_range.
fn selection_contained_in(mut selection: Range, full: Range) -> Range {
    fn pos_lt(a: &Position, b: &Position) -> bool {
        a.line < b.line || (a.line == b.line && a.character < b.character)
    }
    fn pos_gt(a: &Position, b: &Position) -> bool {
        a.line > b.line || (a.line == b.line && a.character > b.character)
    }
    if pos_lt(&selection.start, &full.start) {
        selection.start = full.start.clone();
    }
    if pos_gt(&selection.end, &full.end) {
        selection.end = full.end.clone();
    }
    if pos_lt(&selection.end, &selection.start) {
        return full;
    }
    selection
}

/// Collects for each defined name in the document the LSP range of its definition (from AST name_position).
pub fn collect_definition_ranges(doc: &SysMLDocument) -> Vec<(String, Range)> {
    let mut out = Vec::new();
    for pkg in &doc.packages {
        collect_definition_ranges_from_package(pkg, &mut out);
    }
    out
}

fn collect_definition_ranges_from_package(
    pkg: &kerml_parser::ast::Package,
    out: &mut Vec<(String, Range)>,
) {
    if !pkg.name.is_empty() {
        if let Some(ref pos) = pkg.name_position {
            out.push((pkg.name.clone(), source_position_to_range(pos)));
        }
    }
    for m in &pkg.members {
        collect_definition_ranges_from_member(m, out);
    }
}

fn collect_definition_ranges_from_member(member: &Member, out: &mut Vec<(String, Range)>) {
    use kerml_parser::ast::Member as M;
    match member {
        M::PartDef(p) => {
            if let Some(ref pos) = p.name_position {
                out.push((p.name.clone(), source_position_to_range(pos)));
            }
            for m in &p.members {
                collect_definition_ranges_from_member(m, out);
            }
        }
        M::PartUsage(p) => {
            if let (Some(ref name), Some(ref pos)) = (&p.name, &p.name_position) {
                out.push((name.clone(), source_position_to_range(pos)));
            }
            for m in &p.members {
                collect_definition_ranges_from_member(m, out);
            }
        }
        M::AttributeDef(a) => {
            if let Some(ref pos) = a.name_position {
                out.push((a.name.clone(), source_position_to_range(pos)));
            }
        }
        M::AttributeUsage(a) => {
            if let Some(ref pos) = a.name_position {
                out.push((a.name.clone(), source_position_to_range(pos)));
            }
        }
        M::PortDef(p) => {
            if let Some(ref pos) = p.name_position {
                out.push((p.name.clone(), source_position_to_range(pos)));
            }
        }
        M::PortUsage(p) => {
            if let (Some(ref name), Some(ref pos)) = (&p.name, &p.name_position) {
                out.push((name.clone(), source_position_to_range(pos)));
            }
            for m in &p.members {
                collect_definition_ranges_from_member(m, out);
            }
        }
        M::InterfaceDef(i) => {
            if let Some(ref pos) = i.name_position {
                out.push((i.name.clone(), source_position_to_range(pos)));
            }
            for m in &i.members {
                collect_definition_ranges_from_member(m, out);
            }
        }
        M::ConnectionUsage(c) => {
            if let (Some(ref name), Some(ref pos)) = (&c.name, &c.name_position) {
                out.push((name.clone(), source_position_to_range(pos)));
            }
        }
        M::ItemDef(i) => {
            if let Some(ref pos) = i.name_position {
                out.push((i.name.clone(), source_position_to_range(pos)));
            }
        }
        M::ItemUsage(i) => {
            if let Some(ref pos) = i.name_position {
                out.push((i.name.clone(), source_position_to_range(pos)));
            }
        }
        M::RequirementDef(r) => {
            if let Some(ref pos) = r.name_position {
                out.push((r.name.clone(), source_position_to_range(pos)));
            }
            for m in &r.members {
                collect_definition_ranges_from_member(m, out);
            }
        }
        M::RequirementUsage(r) => {
            if let Some(ref pos) = r.name_position {
                out.push((r.name.clone(), source_position_to_range(pos)));
            }
        }
        M::ActionDef(a) => {
            if let Some(ref pos) = a.name_position {
                out.push((a.name.clone(), source_position_to_range(pos)));
            }
        }
        M::Package(p) => collect_definition_ranges_from_package(p, out),
        _ => {}
    }
}

/// Returns all LSP ranges in `source` where `name` appears as a whole word (word boundaries).
pub fn find_reference_ranges(source: &str, name: &str) -> Vec<Range> {
    fn is_ident_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_' || c == '-'
    }
    if name.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    for (line_no, line) in source.lines().enumerate() {
        let line_utf8 = line;
        let mut search_start = 0;
        while let Some(off) = line_utf8[search_start..].find(name) {
            let start = search_start + off;
            let end = start + name.len();
            let before_ok = start == 0
                || !line_utf8[..start]
                    .chars()
                    .next_back()
                    .is_some_and(is_ident_char);
            let after_ok = end >= line_utf8.len()
                || !line_utf8[end..].chars().next().is_some_and(is_ident_char);
            if before_ok && after_ok {
                let start_char = line_utf8[..start].chars().count() as u32;
                let end_char = start_char + name.chars().count() as u32;
                ranges.push(Range::new(
                    Position::new(line_no as u32, start_char),
                    Position::new(line_no as u32, end_char),
                ));
            }
            search_start = end;
        }
    }
    ranges
}

/// Collects document symbols (outline) from the AST. Uses AST `range` when present for full extent, else name range for both.
pub fn collect_document_symbols(doc: &SysMLDocument) -> Vec<DocumentSymbol> {
    let mut out = Vec::new();
    for pkg in &doc.packages {
        if let Some(sym) = document_symbol_from_package(pkg) {
            out.push(sym);
        }
    }
    out
}

/// Flattens document symbols into workspace symbol list with the given file URI.
pub fn document_symbols_to_workspace_symbols(
    uri: &Url,
    symbols: &[DocumentSymbol],
) -> Vec<SymbolInformation> {
    let mut out = Vec::new();
    fn flatten(
        uri: &Url,
        symbols: &[DocumentSymbol],
        container: Option<&str>,
        out: &mut Vec<SymbolInformation>,
    ) {
        for s in symbols {
            out.push(SymbolInformation {
                name: s.name.clone(),
                kind: s.kind,
                tags: s.tags.clone(),
                deprecated: s.deprecated,
                location: Location {
                    uri: uri.clone(),
                    range: s.range,
                },
                container_name: container.map(String::from),
            });
            if let Some(ref children) = s.children {
                flatten(uri, children, Some(&s.name), out);
            }
        }
    }
    flatten(uri, symbols, None, &mut out);
    out
}

/// Formats multiplicity for display (e.g. "[1..*]", "[*]", "[3]").
fn format_multiplicity(m: &Multiplicity) -> String {
    match m {
        Multiplicity::Fixed(n) => format!("[{}]", n),
        Multiplicity::Unbounded => "[*]".to_string(),
        Multiplicity::Range(lo, hi) => format!("[{}..{}]", lo, hi),
    }
}

/// Workspace-wide symbol entry: one definable name with location and semantic info.
#[derive(Debug, Clone)]
pub struct SymbolEntry {
    pub name: String,
    pub uri: Url,
    pub range: Range,
    pub kind: SymbolKind,
    pub container_name: Option<String>,
    pub detail: Option<String>,
    pub description: Option<String>,
    /// One-line signature for hover code block (e.g. "part def Vehicle : Car;").
    pub signature: Option<String>,
}

/// Collects a flat list of symbol entries from a parsed document for the symbol table.
pub fn collect_symbol_entries(doc: &SysMLDocument, uri: &Url) -> Vec<SymbolEntry> {
    let mut out = Vec::new();
    for pkg in &doc.packages {
        symbol_entries_from_package(pkg, uri, None, &mut out);
    }
    out
}

fn symbol_entries_from_package(
    pkg: &kerml_parser::ast::Package,
    uri: &Url,
    container: Option<&str>,
    out: &mut Vec<SymbolEntry>,
) {
    let name = if pkg.name.is_empty() {
        "(top level)"
    } else {
        pkg.name.as_str()
    };
    let selection_range = pkg
        .name_position
        .as_ref()
        .map(source_position_to_range)
        .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
    let range = pkg
        .range
        .as_ref()
        .map(source_range_to_range)
        .unwrap_or(selection_range);
    let description = if pkg.name.is_empty() {
        "Top-level package (namespace).".to_string()
    } else {
        format!("Package (namespace) '{}'. Contains members (parts, actions, etc.).", pkg.name)
    };
    let signature = if pkg.name.is_empty() {
        None
    } else {
        Some(format!("package {} {{ }}", pkg.name))
    };
    out.push(SymbolEntry {
        name: name.to_string(),
        uri: uri.clone(),
        range,
        kind: SymbolKind::MODULE,
        container_name: container.map(String::from),
        detail: Some("package".to_string()),
        description: Some(description),
        signature,
    });
    for m in &pkg.members {
        symbol_entries_from_member(m, uri, Some(name), out);
    }
}

fn symbol_entries_from_member(
    member: &Member,
    uri: &Url,
    container: Option<&str>,
    out: &mut Vec<SymbolEntry>,
) {
    use kerml_parser::ast::Member as M;
    match member {
        M::PartDef(p) => {
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let type_part = p
                .type_ref
                .as_ref()
                .map(|t| format!(" : {}", t))
                .unwrap_or_else(|| {
                    p.specializes
                        .as_ref()
                        .map(|s| format!(" :> {}", s))
                        .unwrap_or_default()
                });
            let mult_str = p
                .multiplicity
                .as_ref()
                .map(format_multiplicity)
                .unwrap_or_default();
            let description = format!("part def '{}'{}{}", p.name, type_part, mult_str);
            let signature = {
                let t = type_part.trim().trim_start_matches(':').trim();
                if t.is_empty() {
                    format!("part def {};", p.name)
                } else {
                    format!("part def {} : {};", p.name, t)
                }
            };
            out.push(SymbolEntry {
                name: p.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::CLASS,
                container_name: container.map(String::from),
                detail: Some("part def".to_string()),
                description: Some(description),
                signature: Some(signature),
            });
            for m in &p.members {
                symbol_entries_from_member(m, uri, Some(&p.name), out);
            }
        }
        M::PartUsage(p) => {
            let name = p.name.as_deref().unwrap_or("(anonymous)");
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            if let Some(ref n) = p.name {
                let type_part = p
                    .type_ref
                    .as_ref()
                    .map(|t| format!(" : {}", t))
                    .unwrap_or_else(|| {
                        p.specializes
                            .as_ref()
                            .map(|s| format!(" :> {}", s))
                            .unwrap_or_default()
                    });
                let mult_str = p
                    .multiplicity
                    .as_ref()
                    .map(format_multiplicity)
                    .unwrap_or_default();
                let description = format!("part usage '{}'{}{}", n, type_part, mult_str);
                let sig_type = type_part.trim().trim_start_matches(':').trim();
                let signature = if sig_type.is_empty() {
                    format!("part {};", n)
                } else {
                    format!("part {} : {};", n, sig_type)
                };
                out.push(SymbolEntry {
                    name: name.to_string(),
                    uri: uri.clone(),
                    range,
                    kind: SymbolKind::VARIABLE,
                    container_name: container.map(String::from),
                    detail: Some("part".to_string()),
                    description: Some(description),
                    signature: Some(signature),
                });
            }
            for m in &p.members {
                symbol_entries_from_member(m, uri, Some(name), out);
            }
        }
        M::AttributeDef(a) => {
            let selection_range = a
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = a
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let type_part = a
                .type_ref
                .as_ref()
                .map(|t| format!(" : {}", t))
                .unwrap_or_else(|| {
                    a.specializes
                        .as_ref()
                        .map(|s| format!(" :> {}", s))
                        .unwrap_or_default()
                });
            let mult_str = a
                .multiplicity
                .as_ref()
                .map(format_multiplicity)
                .unwrap_or_default();
            let description = format!("attribute def '{}'{}{}", a.name, type_part, mult_str);
            let sig_type = type_part.trim().trim_start_matches(':').trim();
            let signature = if sig_type.is_empty() {
                format!("attribute def {};", a.name)
            } else {
                format!("attribute def {} : {};", a.name, sig_type)
            };
            out.push(SymbolEntry {
                name: a.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::PROPERTY,
                container_name: container.map(String::from),
                detail: Some("attribute def".to_string()),
                description: Some(description),
                signature: Some(signature),
            });
        }
        M::AttributeUsage(a) => {
            let selection_range = a
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = a
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let type_part = a
                .type_ref
                .as_ref()
                .map(|t| format!(" : {}", t))
                .unwrap_or_default();
            let mult_str = a
                .multiplicity
                .as_ref()
                .map(format_multiplicity)
                .unwrap_or_default();
            let description = format!("attribute usage '{}'{}{}", a.name, type_part, mult_str);
            let sig_type = type_part.trim().trim_start_matches(':').trim();
            let signature = if sig_type.is_empty() {
                format!("attribute {};", a.name)
            } else {
                format!("attribute {} : {};", a.name, sig_type)
            };
            out.push(SymbolEntry {
                name: a.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::PROPERTY,
                container_name: container.map(String::from),
                detail: Some("attribute".to_string()),
                description: Some(description),
                signature: Some(signature),
            });
        }
        M::PortDef(p) => {
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let type_part = p
                .type_ref
                .as_ref()
                .map(|t| format!(" : {}", t))
                .unwrap_or_default();
            let description = format!("port def '{}'{}", p.name, type_part);
            let sig_type = type_part.trim().trim_start_matches(':').trim();
            let signature = if sig_type.is_empty() {
                format!("port def {};", p.name)
            } else {
                format!("port def {} : {};", p.name, sig_type)
            };
            out.push(SymbolEntry {
                name: p.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::INTERFACE,
                container_name: container.map(String::from),
                detail: Some("port def".to_string()),
                description: Some(description),
                signature: Some(signature),
            });
            for m in &p.members {
                symbol_entries_from_member(m, uri, Some(&p.name), out);
            }
        }
        M::PortUsage(p) => {
            let name = p.name.as_deref().unwrap_or("(anonymous)");
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            if let Some(ref n) = p.name {
                let type_part = p
                    .type_ref
                    .as_ref()
                    .map(|t| format!(" : {}", t))
                    .unwrap_or_default();
                let description = format!("port usage '{}'{}", n, type_part);
                let sig_type = type_part.trim().trim_start_matches(':').trim();
                let signature = if sig_type.is_empty() {
                    format!("port {};", n)
                } else {
                    format!("port {} : {};", n, sig_type)
                };
                out.push(SymbolEntry {
                    name: name.to_string(),
                    uri: uri.clone(),
                    range,
                    kind: SymbolKind::INTERFACE,
                    container_name: container.map(String::from),
                    detail: Some("port".to_string()),
                    description: Some(description),
                    signature: Some(signature),
                });
            }
            for m in &p.members {
                symbol_entries_from_member(m, uri, Some(name), out);
            }
        }
        M::InterfaceDef(i) => {
            let selection_range = i
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = i
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            out.push(SymbolEntry {
                name: i.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::INTERFACE,
                container_name: container.map(String::from),
                detail: Some("interface".to_string()),
                description: Some(format!("interface def '{}'", i.name)),
                signature: Some(format!("interface def {} {{ }}", i.name)),
            });
            for m in &i.members {
                symbol_entries_from_member(m, uri, Some(&i.name), out);
            }
        }
        M::InStatement(i) => {
            let selection_range = i
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = i
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let type_part = i
                .specializes
                .as_ref()
                .map(|s| format!(" :> {}", s))
                .or_else(|| i.type_ref.as_ref().map(|t| format!(" : {}", t)))
                .unwrap_or_default();
            let description = format!("in '{}'{}", i.name, type_part);
            let signature = if type_part.is_empty() {
                format!("in {};", i.name)
            } else {
                format!("in {} {};", i.name, type_part.trim_start_matches(' ').trim_start_matches(':').trim_start_matches('>').trim())
            };
            out.push(SymbolEntry {
                name: i.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::PROPERTY,
                container_name: container.map(String::from),
                detail: Some("in".to_string()),
                description: Some(description),
                signature: Some(signature),
            });
        }
        M::EndStatement(e) => {
            let selection_range = e
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = e
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let type_part = e
                .type_ref
                .as_ref()
                .map(|t| format!(" : {}", t))
                .unwrap_or_default();
            let description = format!("end '{}'{}", e.name, type_part);
            let signature = if type_part.is_empty() {
                format!("end {};", e.name)
            } else {
                format!("end {} : {};", e.name, e.type_ref.as_deref().unwrap_or(""))
            };
            out.push(SymbolEntry {
                name: e.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::PROPERTY,
                container_name: container.map(String::from),
                detail: Some("end".to_string()),
                description: Some(description),
                signature: Some(signature),
            });
        }
        M::ConnectionUsage(c) => {
            if let (Some(ref name), Some(ref pos)) = (&c.name, &c.name_position) {
                let selection_range = source_position_to_range(pos);
                let range = c
                    .range
                    .as_ref()
                    .map(source_range_to_range)
                    .unwrap_or(selection_range);
                out.push(SymbolEntry {
                    name: name.clone(),
                    uri: uri.clone(),
                    range,
                    kind: SymbolKind::VARIABLE,
                    container_name: container.map(String::from),
                    detail: Some("connection".to_string()),
                    description: Some(format!("connection '{}'", name)),
                    signature: Some(format!("connection {} ();", name)),
                });
            }
        }
        M::ItemDef(i) => {
            let selection_range = i
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = i
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            out.push(SymbolEntry {
                name: i.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::CONSTANT,
                container_name: container.map(String::from),
                detail: Some("item def".to_string()),
                description: Some(format!("item def '{}'", i.name)),
                signature: Some(format!("item def {};", i.name)),
            });
            for m in &i.members {
                symbol_entries_from_member(m, uri, Some(&i.name), out);
            }
        }
        M::ItemUsage(i) => {
            let selection_range = i
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = i
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let type_part = i
                .type_ref
                .as_ref()
                .map(|t| format!(" : {}", t))
                .unwrap_or_default();
            let mult_str = i
                .multiplicity
                .as_ref()
                .map(format_multiplicity)
                .unwrap_or_default();
            let description = format!("item usage '{}'{}{}", i.name, type_part, mult_str);
            let sig_type = type_part.trim().trim_start_matches(':').trim();
            let signature = if sig_type.is_empty() {
                format!("item {};", i.name)
            } else {
                format!("item {} : {};", i.name, sig_type)
            };
            out.push(SymbolEntry {
                name: i.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::CONSTANT,
                container_name: container.map(String::from),
                detail: Some("item".to_string()),
                description: Some(description),
                signature: Some(signature),
            });
        }
        M::RequirementDef(r) => {
            let selection_range = r
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = r
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            out.push(SymbolEntry {
                name: r.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::STRING,
                container_name: container.map(String::from),
                detail: Some("requirement def".to_string()),
                description: Some(format!("requirement def '{}'", r.name)),
                signature: Some(format!("requirement def {};", r.name)),
            });
            for m in &r.members {
                symbol_entries_from_member(m, uri, Some(&r.name), out);
            }
        }
        M::RequirementUsage(r) => {
            let selection_range = r
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = r
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            out.push(SymbolEntry {
                name: r.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::STRING,
                container_name: container.map(String::from),
                detail: Some("requirement".to_string()),
                description: Some(format!("requirement usage '{}'", r.name)),
                signature: Some(format!("requirement {};", r.name)),
            });
        }
        M::ActionDef(a) => {
            let selection_range = a
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = a
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            out.push(SymbolEntry {
                name: a.name.clone(),
                uri: uri.clone(),
                range,
                kind: SymbolKind::FUNCTION,
                container_name: container.map(String::from),
                detail: Some("action def".to_string()),
                description: Some(format!("action def '{}'", a.name)),
                signature: Some(format!("action def {};", a.name)),
            });
        }
        M::Package(p) => symbol_entries_from_package(p, uri, container, out),
        _ => {}
    }
}

fn document_symbol_from_package(pkg: &kerml_parser::ast::Package) -> Option<DocumentSymbol> {
    let name = if pkg.name.is_empty() {
        "(top level)"
    } else {
        pkg.name.as_str()
    };
    let selection_range = pkg
        .name_position
        .as_ref()
        .map(source_position_to_range)
        .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
    let range = pkg
        .range
        .as_ref()
        .map(source_range_to_range)
        .unwrap_or(selection_range);
    let children = document_symbols_from_members(&pkg.members);
    let selection_range = selection_contained_in(selection_range, range);
    Some(DocumentSymbol {
        name: name.to_string(),
        detail: Some("package".to_string()),
        kind: SymbolKind::MODULE,
        tags: None,
        deprecated: None,
        range,
        selection_range,
        children: if children.is_empty() { None } else { Some(children) },
    })
}

fn document_symbols_from_members(members: &[Member]) -> Vec<DocumentSymbol> {
    let mut out = Vec::new();
    for m in members {
        if let Some(sym) = document_symbol_from_member(m) {
            out.push(sym);
        }
    }
    out
}

fn document_symbol_from_member(member: &Member) -> Option<DocumentSymbol> {
    use kerml_parser::ast::Member as M;
    match member {
        M::PartDef(p) => {
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            let children = document_symbols_from_members(&p.members);
            Some(DocumentSymbol {
                name: p.name.clone(),
                detail: Some("part def".to_string()),
                kind: SymbolKind::CLASS,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        M::PartUsage(p) => {
            let name = p.name.as_deref().unwrap_or("(anonymous)");
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            let children = document_symbols_from_members(&p.members);
            Some(DocumentSymbol {
                name: name.to_string(),
                detail: Some("part".to_string()),
                kind: SymbolKind::VARIABLE,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        M::AttributeDef(a) => {
            let selection_range = a
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = a
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            Some(DocumentSymbol {
                name: a.name.clone(),
                detail: Some("attribute def".to_string()),
                kind: SymbolKind::PROPERTY,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: None,
            })
        }
        M::AttributeUsage(a) => {
            let selection_range = a
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = a
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            Some(DocumentSymbol {
                name: a.name.clone(),
                detail: Some("attribute".to_string()),
                kind: SymbolKind::PROPERTY,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: None,
            })
        }
        M::PortDef(p) => {
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            let children = document_symbols_from_members(&p.members);
            Some(DocumentSymbol {
                name: p.name.clone(),
                detail: Some("port def".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        M::PortUsage(p) => {
            let name = p.name.as_deref().unwrap_or("(anonymous)");
            let selection_range = p
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = p
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            let children = document_symbols_from_members(&p.members);
            Some(DocumentSymbol {
                name: name.to_string(),
                detail: Some("port".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        M::InterfaceDef(i) => {
            let selection_range = i
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = i
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let children = document_symbols_from_members(&i.members);
            Some(DocumentSymbol {
                name: i.name.clone(),
                detail: Some("interface".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        M::ConnectionUsage(c) => {
            let name = c.name.as_deref().unwrap_or("(connection)");
            let selection_range = c
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = c
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            Some(DocumentSymbol {
                name: name.to_string(),
                detail: Some("connection".to_string()),
                kind: SymbolKind::VARIABLE,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: None,
            })
        }
        M::ItemDef(i) => {
            let selection_range = i
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = i
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            let children = document_symbols_from_members(&i.members);
            Some(DocumentSymbol {
                name: i.name.clone(),
                detail: Some("item def".to_string()),
                kind: SymbolKind::CONSTANT,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        M::ItemUsage(i) => {
            let selection_range = i
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = i
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            Some(DocumentSymbol {
                name: i.name.clone(),
                detail: Some("item".to_string()),
                kind: SymbolKind::CONSTANT,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: None,
            })
        }
        M::RequirementDef(r) => {
            let selection_range = r
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = r
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            let children = document_symbols_from_members(&r.members);
            Some(DocumentSymbol {
                name: r.name.clone(),
                detail: Some("requirement def".to_string()),
                kind: SymbolKind::STRING,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        M::RequirementUsage(r) => {
            let selection_range = r
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = r
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            Some(DocumentSymbol {
                name: r.name.clone(),
                detail: Some("requirement".to_string()),
                kind: SymbolKind::STRING,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: None,
            })
        }
        M::ActionDef(a) => {
            let selection_range = a
                .name_position
                .as_ref()
                .map(source_position_to_range)
                .unwrap_or_else(|| Range::new(Position::new(0, 0), Position::new(0, 0)));
            let range = a
                .range
                .as_ref()
                .map(source_range_to_range)
                .unwrap_or(selection_range);
            let selection_range = selection_contained_in(selection_range, range);
            Some(DocumentSymbol {
                name: a.name.clone(),
                detail: Some("action def".to_string()),
                kind: SymbolKind::FUNCTION,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: None,
            })
        }
        M::Package(p) => document_symbol_from_package(p),
        _ => None,
    }
}

/// Formats the whole document: trim trailing whitespace per line, single trailing newline, indent by brace depth.
pub fn format_document(source: &str, options: &FormattingOptions) -> Vec<TextEdit> {
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        let range = Range::new(Position::new(0, 0), Position::new(0, 0));
        return vec![TextEdit {
            range,
            new_text: "\n".to_string(),
        }];
    }
    let indent_unit = if options.insert_spaces {
        " ".repeat(options.tab_size as usize)
    } else {
        "\t".to_string()
    };
    let mut depth: i32 = 0;
    let mut formatted_lines: Vec<String> = Vec::with_capacity(lines.len());
    for line in &lines {
        let trimmed = line.trim();
        let mut open_braces = 0i32;
        let mut close_braces = 0i32;
        for ch in trimmed.chars() {
            match ch {
                '{' => open_braces += 1,
                '}' => close_braces += 1,
                _ => {}
            }
        }
        // Closing braces indent at the depth they close (before subtracting)
        let indent_depth = (depth - close_braces).max(0);
        depth += open_braces - close_braces;
        let indent = indent_unit.repeat(indent_depth as usize);
        let content = if trimmed.is_empty() {
            String::new()
        } else {
            format!("{}{}", indent, trimmed)
        };
        formatted_lines.push(content);
    }
    let new_text = if formatted_lines.is_empty() {
        "\n".to_string()
    } else {
        format!("{}\n", formatted_lines.join("\n"))
    };
    let last_line = (lines.len() - 1) as u32;
    let last_char = lines.last().map(|l| l.len()).unwrap_or(0) as u32;
    let range = Range::new(Position::new(0, 0), Position::new(last_line, last_char));
    vec![TextEdit { range, new_text }]
}

/// Suggests a "Wrap in package" code action when the document has top-level members (one package with empty name and members).
pub fn suggest_wrap_in_package(source: &str, uri: &Url) -> Option<CodeAction> {
    let doc = kerml_parser::parse_sysml(source).ok()?;
    let packages = &doc.packages;
    if packages.len() != 1 {
        return None;
    }
    let pkg = &packages[0];
    if !pkg.name.is_empty() || pkg.members.is_empty() {
        return None;
    }
    let lines: Vec<&str> = source.lines().collect();
    let last_line = lines.len().saturating_sub(1) as u32;
    let last_char = lines.last().map(|l| l.len()).unwrap_or(0) as u32;
    let range = Range::new(Position::new(0, 0), Position::new(last_line, last_char));
    let new_text = format!("package Generated {{\n{}\n}}\n", source.trim_end());
    let edit = WorkspaceEdit {
        changes: None,
        document_changes: Some(tower_lsp::lsp_types::DocumentChanges::Edits(vec![
            TextDocumentEdit {
                text_document: OptionalVersionedTextDocumentIdentifier {
                    uri: uri.clone(),
                    version: None,
                },
                edits: vec![OneOf::Left(TextEdit { range, new_text })],
            },
        ])),
        change_annotations: None,
    };
    Some(CodeAction {
        title: "Wrap in package".to_string(),
        kind: Some(tower_lsp::lsp_types::CodeActionKind::REFACTOR),
        diagnostics: None,
        edit: Some(edit),
        command: None,
        is_preferred: None,
        disabled: None,
        data: None,
    })
}

/// Collects all named elements from the document for hover/completion: (name, short_description).
pub fn collect_named_elements(doc: &SysMLDocument) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for pkg in &doc.packages {
        collect_from_package(pkg, &mut out);
    }
    out
}

fn collect_from_package(pkg: &kerml_parser::ast::Package, out: &mut Vec<(String, String)>) {
    let prefix = format!("package '{}'", pkg.name);
    out.push((pkg.name.clone(), prefix));
    for m in &pkg.members {
        collect_from_member(m, out);
    }
}

fn collect_from_member(member: &Member, out: &mut Vec<(String, String)>) {
    use kerml_parser::ast::Member as M;
    match member {
        M::PartDef(p) => {
            let desc = format!(
                "part def '{}'{}",
                p.name,
                p.type_ref
                    .as_ref()
                    .map(|t| format!(" : {}", t))
                    .unwrap_or_else(|| p.specializes.as_ref().map(|s| format!(" :> {}", s)).unwrap_or_default())
            );
            out.push((p.name.clone(), desc));
            for m in &p.members {
                collect_from_member(m, out);
            }
        }
        M::PartUsage(p) => {
            if let Some(ref name) = p.name {
                let desc = format!(
                    "part usage '{}'{}",
                    name,
                    p.type_ref
                        .as_ref()
                        .map(|t| format!(" : {}", t))
                        .unwrap_or_else(|| p.specializes.as_ref().map(|s| format!(" :> {}", s)).unwrap_or_default())
                );
                out.push((name.clone(), desc));
            }
            for m in &p.members {
                collect_from_member(m, out);
            }
        }
        M::AttributeDef(a) => {
            let desc = format!(
                "attribute def '{}'{}",
                a.name,
                a.type_ref
                    .as_ref()
                    .map(|t| format!(" : {}", t))
                    .unwrap_or_else(|| a.specializes.as_ref().map(|s| format!(" :> {}", s)).unwrap_or_default())
            );
            out.push((a.name.clone(), desc));
        }
        M::AttributeUsage(a) => {
            let desc = format!(
                "attribute usage '{}'{}",
                a.name,
                a.type_ref
                    .as_ref()
                    .map(|t| format!(" : {}", t))
                    .unwrap_or_default()
            );
            out.push((a.name.clone(), desc));
        }
        M::PortDef(p) => {
            let desc = format!(
                "port def '{}'{}",
                p.name,
                p.type_ref
                    .as_ref()
                    .map(|t| format!(" : {}", t))
                    .unwrap_or_default()
            );
            out.push((p.name.clone(), desc));
        }
        M::PortUsage(p) => {
            if let Some(ref name) = p.name {
                out.push((name.clone(), format!("port usage '{}'", name)));
            }
            for m in &p.members {
                collect_from_member(m, out);
            }
        }
        M::InterfaceDef(i) => {
            out.push((i.name.clone(), format!("interface def '{}'", i.name)));
            for m in &i.members {
                collect_from_member(m, out);
            }
        }
        M::ItemDef(i) => {
            out.push((i.name.clone(), format!("item def '{}'", i.name)));
        }
        M::ItemUsage(i) => {
            out.push((i.name.clone(), format!("item usage '{}'", i.name)));
        }
        M::RequirementDef(r) => {
            out.push((r.name.clone(), format!("requirement def '{}'", r.name)));
            for m in &r.members {
                collect_from_member(m, out);
            }
        }
        M::RequirementUsage(r) => {
            out.push((r.name.clone(), format!("requirement usage '{}'", r.name)));
        }
        M::ActionDef(a) => {
            out.push((a.name.clone(), format!("action def '{}'", a.name)));
        }
        M::Package(p) => {
            collect_from_package(p, out);
        }
        M::ConnectionUsage(c) => {
            if let Some(ref n) = c.name {
                out.push((n.clone(), format!("connection '{}'", n)));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower_lsp::lsp_types::Url;

    #[test]
    fn test_position_to_byte_offset() {
        let text = "abc\ndef\nghi";
        assert_eq!(position_to_byte_offset(text, 0, 0), Some(0));
        assert_eq!(position_to_byte_offset(text, 0, 2), Some(2));
        assert_eq!(position_to_byte_offset(text, 1, 0), Some(4));
        assert_eq!(position_to_byte_offset(text, 1, 3), Some(7));
        assert_eq!(position_to_byte_offset(text, 2, 0), Some(8));
        assert_eq!(position_to_byte_offset(text, 3, 0), None);
        assert_eq!(position_to_byte_offset(text, 0, 10), None);
    }

    #[test]
    fn test_word_at_position() {
        let text = "  part foo : Bar  ";
        let (line, start, end, word) = word_at_position(text, 0, 5).unwrap();
        assert_eq!(line, 0);
        assert_eq!(start, 2);
        assert_eq!(end, 6);
        assert_eq!(word, "part");

        let (_, _, _, w) = word_at_position(text, 0, 8).unwrap();
        assert_eq!(w, "foo");
        let (_, _, _, w) = word_at_position(text, 0, 13).unwrap();
        assert_eq!(w, "Bar");
    }

    #[test]
    fn test_word_at_position_empty_line() {
        let text = "abc";
        assert!(word_at_position(text, 0, 0).is_some());
        let (_, _, _, w) = word_at_position(text, 0, 0).unwrap();
        assert_eq!(w, "abc");
    }

    #[test]
    fn test_line_prefix_at_position() {
        let text = "  part foo";
        let prefix = line_prefix_at_position(text, 0, 7);
        assert_eq!(prefix, "  part ");
        let prefix = line_prefix_at_position(text, 0, 8);
        assert_eq!(prefix, "  part f");
    }

    #[test]
    fn test_completion_prefix() {
        assert_eq!(completion_prefix("  part "), "part");
        assert_eq!(completion_prefix("  part f"), "f");
        assert_eq!(completion_prefix("  pac"), "pac");
    }

    #[test]
    fn test_keyword_doc() {
        assert!(keyword_doc("part").is_some());
        assert!(keyword_doc("unknown").is_none());
    }

    #[test]
    fn test_sysml_keywords_contains_common() {
        let kw = sysml_keywords();
        assert!(kw.contains(&"package"));
        assert!(kw.contains(&"part"));
        assert!(kw.contains(&"attribute"));
    }

    #[test]
    fn test_collect_named_elements_empty() {
        let doc = SysMLDocument::default();
        let el = collect_named_elements(&doc);
        assert!(el.is_empty());
    }

    #[test]
    fn test_collect_named_elements_from_package() {
        let doc = SysMLDocument {
            imports: vec![],
            packages: vec![kerml_parser::ast::Package {
                name: "P".to_string(),
                name_position: None,
                range: None,
                is_library: false,
                imports: vec![],
                members: vec![
                    Member::PartDef(kerml_parser::ast::PartDef {
                        name: "Engine".to_string(),
                        name_position: None,
                        range: None,
                        is_abstract: false,
                        specializes: None,
                        specializes_position: None,
                        type_ref: None,
                        type_ref_position: None,
                        multiplicity: None,
                        ordered: false,
                        metadata: vec![],
                        members: vec![],
                    }),
                ],
            }],
        };
        let el = collect_named_elements(&doc);
        assert_eq!(el.len(), 2); // package P + part Engine
        let names: Vec<_> = el.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"P"));
        assert!(names.contains(&"Engine"));
    }

    #[test]
    fn test_source_position_to_range() {
        use kerml_parser::ast::SourcePosition;
        let pos = SourcePosition {
            line: 0,
            character: 2,
            length: 5,
        };
        let range = source_position_to_range(&pos);
        assert_eq!(range.start.line, 0);
        assert_eq!(range.start.character, 2);
        assert_eq!(range.end.line, 0);
        assert_eq!(range.end.character, 7);
    }

    #[test]
    fn test_collect_definition_ranges_empty() {
        let doc = SysMLDocument::default();
        let ranges = collect_definition_ranges(&doc);
        assert!(ranges.is_empty());
    }

    #[test]
    fn test_collect_definition_ranges_package() {
        let text = "package P { }";
        let doc = kerml_parser::parse_sysml(text).expect("parse");
        let ranges = collect_definition_ranges(&doc);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].0, "P");
    }

    #[test]
    fn test_collect_definition_ranges_part_def() {
        let text = "part def Engine { }";
        let doc = kerml_parser::parse_sysml(text).expect("parse");
        let ranges = collect_definition_ranges(&doc);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].0, "Engine");
    }

    #[test]
    fn test_find_reference_ranges_empty() {
        let ranges = find_reference_ranges("hello world", "foo");
        assert!(ranges.is_empty());
    }

    #[test]
    fn test_find_reference_ranges_once() {
        let ranges = find_reference_ranges("hello foo world", "foo");
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start.character, 6);
        assert_eq!(ranges[0].end.character, 9);
    }

    #[test]
    fn test_find_reference_ranges_multiple() {
        let ranges = find_reference_ranges("foo bar foo baz foo", "foo");
        assert_eq!(ranges.len(), 3);
    }

    #[test]
    fn test_find_reference_ranges_word_boundary() {
        // "foo" in "foobar" must not match
        let ranges = find_reference_ranges("foobar", "foo");
        assert!(ranges.is_empty());
        // "foo" in "foo bar" must match
        let ranges = find_reference_ranges("foo bar", "foo");
        assert_eq!(ranges.len(), 1);
    }

    #[test]
    fn test_collect_document_symbols_empty() {
        let doc = SysMLDocument::default();
        let symbols = collect_document_symbols(&doc);
        assert!(symbols.is_empty());
    }

    #[test]
    fn test_collect_document_symbols_package() {
        let text = "package P { }";
        let doc = kerml_parser::parse_sysml(text).expect("parse");
        let symbols = collect_document_symbols(&doc);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "P");
        assert_eq!(symbols[0].detail.as_deref(), Some("package"));
        assert_eq!(symbols[0].kind, SymbolKind::MODULE);
    }

    #[test]
    fn test_collect_document_symbols_nested() {
        let text = "package P { part def Engine { } }";
        let doc = kerml_parser::parse_sysml(text).expect("parse");
        let symbols = collect_document_symbols(&doc);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "P");
        let children = symbols[0].children.as_ref().expect("children");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "Engine");
        assert_eq!(children[0].detail.as_deref(), Some("part def"));
        assert_eq!(children[0].kind, SymbolKind::CLASS);
    }

    #[test]
    fn test_collect_symbol_entries_empty() {
        let doc = SysMLDocument::default();
        let uri = Url::parse("file:///test.sysml").unwrap();
        let entries = collect_symbol_entries(&doc, &uri);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_collect_symbol_entries_package() {
        let text = "package P { }";
        let doc = kerml_parser::parse_sysml(text).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let entries = collect_symbol_entries(&doc, &uri);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "P");
        assert_eq!(entries[0].detail.as_deref(), Some("package"));
        assert_eq!(entries[0].kind, SymbolKind::MODULE);
        assert_eq!(entries[0].uri, uri);
        assert!(entries[0].description.as_deref().unwrap().contains("package"));
    }

    #[test]
    fn test_collect_symbol_entries_nested() {
        let text = "package P { part def Engine { } }";
        let doc = kerml_parser::parse_sysml(text).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let entries = collect_symbol_entries(&doc, &uri);
        assert_eq!(entries.len(), 2); // package P + part def Engine
        assert_eq!(entries[0].name, "P");
        assert_eq!(entries[0].container_name, None);
        assert_eq!(entries[1].name, "Engine");
        assert_eq!(entries[1].container_name.as_deref(), Some("P"));
        assert_eq!(entries[1].detail.as_deref(), Some("part def"));
        assert_eq!(entries[1].kind, SymbolKind::CLASS);
    }

    #[test]
    fn test_suggest_wrap_in_package_empty() {
        let uri = Url::parse("file:///test.sysml").unwrap();
        let action = suggest_wrap_in_package("", &uri);
        assert!(action.is_none());
    }

    #[test]
    fn test_suggest_wrap_in_package_named_package() {
        let uri = Url::parse("file:///test.sysml").unwrap();
        let action = suggest_wrap_in_package("package P { }", &uri);
        assert!(action.is_none());
    }

    #[test]
    fn test_suggest_wrap_in_package_unwrapped_member() {
        let uri = Url::parse("file:///test.sysml").unwrap();
        let source = "part def X { }";
        let action = suggest_wrap_in_package(source, &uri).expect("one code action");
        assert!(action.title.contains("Wrap"));
        let edit = action.edit.expect("has edit");
        let doc_edits = edit.document_changes.as_ref().expect("document_changes");
        use tower_lsp::lsp_types::DocumentChanges;
        let edits = match doc_edits {
            DocumentChanges::Edits(v) => v,
            _ => panic!("expected Edits"),
        };
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].edits.len(), 1);
        let text_edit = match &edits[0].edits[0] {
            tower_lsp::lsp_types::OneOf::Left(te) => te,
            _ => panic!("expected TextEdit"),
        };
        assert_eq!(
            text_edit.new_text,
            "package Generated {\npart def X { }\n}\n"
        );
    }

    #[test]
    fn test_format_document_empty() {
        let options = tower_lsp::lsp_types::FormattingOptions {
            tab_size: 4,
            insert_spaces: true,
            ..Default::default()
        };
        let edits = format_document("", &options);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].new_text, "\n");
    }

    #[test]
    fn test_format_document_trim_trailing_whitespace() {
        let options = tower_lsp::lsp_types::FormattingOptions {
            tab_size: 4,
            insert_spaces: true,
            ..Default::default()
        };
        let edits = format_document("package P {   \n  part def X { }  \n", &options);
        assert_eq!(edits.len(), 1);
        assert!(edits[0].new_text.contains("package P {"));
        assert!(edits[0].new_text.contains("part def X { }"));
        assert!(!edits[0].new_text.contains("   \n"));
        assert!(!edits[0].new_text.contains("  \n"));
    }

    #[test]
    fn test_format_document_indent_by_braces() {
        let options = tower_lsp::lsp_types::FormattingOptions {
            tab_size: 2,
            insert_spaces: true,
            ..Default::default()
        };
        let source = "package P {\npart def X {\n}\n}\n";
        let edits = format_document(source, &options);
        assert_eq!(edits.len(), 1);
        let expected = "package P {\n  part def X {\n  }\n}\n";
        assert_eq!(edits[0].new_text, expected);
    }

    /// Validation test: parse VehicleDefinitions.sysml and write semantic tokens and symbol table
    /// to target/ for review (semantic_tokens_vehicle_definitions.txt, symbol_table_vehicle_definitions.txt).
    #[test]
    fn test_vehicle_definitions_validation_output() {
        let release_root = std::env::var_os("SYSML_V2_RELEASE_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("temp")
                    .join("SysML-v2-Release-2026-01")
            });
        let path = release_root
            .join("sysml")
            .join("src")
            .join("examples")
            .join("Vehicle Example")
            .join("VehicleDefinitions.sysml");
        if !path.exists() {
            return; // skip when Vehicle Example not present (e.g. SYSML_V2_RELEASE_DIR unset)
        }
        let content = std::fs::read_to_string(&path).expect("read VehicleDefinitions.sysml");
        let doc = kerml_parser::parse_sysml(&content).expect("parse");
        let uri = Url::from_file_path(&path).unwrap_or_else(|_| Url::parse("file:///VehicleDefinitions.sysml").unwrap());

        // Semantic tokens
        let ranges = kerml_parser::ast::collect_semantic_ranges(&doc);
        let target_dir = std::env::var_os("CARGO_TARGET_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target"));
        let _ = std::fs::create_dir_all(&target_dir);
        let tokens_path = target_dir.join("semantic_tokens_vehicle_definitions.txt");
        write_semantic_ranges_for_review(&content, &ranges, &tokens_path);

        // Symbol table
        let entries = collect_symbol_entries(&doc, &uri);
        let table_path = target_dir.join("symbol_table_vehicle_definitions.txt");
        write_symbol_table_for_review(&entries, &table_path);
    }

    #[cfg(test)]
    fn range_text_from_source(source: &str, r: &kerml_parser::ast::SourceRange) -> String {
        let lines: Vec<&str> = source.lines().collect();
        let line = match lines.get(r.start_line as usize) {
            Some(l) => l,
            None => return String::new(),
        };
        let start = r.start_character as usize;
        let end = r.end_character as usize;
        if start >= line.len() || end > line.len() || start >= end {
            return String::new();
        }
        line.get(start..end).unwrap_or("").to_string()
    }

    #[cfg(test)]
    fn write_semantic_ranges_for_review(
        source: &str,
        ranges: &[(kerml_parser::ast::SourceRange, kerml_parser::ast::SemanticRole)],
        out_path: &std::path::Path,
    ) {
        use kerml_parser::ast::SemanticRole;
        use std::io::Write;
        fn role_str(r: SemanticRole) -> &'static str {
            match r {
                SemanticRole::Type => "Type",
                SemanticRole::Namespace => "Namespace",
                SemanticRole::Class => "Class",
                SemanticRole::Interface => "Interface",
                SemanticRole::Property => "Property",
                SemanticRole::Function => "Function",
            }
        }
        if let Ok(mut f) = std::fs::File::create(out_path) {
            let _ = writeln!(f, "# Semantic token ranges (line/char 0-based)\n");
            for (r, role) in ranges {
                let text = range_text_from_source(source, r);
                let text_escaped = text.replace('\n', "\\n").replace('\r', "\\r");
                let _ = writeln!(
                    f,
                    "{}:{}..{} {} \"{}\"",
                    r.start_line,
                    r.start_character,
                    r.end_character,
                    role_str(*role),
                    text_escaped
                );
            }
        }
    }

    #[cfg(test)]
    fn write_symbol_table_for_review(entries: &[SymbolEntry], out_path: &std::path::Path) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::File::create(out_path) {
            let _ = writeln!(f, "# Symbol table (name | kind | container | range | signature)\n");
            for e in entries {
                let range_str = format!(
                    "{}:{}..{}:{}",
                    e.range.start.line,
                    e.range.start.character,
                    e.range.end.line,
                    e.range.end.character
                );
                let kind_str = format!("{:?}", e.kind);
                let container = e.container_name.as_deref().unwrap_or("-");
                let sig = e.signature.as_deref().unwrap_or("-");
                let _ = writeln!(f, "{} | {} | {} | {} | {}", e.name, kind_str, container, range_str, sig);
            }
        }
    }
}
