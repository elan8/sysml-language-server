//! Helpers for hover and completion: position/word resolution, keywords, and AST name collection.
//! Also provides definition/reference ranges for Go to definition and Find references.
#![allow(deprecated)] // LSP deprecated field in DocumentSymbol/SymbolInformation; use tags in future

use sysml_parser::ast::{
    PackageBodyElement, PackageBody, PartDefBody, PartDefBodyElement, PartUsageBody,
    PartUsageBodyElement, PortDefBody, PortDefBodyElement, RootElement,
};
use sysml_parser::RootNamespace;
use crate::ast_util::{identification_name, span_to_range};
use tower_lsp::lsp_types::{
    CodeAction, DocumentSymbol, FormattingOptions, Location, OneOf,
    FoldingRange, FoldingRangeKind, OptionalVersionedTextDocumentIdentifier, Position, Range,
    SymbolInformation, SymbolKind, TextDocumentEdit, TextEdit, Url, WorkspaceEdit,
};

/// Converts (line, character) to byte offset in `text`. LSP uses 0-based line and character
/// (character is Unicode scalar index; for multi-byte UTF-8, this differs from byte offset).
#[allow(dead_code)] // used by tests and for future LSP features (e.g. range resolution)
pub fn position_to_byte_offset(text: &str, line: u32, character: u32) -> Option<usize> {
    let line_str = text.lines().nth(line as usize)?;
    let char_off = character as usize;
    let n_chars = line_str.chars().count();
    if char_off > n_chars {
        return None;
    }
    // Use char_indices to convert character index to byte offset (handles multi-byte UTF-8)
    let byte_in_line = line_str
        .char_indices()
        .nth(char_off)
        .map(|(o, _)| o)
        .unwrap_or(line_str.len());
    let line_start = text
        .lines()
        .take(line as usize)
        .map(|l| l.len() + 1)
        .sum::<usize>();
    Some(line_start + byte_in_line)
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
/// Iterates by character to handle multi-byte UTF-8 correctly.
pub fn completion_prefix(line_prefix: &str) -> &str {
    fn is_ident_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_' || c == ':' || c == '>'
    }
    let trimmed = line_prefix.trim_end();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.is_empty() {
        return trimmed;
    }
    let mut n_trailing = 0;
    for c in chars.iter().rev() {
        if is_ident_char(*c) {
            n_trailing += 1;
        } else {
            break;
        }
    }
    let start_char_idx = chars.len().saturating_sub(n_trailing);
    let byte_start = trimmed
        .char_indices()
        .nth(start_char_idx)
        .map(|(o, _)| o)
        .unwrap_or(trimmed.len());
    trimmed.get(byte_start..).unwrap_or("")
}

/// SysML v2 / KerML reserved keywords (BNF 8.2.2.1.2 RESERVED_KEYWORD, plus grammar extensions:
/// value, provides, requires).
/// Single source of truth for semantic token fallback and keyword checks (goto-def, rename).
/// Note: "position" is a contextual keyword (position_statement) only, not reserved—valid as identifier.
pub const RESERVED_KEYWORDS: &[&str] = &[
    "about", "abstract", "accept", "action", "actor", "after", "alias", "all", "allocate",
    "allocation", "analysis", "and", "as", "assert", "assign", "assume", "at", "attribute",
    "bind", "binding", "by", "calc", "case", "comment", "concern", "connect", "connection",
    "constant", "constraint", "crosses", "decide", "def", "default", "defined", "dependency",
    "derived", "do", "doc", "else", "end", "entry", "enum", "event", "exhibit", "exit",
    "expose", "false", "filter", "first", "flow", "for", "fork", "frame", "from", "hastype",
    "if", "implies", "import", "in", "include", "individual", "inout", "interface",
    "istype", "item", "join", "language", "library", "locale", "loop", "merge", "message",
    "meta", "metadata", "nonunique", "not", "null", "objective", "occurrence", "of", "or",
    "ordered", "out", "package", "parallel", "part", "perform", "port", "private",
    "protected", "provides", "public", "redefines", "ref", "references", "render", "rendering",
    "rep", "require", "requirement", "requires", "return", "satisfy", "send", "snapshot",
    "specializes", "stakeholder", "standard", "state", "subject", "subsets", "succession",
    "terminate", "then", "timeslice", "to", "transition", "true", "until", "use", "value",
    "variant", "variation", "verification", "verify", "via", "view", "viewpoint", "when",
    "while", "xor",
];

/// Returns true if the word is a SysML v2 reserved keyword. Use this for semantic tokens
/// fallback and for suppressing goto-definition/rename on keywords.
pub fn is_reserved_keyword(word: &str) -> bool {
    RESERVED_KEYWORDS.contains(&word)
}

/// Curated subset of reserved keywords used for completion suggestions and hover docs.
/// All entries must be in RESERVED_KEYWORDS.
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

/// Simple position (for tests and compatibility). 0-based line and character.
#[derive(Debug, Clone)]
pub struct SourcePosition {
    pub line: u32,
    pub character: u32,
    pub length: u32,
}

/// Converts AST source position to an LSP Range.
pub fn source_position_to_range(pos: &SourcePosition) -> Range {
    Range::new(
        Position::new(pos.line, pos.character),
        Position::new(pos.line, pos.character + pos.length),
    )
}

/// Simple range (for tests and compatibility). 0-based.
#[derive(Debug, Clone)]
pub struct SourceRange {
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
}

/// Converts AST source range to an LSP Range.
pub fn source_range_to_range(r: &SourceRange) -> Range {
    Range::new(
        Position::new(r.start_line, r.start_character),
        Position::new(r.end_line, r.end_character),
    )
}

/// Ensures selection_range is contained in full range (LSP requirement).
/// If selection is outside or partially outside full_range, returns a clamped selection or full_range.
pub(crate) fn selection_contained_in(mut selection: Range, full: Range) -> Range {
    fn pos_lt(a: &Position, b: &Position) -> bool {
        a.line < b.line || (a.line == b.line && a.character < b.character)
    }
    fn pos_gt(a: &Position, b: &Position) -> bool {
        a.line > b.line || (a.line == b.line && a.character > b.character)
    }
    if pos_lt(&selection.start, &full.start) {
        selection.start = full.start;
    }
    if pos_gt(&selection.end, &full.end) {
        selection.end = full.end;
    }
    if pos_lt(&selection.end, &selection.start) {
        return full;
    }
    selection
}

/// Collects for each defined name in the document the LSP range of its definition.
pub fn collect_definition_ranges(root: &RootNamespace) -> Vec<(String, Range)> {
    let mut out = Vec::new();
    for node in &root.elements {
        let (name, range, elements) = match &node.value {
            RootElement::Package(p) => {
                let name = identification_name(&p.identification);
                let range = span_to_range(&p.span);
                let elements = match &p.body {
                    PackageBody::Brace { elements } => elements,
                    _ => continue,
                };
                (name, range, elements)
            }
            RootElement::Namespace(n) => {
                let name = identification_name(&n.identification);
                let range = span_to_range(&n.span);
                let elements = match &n.body {
                    PackageBody::Brace { elements } => elements,
                    _ => continue,
                };
                (name, range, elements)
            }
        };
        if !name.is_empty() {
            out.push((name, range));
        }
        for el in elements {
            collect_definition_ranges_from_element(el, &mut out);
        }
    }
    out
}

fn collect_definition_ranges_from_element(
    node: &sysml_parser::Node<PackageBodyElement>,
    out: &mut Vec<(String, Range)>,
) {
    use sysml_parser::ast::PackageBodyElement as PBE;
    match &node.value {
        PBE::Package(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name.clone(), span_to_range(&p.span)));
            }
            if let PackageBody::Brace { elements } = &p.body {
                for child in elements {
                    collect_definition_ranges_from_element(child, out);
                }
            }
        }
        PBE::PartDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name, span_to_range(&p.span)));
            }
            if let PartDefBody::Brace { elements } = &p.body {
                for child in elements {
                    collect_definition_range_part_def_body(child, out);
                }
            }
        }
        PBE::PartUsage(p) => {
            out.push((p.name.clone(), span_to_range(&p.span)));
            if let PartUsageBody::Brace { elements } = &p.body {
                for child in elements {
                    collect_definition_range_part_usage_body(child, out);
                }
            }
        }
        PBE::PortDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name, span_to_range(&p.span)));
            }
            if let PortDefBody::Brace { elements } = &p.body {
                for child in elements {
                    collect_definition_range_port_def_body(child, out);
                }
            }
        }
        PBE::InterfaceDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name, span_to_range(&p.span)));
            }
        }
        PBE::AttributeDef(p) => {
            out.push((p.name.clone(), span_to_range(&p.span)));
        }
        PBE::ActionDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name, span_to_range(&p.span)));
            }
        }
        PBE::ActionUsage(p) => {
            out.push((p.name.clone(), span_to_range(&p.span)));
        }
        PBE::Import(_) | PBE::AliasDef(_) => {}
        _ => {}
    }
}

fn collect_definition_range_part_def_body(
    node: &sysml_parser::Node<PartDefBodyElement>,
    out: &mut Vec<(String, Range)>,
) {
    use sysml_parser::ast::PartDefBodyElement as PDBE;
    match &node.value {
        PDBE::AttributeDef(n) => out.push((n.name.clone(), span_to_range(&n.span))),
        PDBE::PortUsage(n) => out.push((n.name.clone(), span_to_range(&n.span))),
        _ => {}
    }
}

fn collect_definition_range_part_usage_body(
    node: &sysml_parser::Node<PartUsageBodyElement>,
    out: &mut Vec<(String, Range)>,
) {
    use sysml_parser::ast::PartUsageBodyElement as PUBE;
    match &node.value {
        PUBE::AttributeUsage(n) => out.push((n.name.clone(), span_to_range(&n.span))),
        PUBE::PartUsage(n) => {
            out.push((n.name.clone(), span_to_range(&n.span)));
            if let PartUsageBody::Brace { elements } = &n.body {
                for child in elements {
                    collect_definition_range_part_usage_body(child, out);
                }
            }
        }
        PUBE::PortUsage(n) => out.push((n.name.clone(), span_to_range(&n.span))),
        _ => {}
    }
}

fn collect_definition_range_port_def_body(
    node: &sysml_parser::Node<PortDefBodyElement>,
    out: &mut Vec<(String, Range)>,
) {
    use sysml_parser::ast::PortDefBodyElement as PDBE;
    match &node.value {
        PDBE::PortUsage(n) => out.push((n.name.clone(), span_to_range(&n.span))),
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

/// Relationship for sysml/model (connection, flow, specializes, bind, allocate).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ModelRelationship {
    pub rel_type: String,
    pub source: String,
    pub target: String,
    pub name: Option<String>,
}

/// Model element with attributes for sysml/model response (richer than DocumentSymbol).
#[derive(Debug, Clone)]
pub struct ModelElement {
    pub element_type: String,
    pub name: String,
    pub range: Range,
    pub children: Vec<ModelElement>,
    pub attributes: std::collections::HashMap<String, serde_json::Value>,
}

/// Collects relationships (connection, bind, allocate, specializes) from the AST.
#[allow(dead_code)]
pub fn collect_relationships(_root: &RootNamespace) -> Vec<ModelRelationship> {
    vec![]
}

/// Collects model elements with attributes for sysml/model (partType, portType, multiplicity, etc.).
#[allow(dead_code)]
pub fn collect_model_elements(_root: &RootNamespace) -> Vec<ModelElement> {
    vec![]
}

/// Collects document symbols (outline) from the AST.
pub fn collect_document_symbols(root: &RootNamespace) -> Vec<DocumentSymbol> {
    let mut out = Vec::new();
    for node in &root.elements {
        let sym = match &node.value {
            RootElement::Package(p) => {
                let name = identification_name(&p.identification);
                let name = if name.is_empty() {
                    "(top level)".to_string()
                } else {
                    name
                };
                let range = span_to_range(&p.span);
                let children = match &p.body {
                    PackageBody::Brace { elements } => {
                        elements.iter().filter_map(document_symbol_from_element).collect()
                    }
                    _ => vec![],
                };
                Some(DocumentSymbol {
                    name,
                    detail: Some("package".to_string()),
                    kind: SymbolKind::MODULE,
                    tags: None,
                    deprecated: None,
                    range,
                    selection_range: range,
                    children: Some(children),
                })
            }
            RootElement::Namespace(n) => {
                let name = identification_name(&n.identification);
                let name = if name.is_empty() {
                    "(top level)".to_string()
                } else {
                    name
                };
                let range = span_to_range(&n.span);
                let children = match &n.body {
                    PackageBody::Brace { elements } => {
                        elements.iter().filter_map(document_symbol_from_element).collect()
                    }
                    _ => vec![],
                };
                Some(DocumentSymbol {
                    name,
                    detail: Some("namespace".to_string()),
                    kind: SymbolKind::MODULE,
                    tags: None,
                    deprecated: None,
                    range,
                    selection_range: range,
                    children: Some(children),
                })
            }
        };
        if let Some(s) = sym {
            out.push(s);
        }
    }
    out
}

/// Collects folding ranges from the AST. This reuses the document-symbol outline ranges and
/// produces one folding range per symbol whose extent spans multiple lines.
pub fn collect_folding_ranges(root: &RootNamespace) -> Vec<FoldingRange> {
    let symbols = collect_document_symbols(root);
    let mut out = Vec::new();

    fn push_symbol(symbol: &DocumentSymbol, out: &mut Vec<FoldingRange>) {
        let start = symbol.range.start.line;
        let end = symbol.range.end.line;
        if end > start {
            out.push(FoldingRange {
                start_line: start,
                start_character: None,
                end_line: end,
                end_character: None,
                kind: Some(FoldingRangeKind::Region),
                collapsed_text: None,
            });
        }
        if let Some(children) = symbol.children.as_ref() {
            for c in children {
                push_symbol(c, out);
            }
        }
    }

    for s in &symbols {
        push_symbol(s, &mut out);
    }

    out
}

/// Flattens document symbols into workspace symbol list with the given file URI.
#[allow(dead_code)]
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
#[allow(dead_code)]
pub(crate) fn format_multiplicity(s: Option<&str>) -> String {
    s.unwrap_or("[*]").to_string()
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
#[allow(dead_code)]
pub fn collect_symbol_entries(_root: &RootNamespace, _uri: &Url) -> Vec<SymbolEntry> {
    vec![]
}

#[allow(dead_code)]
fn _symbol_entries_stub() {}

#[allow(dead_code)]
fn _symbol_entries_from_member_removed(
    _member: &std::marker::PhantomData<()>,
    _uri: &Url,
    _container: Option<&str>,
    _out: &mut Vec<SymbolEntry>,
) {
}

fn document_symbol_from_element(node: &sysml_parser::Node<PackageBodyElement>) -> Option<DocumentSymbol> {
    use sysml_parser::ast::PackageBodyElement as PBE;
    let range = span_to_range(&node.span);
    match &node.value {
        PBE::Package(p) => {
            let name = identification_name(&p.identification);
            let name = if name.is_empty() { "(top level)".to_string() } else { name };
            let children = match &p.body {
                PackageBody::Brace { elements } => elements.iter().filter_map(document_symbol_from_element).collect(),
                _ => vec![],
            };
            Some(DocumentSymbol {
                name,
                detail: Some("package".to_string()),
                kind: SymbolKind::MODULE,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        PBE::PartDef(p) => {
            let name = identification_name(&p.identification);
            if name.is_empty() {
                return None;
            }
            let children = match &p.body {
                PartDefBody::Brace { elements } => document_symbols_from_part_def_body(elements),
                _ => vec![],
            };
            Some(DocumentSymbol {
                name,
                detail: Some("part def".to_string()),
                kind: SymbolKind::CLASS,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        PBE::PartUsage(p) => {
            let children = match &p.body {
                PartUsageBody::Brace { elements } => document_symbols_from_part_usage_body(elements),
                _ => vec![],
            };
            Some(DocumentSymbol {
                name: p.name.clone(),
                detail: Some("part".to_string()),
                kind: SymbolKind::VARIABLE,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        PBE::PortDef(p) => {
            let name = identification_name(&p.identification);
            if name.is_empty() {
                return None;
            }
            let children = match &p.body {
                PortDefBody::Brace { elements } => document_symbols_from_port_def_body(elements),
                _ => vec![],
            };
            Some(DocumentSymbol {
                name,
                detail: Some("port def".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: if children.is_empty() { None } else { Some(children) },
            })
        }
        PBE::InterfaceDef(p) => {
            let name = identification_name(&p.identification);
            if name.is_empty() {
                return None;
            }
            Some(DocumentSymbol {
                name,
                detail: Some("interface".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: None,
            })
        }
        PBE::AttributeDef(p) => Some(DocumentSymbol {
            name: p.name.clone(),
            detail: Some("attribute def".to_string()),
            kind: SymbolKind::PROPERTY,
            tags: None,
            deprecated: None,
            range,
            selection_range: range,
            children: None,
        }),
        PBE::ActionDef(p) => {
            let name = identification_name(&p.identification);
            if name.is_empty() {
                return None;
            }
            Some(DocumentSymbol {
                name,
                detail: Some("action def".to_string()),
                kind: SymbolKind::FUNCTION,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: None,
            })
        }
        PBE::ActionUsage(p) => Some(DocumentSymbol {
            name: p.name.clone(),
            detail: Some("action".to_string()),
            kind: SymbolKind::FUNCTION,
            tags: None,
            deprecated: None,
            range,
            selection_range: range,
            children: None,
        }),
        PBE::Import(_) | PBE::AliasDef(_) => None,
        _ => None,
    }
}

fn document_symbols_from_part_def_body(elements: &[sysml_parser::Node<PartDefBodyElement>]) -> Vec<DocumentSymbol> {
    let mut out = Vec::new();
    for node in elements {
        use sysml_parser::ast::PartDefBodyElement as PDBE;
        let range = span_to_range(&node.span);
        match &node.value {
            PDBE::AttributeDef(n) => out.push(DocumentSymbol {
                name: n.name.clone(),
                detail: Some("attribute def".to_string()),
                kind: SymbolKind::PROPERTY,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: None,
            }),
            PDBE::PortUsage(n) => out.push(DocumentSymbol {
                name: n.name.clone(),
                detail: Some("port".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: None,
            }),
            _ => {}
        }
    }
    out
}

fn document_symbols_from_part_usage_body(elements: &[sysml_parser::Node<PartUsageBodyElement>]) -> Vec<DocumentSymbol> {
    let mut out = Vec::new();
    for node in elements {
        use sysml_parser::ast::PartUsageBodyElement as PUBE;
        let range = span_to_range(&node.span);
        match &node.value {
            PUBE::AttributeUsage(n) => out.push(DocumentSymbol {
                name: n.name.clone(),
                detail: Some("attribute".to_string()),
                kind: SymbolKind::PROPERTY,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: None,
            }),
            PUBE::PartUsage(n) => {
                let children = match &n.body {
                    PartUsageBody::Brace { elements } => document_symbols_from_part_usage_body(elements),
                    _ => vec![],
                };
                out.push(DocumentSymbol {
                    name: n.name.clone(),
                    detail: Some("part".to_string()),
                    kind: SymbolKind::VARIABLE,
                    tags: None,
                    deprecated: None,
                    range,
                    selection_range: range,
                    children: if children.is_empty() { None } else { Some(children) },
                });
            }
            PUBE::PortUsage(n) => out.push(DocumentSymbol {
                name: n.name.clone(),
                detail: Some("port".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: None,
            }),
            _ => {}
        }
    }
    out
}

fn document_symbols_from_port_def_body(elements: &[sysml_parser::Node<PortDefBodyElement>]) -> Vec<DocumentSymbol> {
    let mut out = Vec::new();
    for node in elements {
        use sysml_parser::ast::PortDefBodyElement as PDBE;
        let range = span_to_range(&node.span);
        match &node.value {
            PDBE::PortUsage(n) => out.push(DocumentSymbol {
                name: n.name.clone(),
                detail: Some("port".to_string()),
                kind: SymbolKind::INTERFACE,
                tags: None,
                deprecated: None,
                range,
                selection_range: range,
                children: None,
            }),
            _ => {}
        }
    }
    out
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
    let root = sysml_parser::parse(source).ok()?;
    let packages: Vec<_> = root
        .elements
        .iter()
        .filter_map(|n| match &n.value {
            RootElement::Package(p) => Some(p),
            _ => None,
        })
        .collect();
    if packages.len() != 1 {
        return None;
    }
    let pkg = packages[0];
    if !identification_name(&pkg.identification).is_empty() {
        return None;
    }
    let has_members = match &pkg.body {
        PackageBody::Brace { elements } => !elements.is_empty(),
        _ => false,
    };
    if !has_members {
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
#[allow(dead_code)]
pub fn collect_named_elements(root: &RootNamespace) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for node in &root.elements {
        let (name, elements) = match &node.value {
            RootElement::Package(p) => {
                let name = identification_name(&p.identification);
                let elements = match &p.body {
                    PackageBody::Brace { elements } => elements,
                    _ => continue,
                };
                (name, elements)
            }
            RootElement::Namespace(n) => {
                let name = identification_name(&n.identification);
                let elements = match &n.body {
                    PackageBody::Brace { elements } => elements,
                    _ => continue,
                };
                (name, elements)
            }
        };
        if !name.is_empty() {
            out.push((name.clone(), format!("package '{}'", name)));
        }
        for el in elements {
            collect_named_from_element(el, &mut out);
        }
    }
    out
}

fn collect_named_from_element(node: &sysml_parser::Node<PackageBodyElement>, out: &mut Vec<(String, String)>) {
    use sysml_parser::ast::PackageBodyElement as PBE;
    match &node.value {
        PBE::Package(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name.clone(), format!("package '{}'", name)));
            }
            if let PackageBody::Brace { elements } = &p.body {
                for child in elements {
                    collect_named_from_element(child, out);
                }
            }
        }
        PBE::PartDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name.clone(), format!("part def '{}'", name)));
            }
            if let PartDefBody::Brace { elements } = &p.body {
                for child in elements {
                    collect_named_from_part_def_body(child, out);
                }
            }
        }
        PBE::PartUsage(p) => {
            out.push((p.name.clone(), format!("part usage '{}'", p.name)));
            if let PartUsageBody::Brace { elements } = &p.body {
                for child in elements {
                    collect_named_from_part_usage_body(child, out);
                }
            }
        }
        PBE::PortDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name.clone(), format!("port def '{}'", name)));
            }
        }
        PBE::InterfaceDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name.clone(), format!("interface def '{}'", name)));
            }
        }
        PBE::AttributeDef(p) => out.push((p.name.clone(), format!("attribute def '{}'", p.name))),
        PBE::ActionDef(p) => {
            let name = identification_name(&p.identification);
            if !name.is_empty() {
                out.push((name.clone(), format!("action def '{}'", name)));
            }
        }
        PBE::ActionUsage(p) => out.push((p.name.clone(), format!("action usage '{}'", p.name))),
        PBE::Import(_) | PBE::AliasDef(_) => {}
        _ => {}
    }
}

fn collect_named_from_part_def_body(node: &sysml_parser::Node<PartDefBodyElement>, out: &mut Vec<(String, String)>) {
    use sysml_parser::ast::PartDefBodyElement as PDBE;
    match &node.value {
        PDBE::AttributeDef(n) => out.push((n.name.clone(), format!("attribute def '{}'", n.name))),
        PDBE::PortUsage(n) => out.push((n.name.clone(), format!("port usage '{}'", n.name))),
        _ => {}
    }
}

fn collect_named_from_part_usage_body(node: &sysml_parser::Node<PartUsageBodyElement>, out: &mut Vec<(String, String)>) {
    use sysml_parser::ast::PartUsageBodyElement as PUBE;
    match &node.value {
        PUBE::AttributeUsage(n) => out.push((n.name.clone(), format!("attribute '{}'", n.name))),
        PUBE::PartUsage(n) => {
            out.push((n.name.clone(), format!("part usage '{}'", n.name)));
            if let PartUsageBody::Brace { elements } = &n.body {
                for child in elements {
                    collect_named_from_part_usage_body(child, out);
                }
            }
        }
        PUBE::PortUsage(n) => out.push((n.name.clone(), format!("port '{}'", n.name))),
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
    fn test_position_to_byte_offset_multibyte_utf8() {
        // "café" = c,a,f,é = 4 chars, 5 bytes (é is 2 bytes)
        let text = "café\n";
        assert_eq!(position_to_byte_offset(text, 0, 0), Some(0));
        assert_eq!(position_to_byte_offset(text, 0, 3), Some(3));
        assert_eq!(position_to_byte_offset(text, 0, 4), Some(5));
        assert_eq!(position_to_byte_offset(text, 0, 5), None);
        // Japanese: 日本 = 2 chars, 6 bytes
        let text2 = "日本\n";
        assert_eq!(position_to_byte_offset(text2, 0, 2), Some(6));
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
    fn test_word_at_position_non_ascii() {
        let text = "part café : String";
        let (_, _, _, w) = word_at_position(text, 0, 6).unwrap();
        assert_eq!(w, "café");
        let text2 = "part 部品 : Type";
        let (_, _, _, w2) = word_at_position(text2, 0, 6).unwrap();
        assert_eq!(w2, "部品");
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
    fn test_completion_prefix_multibyte() {
        assert_eq!(completion_prefix("  café "), "café");
        assert_eq!(completion_prefix("part 部品 "), "部品");
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
    fn test_sysml_keywords_subset_of_reserved() {
        for kw in sysml_keywords() {
            assert!(
                is_reserved_keyword(kw),
                "sysml_keywords() must only contain reserved keywords; '{}' is not reserved",
                kw
            );
        }
    }

    #[test]
    fn test_position_not_reserved() {
        assert!(!is_reserved_keyword("position"));
    }

    #[test]
    fn test_collect_named_elements_empty() {
        let root = RootNamespace { elements: vec![] };
        let el = collect_named_elements(&root);
        assert!(el.is_empty());
    }

    #[test]
    fn test_collect_named_elements_from_package() {
        let text = "package P { part def Engine { } }";
        let root = sysml_parser::parse(text).expect("parse");
        let el = collect_named_elements(&root);
        assert_eq!(el.len(), 2); // package P + part Engine
        let names: Vec<_> = el.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"P"));
        assert!(names.contains(&"Engine"));
    }

    #[test]
    fn test_source_position_to_range() {
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
        let root = RootNamespace { elements: vec![] };
        let ranges = collect_definition_ranges(&root);
        assert!(ranges.is_empty());
    }

    #[test]
    fn test_collect_definition_ranges_package() {
        let text = "package P { }";
        let root = sysml_parser::parse(text).expect("parse");
        let ranges = collect_definition_ranges(&root);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].0, "P");
    }

    #[test]
    fn test_collect_definition_ranges_part_def() {
        // sysml-parser requires package/namespace at root; part def must be nested
        let text = "package P { part def Engine { } }";
        let root = sysml_parser::parse(text).expect("parse");
        let ranges = collect_definition_ranges(&root);
        assert_eq!(ranges.len(), 2); // package P + part Engine
        assert_eq!(ranges[0].0, "P");
        assert_eq!(ranges[1].0, "Engine");
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
        let root = RootNamespace { elements: vec![] };
        let symbols = collect_document_symbols(&root);
        assert!(symbols.is_empty());
    }

    #[test]
    fn test_collect_document_symbols_package() {
        let text = "package P { }";
        let root = sysml_parser::parse(text).expect("parse");
        let symbols = collect_document_symbols(&root);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "P");
        assert_eq!(symbols[0].detail.as_deref(), Some("package"));
        assert_eq!(symbols[0].kind, SymbolKind::MODULE);
    }

    #[test]
    fn test_collect_document_symbols_nested() {
        let text = "package P { part def Engine { } }";
        let root = sysml_parser::parse(text).expect("parse");
        let symbols = collect_document_symbols(&root);
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
        let root = RootNamespace { elements: vec![] };
        let uri = Url::parse("file:///test.sysml").unwrap();
        let entries = collect_symbol_entries(&root, &uri);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_collect_symbol_entries_package() {
        let text = "package P { }";
        let root = sysml_parser::parse(text).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let entries = collect_symbol_entries(&root, &uri);
        // collect_symbol_entries is currently stubbed (returns empty)
        assert!(entries.is_empty());
    }

    #[test]
    fn test_collect_symbol_entries_nested() {
        let text = "package P { part def Engine { } }";
        let root = sysml_parser::parse(text).expect("parse");
        let uri = Url::parse("file:///test.sysml").unwrap();
        let entries = collect_symbol_entries(&root, &uri);
        // collect_symbol_entries is currently stubbed (returns empty)
        assert!(entries.is_empty());
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
        // When source is a single top-level part def, sysml-parser may parse it as one anonymous package
        // with one member, in which case we suggest "Wrap in package".
        let source = "part def X { }";
        if let Some(action) = suggest_wrap_in_package(source, &uri) {
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
            assert!(text_edit.new_text.contains("package Generated"));
            assert!(text_edit.new_text.contains("part def X"));
        }
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
        let root = sysml_parser::parse(&content).expect("parse");
        let uri = Url::from_file_path(&path).unwrap_or_else(|_| Url::parse("file:///VehicleDefinitions.sysml").unwrap());

        // Semantic tokens (using server's ast_semantic_ranges)
        let ranges = crate::semantic_tokens::ast_semantic_ranges(&root);
        let target_dir = std::env::var_os("CARGO_TARGET_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target"));
        let _ = std::fs::create_dir_all(&target_dir);
        let tokens_path = target_dir.join("semantic_tokens_vehicle_definitions.txt");
        write_semantic_ranges_for_review(&content, &ranges, &tokens_path);

        // Symbol table (stubbed collect_symbol_entries returns empty)
        let entries = collect_symbol_entries(&root, &uri);
        let table_path = target_dir.join("symbol_table_vehicle_definitions.txt");
        write_symbol_table_for_review(&entries, &table_path);
    }

    #[cfg(test)]
    fn range_text_from_source(source: &str, r: &crate::ast_util::SourceRange) -> String {
        let lines: Vec<&str> = source.lines().collect();
        let line = match lines.get(r.start_line as usize) {
            Some(l) => l,
            None => return String::new(),
        };
        let start = r.start_character as usize;
        let end = r.end_character as usize;
        let n_chars = line.chars().count();
        if start >= n_chars || end > n_chars || start >= end {
            return String::new();
        }
        line.chars().skip(start).take(end - start).collect()
    }

    #[cfg(test)]
    fn write_semantic_ranges_for_review(
        source: &str,
        ranges: &[(crate::ast_util::SourceRange, u32)],
        out_path: &std::path::Path,
    ) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::File::create(out_path) {
            let _ = writeln!(f, "# Semantic token ranges (line/char 0-based, type index)\n");
            for (r, type_index) in ranges {
                let text = range_text_from_source(source, r);
                let text_escaped = text.replace('\n', "\\n").replace('\r', "\\r");
                let _ = writeln!(
                    f,
                    "{}:{}..{}:{} type_index={} \"{}\"",
                    r.start_line,
                    r.start_character,
                    r.end_line,
                    r.end_character,
                    type_index,
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
