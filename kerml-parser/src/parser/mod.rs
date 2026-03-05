//! Pest-based parser for SysML v2 grammar.
//!
//! Parses input via the `document` rule in the Pest grammar, then walks
//! pairs to build the AST (packages, members, etc.). Source positions are converted
//! from byte offsets to line/character for LSP and diagnostics.

use pest::Parser;
use pest::iterators::{Pair, Pairs};
use pest::error::LineColLocation;
use crate::error::{ParseError, Result};
use crate::ast::*;
use log::{debug, trace};
use std::collections::HashMap;

mod span;
mod expr;
mod statements;
use span::{span_to_position, span_to_source_range};
use expr::{parse_expression, parse_multiplicity_str};
use statements::{parse_allocate_statement, parse_bind_statement, parse_provides_statement, parse_requires_statement};

#[derive(pest_derive::Parser)]
#[grammar = "grammar.pest"]
pub struct SysMLParser;

/// Parses SysML v2 source text into a [SysMLDocument](crate::ast::SysMLDocument) AST.
pub fn parse_sysml(input: &str) -> Result<SysMLDocument> {
    let mut pairs = SysMLParser::parse(Rule::document, input).map_err(|e| {
        let msg = format!("{}", e);
        let pos = match &e.line_col {
            LineColLocation::Pos((line, col)) | LineColLocation::Span((line, col), _) => {
                Some(((line.saturating_sub(1)) as u32, (col.saturating_sub(1)) as u32))
            }
        };
        ParseError::PestError(msg, pos)
    })?;
    
    // Get the inner pairs of the document rule
    if let Some(document_pair) = pairs.next() {
        parse_document(document_pair.into_inner(), input)
    } else {
        Err(ParseError::Message("Empty document".to_string()))
    }
}

/// Maximum number of parse errors to collect when using error recovery.
const MAX_COLLECTED_ERRORS: usize = 20;

/// Parses SysML and collects multiple parse errors by masking error regions and re-parsing.
/// Returns `(Ok(doc), [])` if parse succeeds, otherwise `(Err(..), errors)` with at least one error.
/// Pest stops at the first error, so we mask from the error position to end of line and re-parse
/// to discover further errors.
pub fn parse_sysml_collect_errors(input: &str) -> (Result<SysMLDocument>, Vec<ParseError>) {
    let mut errors = Vec::new();
    let mut current = input.to_string();
    let mut last_pos: Option<(u32, u32)> = None;

    loop {
        match parse_sysml(&current) {
            Ok(doc) => {
                return (
                    if errors.is_empty() {
                        Ok(doc)
                    } else {
                        Err(ParseError::Message("Parse failed".to_string()))
                    },
                    errors,
                );
            }
            Err(e) => {
                let mut current_error = Some(e);
                let pos = current_error.as_ref().and_then(ParseError::position);
                if errors.len() >= MAX_COLLECTED_ERRORS {
                    errors.push(current_error.take().unwrap());
                    return (
                        Err(ParseError::Message("Parse failed".to_string())),
                        errors,
                    );
                }
                if let Some((line, col)) = pos {
                    if last_pos == Some((line, col)) {
                        errors.push(current_error.take().unwrap());
                        return (
                            Err(ParseError::Message("Parse failed".to_string())),
                            errors,
                        );
                    }
                    last_pos = Some((line, col));
                    errors.push(current_error.take().unwrap());
                    if let Some((_line_start, line_end)) = span::line_byte_range(&current, line) {
                        if let Some(off) = span::line_char_to_byte_offset(&current, line, col) {
                            let mask_start = off.min(line_end);
                            if mask_start < line_end {
                                let len = line_end - mask_start;
                                let replacement = " ".repeat(len);
                                current = format!(
                                    "{}{}{}",
                                    &current[..mask_start],
                                    replacement,
                                    &current[line_end..]
                                );
                                continue;
                            }
                        }
                    }
                }
                if let Some(e) = current_error {
                    errors.push(e);
                }
                return (
                    Err(ParseError::Message("Parse failed".to_string())),
                    errors,
                );
            }
        }
    }
}

fn parse_document(pairs: Pairs<'_, Rule>, source: &str) -> Result<SysMLDocument> {
    let mut imports = Vec::new();
    let mut packages = Vec::new();
    let mut top_level_members = Vec::new();
    
    // Track metadata annotations that appear before top-level members
    let mut pending_metadata: Vec<MetadataAnnotation> = Vec::new();
    
    let all_pairs: Vec<_> = pairs.collect();
    
    for pair in all_pairs.iter() {
        match pair.as_rule() {
            Rule::import_statement => {
                match parse_import(pair.clone().into_inner(), source) {
                    Ok(import) => imports.push(import),
                    Err(e) => return Err(e),
                }
            }
            Rule::package => {
                let span = pair.as_span();
                match parse_package(pair.clone().into_inner(), source, span) {
                    Ok(pkg) => packages.push(pkg),
                    Err(e) => return Err(e),
                }
            }
            Rule::metadata_annotation => {
                // Collect metadata annotations that appear before top-level members
                if let Ok(meta) = parse_metadata_annotation(pair.clone()) {
                    let meta_name = meta.name.clone();
                    pending_metadata.push(meta);
                    debug!("parse_document: Collected metadata annotation: {}", meta_name);
                }
            }
            Rule::member => {
                // Support top-level members (Elan8 structure without packages)
                match parse_member(pair.clone().into_inner(), source) {
                    Ok(mut member) => {
                        // Attach pending metadata to the member
                        match &mut member {
                            Member::PartUsage(ref mut pu) => {
                                let mut combined = pending_metadata.clone();
                                combined.append(&mut pu.metadata);
                                pu.metadata = combined;
                            }
                            Member::PartDef(ref mut pd) => {
                                let mut combined = pending_metadata.clone();
                                combined.append(&mut pd.metadata);
                                pd.metadata = combined;
            }
            _ => {}
        }
                        pending_metadata.clear();
                        top_level_members.push(member);
                    },
                    Err(e) => return Err(e),
                }
            }
            Rule::part_usage => {
                let span = pair.as_span();
                match parse_part_usage(pair.clone().into_inner(), source, span) {
                    Ok(mut part_usage) => {
                        let mut combined = pending_metadata.clone();
                        combined.append(&mut part_usage.metadata);
                        part_usage.metadata = combined;
                        pending_metadata.clear();
                        top_level_members.push(Member::PartUsage(part_usage));
                    },
                    Err(e) => return Err(e),
                }
            }
            Rule::part_def => {
                let span = pair.as_span();
                match parse_part_def(pair.clone().into_inner(), source, span) {
                    Ok(mut part_def) => {
                        let mut combined = pending_metadata.clone();
                        combined.append(&mut part_def.metadata);
                        part_def.metadata = combined;
                        pending_metadata.clear();
                        top_level_members.push(Member::PartDef(part_def));
                    },
                    Err(e) => return Err(e),
                }
            }
            Rule::allocate_statement => {
                match parse_allocate_statement(pair.clone().into_inner(), source) {
                    Ok(stmt) => {
                        pending_metadata.clear();
                        top_level_members.push(Member::AllocateStatement(stmt));
                    },
                    Err(e) => return Err(e),
                }
            }
            _ => {}
        }
    }
    
    // If we have top-level members but no packages, create a dummy package
    // This is a workaround for Elan8 structure (files without packages)
    if !top_level_members.is_empty() && packages.is_empty() {
        packages.push(Package {
            name: "".to_string(), // Empty name indicates top-level members
            name_position: None,
            range: None,
            is_library: false,
            imports: Vec::new(),
            members: top_level_members,
        });
    }
    
    Ok(SysMLDocument { imports, packages })
}

fn parse_import(pairs: Pairs<'_, Rule>, source: &str) -> Result<Import> {
    let mut visibility = None;
    let mut path = String::new();
    let mut wildcard = false;
    let mut path_first_segment_position = None;

    for pair in pairs {
        match pair.as_rule() {
            Rule::name | Rule::qualified_name | Rule::identifier => {
                let path_str = pair.as_str().trim_matches('\'').trim_matches('"');
                path = path_str.to_string();
                // First segment is the package/namespace (e.g. "SI" in "SI::N", "ScalarFunctions" in "ScalarFunctions::*")
                let first_segment_len: u32 = path_str
                    .find("::")
                    .map(|byte_i| path_str[..byte_i].chars().count())
                    .unwrap_or_else(|| path_str.chars().count()) as u32;
                let pos = span_to_position(pair.as_span(), source);
                path_first_segment_position = Some(SourcePosition {
                    line: pos.line,
                    character: pos.character,
                    length: first_segment_len,
                });
            }
            Rule::string_literal => {
                let raw = pair.as_str();
                let path_str = raw.trim_matches('"').trim_matches('\'');
                path = path_str.to_string();
                let first_segment_len: u32 = path_str
                    .find("::")
                    .map(|byte_i| path_str[..byte_i].chars().count())
                    .unwrap_or_else(|| path_str.chars().count()) as u32;
                let pos = span_to_position(pair.as_span(), source);
                // Content starts after the opening quote
                let content_start = pos.character + 1;
                path_first_segment_position = Some(SourcePosition {
                    line: pos.line,
                    character: content_start,
                    length: first_segment_len,
                });
            }
            _ => {
                let text = pair.as_str();
                if text == "public" {
                    visibility = Some(Visibility::Public);
                } else if text == "private" {
                    visibility = Some(Visibility::Private);
                } else if text.contains("::*") {
                    wildcard = true;
                }
            }
        }
    }

    Ok(Import {
        visibility,
        path,
        wildcard,
        path_first_segment_position,
    })
}

/// Mutable state used when parsing a package (name, imports, members, etc.).
struct PackageParseState<'a> {
    name: String,
    name_position: Option<SourcePosition>,
    is_library: bool,
    seen_standard: bool,
    seen_library: bool,
    pending_metadata: Vec<MetadataAnnotation>,
    imports: Vec<Import>,
    members: Vec<Member>,
    source: &'a str,
}

fn process_package_pair(
    pair: &Pair<'_, Rule>,
    state: &mut PackageParseState<'_>,
) -> Result<()> {
    let rule = pair.as_rule();
    let text = pair.as_str();
    let source = state.source;

    match rule {
        Rule::package_name | Rule::name | Rule::qualified_name | Rule::identifier | Rule::string_literal => {
            if state.name.is_empty() {
                state.name = pair.as_str().trim_matches('\'').trim_matches('"').to_string();
                state.name_position = Some(span_to_position(pair.as_span(), source));
                debug!("parse_package: Set package name to: {}", state.name);
                if state.seen_standard || state.seen_library {
                    state.is_library = true;
                }
            }
        }
        Rule::import_statement => {
            match parse_import(pair.clone().into_inner(), source) {
                Ok(import) => state.imports.push(import),
                Err(e) => return Err(e),
            }
        }
        Rule::member => {
            match parse_member(pair.clone().into_inner(), source) {
                Ok(member) => state.members.push(member),
                Err(e) => return Err(e),
            }
        }
        Rule::part_def => {
            let member_span = pair.as_span();
            match parse_part_def(pair.clone().into_inner(), source, member_span) {
                Ok(mut part_def) => {
                    let mut combined = state.pending_metadata.clone();
                    combined.append(&mut part_def.metadata);
                    part_def.metadata = combined;
                    state.pending_metadata.clear();
                    state.members.push(Member::PartDef(part_def));
                }
                Err(e) => return Err(e),
            }
        }
        Rule::part_usage => {
            let member_span = pair.as_span();
            match parse_part_usage(pair.clone().into_inner(), source, member_span) {
                Ok(mut part_usage) => {
                    let mut combined = state.pending_metadata.clone();
                    combined.append(&mut part_usage.metadata);
                    part_usage.metadata = combined;
                    state.pending_metadata.clear();
                    state.members.push(Member::PartUsage(part_usage));
                }
                Err(e) => return Err(e),
            }
        }
        Rule::requirement_def => {
            let requirement_def_full_text = pair.as_str();
            let member_span = pair.as_span();
            match parse_requirement_def(pair.clone().into_inner(), requirement_def_full_text, source, member_span) {
                Ok(req_def) => state.members.push(Member::RequirementDef(req_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::requirement_usage => {
            let member_span = pair.as_span();
            match parse_requirement_usage(pair.clone().into_inner(), source, member_span) {
                Ok(req_usage) => state.members.push(Member::RequirementUsage(req_usage)),
                Err(e) => return Err(e),
            }
        }
        Rule::action_def => {
            let member_span = pair.as_span();
            match parse_action_def(pair.clone().into_inner(), source, member_span) {
                Ok(action_def) => state.members.push(Member::ActionDef(action_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::connection_usage => {
            let conn_span = pair.as_span();
            match parse_connection_usage(pair.clone().into_inner(), source, conn_span) {
                Ok(conn) => state.members.push(Member::ConnectionUsage(conn)),
                Err(e) => return Err(e),
            }
        }
        Rule::port_def => {
            let member_span = pair.as_span();
            match parse_port_def(pair.clone().into_inner(), source, member_span) {
                Ok(port_def) => state.members.push(Member::PortDef(port_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::interface_def => {
            let member_span = pair.as_span();
            match parse_interface_def(pair.clone().into_inner(), source, member_span) {
                Ok(interface_def) => state.members.push(Member::InterfaceDef(interface_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::COMMENT => {}
        _ => {
            let text_lower = text.to_lowercase();
            if text_lower == "standard" {
                state.seen_standard = true;
            } else if text_lower == "library" {
                state.seen_library = true;
                state.is_library = true;
            }
            // Descend into block: package body is ("{" ~ (COMMENT | import_statement | ... | member)* ~ "}")
            // so member/import pairs are inside a nested sequence; recurse to collect them.
            let inner: Vec<_> = pair.clone().into_inner().collect();
            for inner_pair in &inner {
                process_package_pair(inner_pair, state)?;
            }
        }
    }
    Ok(())
}

fn parse_package(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<Package> {
    let mut state = PackageParseState {
        name: String::new(),
        name_position: None,
        is_library: false,
        seen_standard: false,
        seen_library: false,
        pending_metadata: Vec::new(),
        imports: Vec::new(),
        members: Vec::new(),
        source,
    };

    let all_pairs: Vec<_> = pairs.collect();
    debug!("parse_package: Processing {} top-level pairs", all_pairs.len());

    for (idx, pair) in all_pairs.iter().enumerate() {
        debug!("parse_package: Pair[{}] rule={:?}", idx, pair.as_rule());
        process_package_pair(pair, &mut state)?;
    }

    debug!("parse_package: Final package '{}' has {} members", state.name, state.members.len());

    if state.name.is_empty() {
        return Err(ParseError::Message("Package name is required".to_string()));
    }

    Ok(Package {
        name: state.name,
        name_position: state.name_position,
        range: Some(span_to_source_range(span, source)),
        is_library: state.is_library,
        imports: state.imports,
        members: state.members,
    })
}

fn parse_in_statement(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<InStatement> {
    let mut name = String::new();
    let mut name_position = None;
    let mut specializes = None;
    let mut specializes_position = None;
    let mut type_ref = None;
    let mut type_ref_position = None;
    let mut next_is_specializes = false;
    let mut next_is_type = false;

    fn process_in_statement_pair(
        pair: pest::iterators::Pair<'_, Rule>,
        source: &str,
        name: &mut String,
        name_position: &mut Option<SourcePosition>,
        specializes: &mut Option<String>,
        specializes_position: &mut Option<SourcePosition>,
        type_ref: &mut Option<String>,
        type_ref_position: &mut Option<SourcePosition>,
        next_is_specializes: &mut bool,
        next_is_type: &mut bool,
    ) {
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'').trim_matches('"');
                if name.is_empty() {
                    *name = text.to_string();
                    *name_position = Some(span_to_position(pair.as_span(), source));
                } else if *next_is_specializes {
                    *specializes = Some(text.to_string());
                    *specializes_position = Some(span_to_position(pair.as_span(), source));
                    *next_is_specializes = false;
                } else if *next_is_type {
                    *type_ref = Some(text.to_string());
                    *type_ref_position = Some(span_to_position(pair.as_span(), source));
                    *next_is_type = false;
                }
            }
            _ => {
                let t = pair.as_str();
                if t == ":>" {
                    *next_is_specializes = true;
                } else if t == ":" {
                    *next_is_type = true;
                } else {
                    for inner in pair.into_inner() {
                        process_in_statement_pair(
                            inner, source, name, name_position,
                            specializes, specializes_position,
                            type_ref, type_ref_position,
                            next_is_specializes, next_is_type,
                        );
                    }
                }
            }
        }
    }

    for pair in pairs {
        process_in_statement_pair(
            pair, source,
            &mut name, &mut name_position,
            &mut specializes, &mut specializes_position,
            &mut type_ref, &mut type_ref_position,
            &mut next_is_specializes, &mut next_is_type,
        );
    }

    Ok(InStatement {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        specializes,
        specializes_position,
        type_ref,
        type_ref_position,
    })
}

fn parse_end_statement(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<EndStatement> {
    let mut name = String::new();
    let mut name_position = None;
    let mut type_ref = None;
    let mut type_ref_position = None;
    let mut next_is_type = false;

    fn process_end_statement_pair(
        pair: pest::iterators::Pair<'_, Rule>,
        source: &str,
        name: &mut String,
        name_position: &mut Option<SourcePosition>,
        type_ref: &mut Option<String>,
        type_ref_position: &mut Option<SourcePosition>,
        next_is_type: &mut bool,
    ) {
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'').trim_matches('"');
                if name.is_empty() {
                    *name = text.to_string();
                    *name_position = Some(span_to_position(pair.as_span(), source));
                } else if *next_is_type {
                    *type_ref = Some(text.to_string());
                    *type_ref_position = Some(span_to_position(pair.as_span(), source));
                    *next_is_type = false;
                }
            }
            _ => {
                if pair.as_str() == ":" {
                    *next_is_type = true;
                } else {
                    for inner in pair.into_inner() {
                        process_end_statement_pair(
                            inner, source, name, name_position,
                            type_ref, type_ref_position, next_is_type,
                        );
                    }
                }
            }
        }
    }

    for pair in pairs {
        process_end_statement_pair(
            pair, source,
            &mut name, &mut name_position,
            &mut type_ref, &mut type_ref_position,
            &mut next_is_type,
        );
    }

    Ok(EndStatement {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref,
        type_ref_position,
    })
}

fn parse_member(mut pairs: Pairs<'_, Rule>, source: &str) -> Result<Member> {
    if let Some(pair) = pairs.next() {
        let rule = pair.as_rule();
        let span = pair.as_span();
        trace!("parse_member: Matched rule {:?}, text: {:?}", rule, pair.as_str());
        match rule {
            Rule::part_def => {
                debug!("parse_member: Parsing part_def");
                Ok(Member::PartDef(parse_part_def(pair.into_inner(), source, span)?))
            },
            Rule::part_usage => Ok(Member::PartUsage(parse_part_usage(pair.into_inner(), source, span)?)),
            Rule::attribute_def => Ok(Member::AttributeDef(parse_attribute_def(pair.into_inner(), source, span)?)),
            Rule::attribute_usage => Ok(Member::AttributeUsage(parse_attribute_usage(pair.into_inner(), source, span)?)),
            Rule::port_def => Ok(Member::PortDef(parse_port_def(pair.into_inner(), source, span)?)),
            Rule::port_usage => Ok(Member::PortUsage(parse_port_usage(pair.into_inner(), source, span)?)),
            Rule::connection_usage => Ok(Member::ConnectionUsage(parse_connection_usage(pair.into_inner(), source, span)?)),
            Rule::interface_def => Ok(Member::InterfaceDef(parse_interface_def(pair.into_inner(), source, span)?)),
            Rule::item_def => Ok(Member::ItemDef(parse_item_def(pair.into_inner(), source, span)?)),
            Rule::item_usage => Ok(Member::ItemUsage(parse_item_usage(pair.into_inner(), source, span)?)),
            Rule::ref_item => Ok(Member::ItemUsage(parse_ref_item(pair.into_inner(), source, span)?)),
            Rule::requirement_def => {
                let full_text = pair.as_str();
                Ok(Member::RequirementDef(parse_requirement_def(pair.into_inner(), full_text, source, span)?))
            },
            Rule::requirement_usage => Ok(Member::RequirementUsage(parse_requirement_usage(pair.into_inner(), source, span)?)),
            Rule::requirement_references => Ok(Member::RequirementUsage(parse_requirement_references(pair.into_inner(), source, span)?)),
            Rule::action_def => Ok(Member::ActionDef(parse_action_def(pair.into_inner(), source, span)?)),
            Rule::package => Ok(Member::Package(parse_package(pair.into_inner(), source, span)?)),
            Rule::language_extension => {
                // Language extension like #fmeaspec requirement req1 { ... }
                // Parse the member inside the language extension
                let mut inner = pair.into_inner();
                // Skip the identifier (#fmeaspec), parse the member
                if let Some(member_pair) = inner.nth(1) {
                    parse_member(member_pair.into_inner(), source)
                } else {
                    Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Language extension missing member").into())
                }
            },
            Rule::bind_statement => {
                Ok(Member::BindStatement(parse_bind_statement(pair.into_inner(), source)?))
            }
            Rule::allocate_statement => {
                Ok(Member::AllocateStatement(parse_allocate_statement(pair.into_inner(), source)?))
            }
            Rule::provides_statement => {
                Ok(Member::ProvidesStatement(parse_provides_statement(pair.into_inner(), source)?))
            }
            Rule::requires_statement => {
                Ok(Member::RequiresStatement(parse_requires_statement(pair.into_inner(), source)?))
            }
            Rule::in_statement => Ok(Member::InStatement(parse_in_statement(pair.into_inner(), source, span)?)),
            Rule::end_statement => Ok(Member::EndStatement(parse_end_statement(pair.into_inner(), source, span)?)),
            // These are recognized but not fully parsed yet - just skip them for now
            Rule::flow_statement | Rule::succession_statement | Rule::succession_flow_statement | Rule::assign_statement | Rule::transition_statement |
            Rule::accept_statement | Rule::state_machine_statement | Rule::variation_statement |
            Rule::send_node_statement |
            Rule::state_def | Rule::exhibit_state | Rule::subject_statement |
            Rule::dependency_statement | Rule::occurrence_def | Rule::occurrence_usage |
            Rule::enum_def | Rule::constraint_def | Rule::use_case | Rule::actor_statement |
            Rule::calc_def | Rule::assert_constraint | Rule::perform_action | Rule::value_def |
            Rule::value_usage | Rule::action_usage | Rule::action_statement | Rule::ref_part |
            Rule::ref_statement | Rule::connection_def | Rule::alias_statement | Rule::metadata_def |
            Rule::doc_comment => {
                // Parse doc comment: "doc" ~ COMMENT?
                // The rule is atomic (@{}), so we get the full text including "doc"
                let full_text = pair.as_str();
                // Remove "doc" keyword and whitespace, then extract comment
                let text = if let Some(after_doc) = full_text.strip_prefix("doc") {
                    let comment_text = after_doc.trim();
                    // Remove /* and */ or // and newline
                    if comment_text.starts_with("/*") {
                        comment_text
                            .strip_prefix("/*")
                            .and_then(|s| s.strip_suffix("*/"))
                            .unwrap_or(comment_text)
                            .trim()
                            .to_string()
                    } else if comment_text.starts_with("//") {
                        comment_text
                            .strip_prefix("//")
                            .unwrap_or(comment_text)
                            .trim_end()
                            .to_string()
                    } else {
                        comment_text.trim().to_string()
                    }
                } else {
                    String::new()
                };
                Ok(Member::DocComment(crate::ast::DocComment { text }))
            }
            Rule::view_def | Rule::event_occurrence_statement |
            Rule::require_constraint_statement => {
                // For now, just consume the pairs to allow parsing to continue
                // These will be properly implemented later
                Ok(Member::PartDef(PartDef {
                    metadata: Vec::new(), // Nested part defs don't have metadata at this level
                    name: format!("_unparsed_{:?}", pair.as_rule()),
                    name_position: None,
                    range: None,
                    is_abstract: false,
                    specializes: None,
                    specializes_position: None,
                    type_ref: None,
                    type_ref_position: None,
                    multiplicity: None,
                    ordered: false,
                    members: Vec::new(),
                }))
            }
            _ => Err(ParseError::Message(format!("Unknown member type: {:?}", pair.as_rule())))
        }
    } else {
        Err(ParseError::Message("Empty member".to_string()))
    }
}

fn parse_part_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<PartDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut is_abstract = false;
    let mut specializes = None;
    let mut specializes_position = None;
    let mut type_ref = None;
    let mut type_ref_position = None;
    let mut multiplicity = None;
    let mut ordered = false;
    let mut members = Vec::new();
    let mut seen_name = false;
    let mut seen_colon = false;
    let mut next_is_specialization = false;
    
    debug!("parse_part_def: Starting to parse");
    let all_pairs: Vec<_> = pairs.collect();
    debug!("parse_part_def: Processing {} pairs", all_pairs.len());
    for (idx, pair) in all_pairs.iter().enumerate() {
        debug!("parse_part_def: Pair[{}] rule={:?}, text={:?}, inner_count={}", idx, pair.as_rule(), pair.as_str(), pair.clone().into_inner().count());
        // Check if this pair has inner pairs that might contain :> sequence
        let inner_pairs: Vec<_> = pair.clone().into_inner().collect();
        if !inner_pairs.is_empty() {
            debug!("parse_part_def: Pair[{}] has {} inner pairs: {:?}", idx, inner_pairs.len(), inner_pairs.iter().map(|p| (p.as_rule(), p.as_str())).collect::<Vec<_>>());
        }
        match pair.as_rule() {
            // name is silent, so we need to match its alternatives: identifier, qualified_name, or string_literal
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if !seen_name {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    seen_name = true;
                    debug!("parse_part_def: Set name to: {}", name);
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_part_def: Set specializes to: {:?}", specializes);
                    next_is_specialization = false;
                } else if seen_colon {
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_part_def: Set type_ref to: {:?}", type_ref);
                    seen_colon = false;
                } else if specializes.is_none() && type_ref.is_none() {
                    // If we see a second identifier after the name and we haven't set specializes or type_ref yet,
                    // and we haven't seen a colon, this is likely the specializes name from the :> pattern
                    // (Pest matches :> name but only exposes the name as a pair, not the :> tokens)
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_part_def: Inferred specializes from second identifier: {:?}", specializes);
                } else {
                    debug!("parse_part_def: Ignoring identifier '{}' (seen_name={}, next_is_specialization={}, seen_colon={}, specializes={:?}, type_ref={:?})", text, seen_name, next_is_specialization, seen_colon, specializes, type_ref);
                }
            }
            Rule::member => {
                if let Ok(member) = parse_member(pair.clone().into_inner(), source) {
                    members.push(member);
                }
            }
            Rule::provides_statement => {
                if let Ok(prov) = parse_provides_statement(pair.clone().into_inner(), source) {
                    members.push(Member::ProvidesStatement(prov));
                }
            }
            Rule::requires_statement => {
                if let Ok(req) = parse_requires_statement(pair.clone().into_inner(), source) {
                    members.push(Member::RequiresStatement(req));
                }
            }
            Rule::part_usage => {
                let inner_span = pair.as_span();
                if let Ok(part_usage) = parse_part_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::PartUsage(part_usage));
                }
            }
            Rule::port_usage => {
                let inner_span = pair.as_span();
                if let Ok(port_usage) = parse_port_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::PortUsage(port_usage));
                }
            }
            Rule::connection_usage => {
                let inner_span = pair.as_span();
                if let Ok(conn_usage) = parse_connection_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::ConnectionUsage(conn_usage));
                }
            }
            Rule::requirement_usage => {
                let inner_span = pair.as_span();
                if let Ok(req_usage) = parse_requirement_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::RequirementUsage(req_usage));
                }
            }
            Rule::attribute_def => {
                let inner_span = pair.as_span();
                if let Ok(attr_def) = parse_attribute_def(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::AttributeDef(attr_def));
                }
            }
            Rule::part_def => {
                let inner_span = pair.as_span();
                if let Ok(nested_part_def) = parse_part_def(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::PartDef(nested_part_def));
                }
            }
            _ => {
                let text = pair.as_str();
                if text == "abstract" {
                    is_abstract = true;
                } else if text == "ordered" {
                    ordered = true;
                } else if text == ":" {
                    // Check if next token is ">" to determine if this is ":>" (specialization) or ":" (type annotation)
                    if let Some(next_pair) = all_pairs.get(idx + 1) {
                        if next_pair.as_str() == ">" {
                            next_is_specialization = true;
                            debug!("parse_part_def: Saw ':>', set next_is_specialization = true");
                        } else {
                            seen_colon = true;
                            debug!("parse_part_def: Saw ':' (not followed by '>'), set seen_colon = true");
                        }
                    } else {
                        seen_colon = true;
                        debug!("parse_part_def: Saw ':' (no next token), set seen_colon = true");
                    }
                } else if text == ">" && idx > 0 && all_pairs.get(idx - 1).map(|p| p.as_str()) == Some(":") {
                    // This ">" is part of ":>", already handled in the ":" case above
                    debug!("parse_part_def: Saw '>' (part of ':>'), already handled");
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                } else {
                    trace!("parse_part_def: Unhandled text in _ branch: {:?}", text);
                }
            }
        }
    }
    
    // Parse metadata annotations
    let mut metadata = Vec::new();
    for pair in all_pairs.iter() {
        if pair.as_rule() == Rule::metadata_annotation {
            if let Ok(meta) = parse_metadata_annotation(pair.clone()) {
                metadata.push(meta);
            }
        }
    }
    
    Ok(PartDef {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        is_abstract,
        specializes,
        specializes_position,
        type_ref,
        type_ref_position,
        multiplicity,
        ordered,
        metadata,
        members,
    })
}

fn parse_part_usage(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<PartUsage> {
    let mut name = None;
    let mut name_position = None;
    let mut specializes = None;
    let mut specializes_position = None;
    let mut type_ref = None;
    let mut type_ref_position = None;
    let mut multiplicity = None;
    let mut ordered = false;
    let mut redefines = None;
    let mut subsets = None;
    let mut value = None;
    let mut members = Vec::new();
    let mut seen_name = false;
    let mut next_is_specialization = false;
    let mut next_is_type = false;
    let mut next_is_redefines = false;
    let mut next_is_subsets = false;
    let mut next_is_value = false;
    
    debug!("parse_part_usage: Starting to parse");
    let all_pairs: Vec<_> = pairs.collect();
    debug!("parse_part_usage: Processing {} pairs", all_pairs.len());
    for (idx, pair) in all_pairs.iter().enumerate() {
        let inner_pairs: Vec<_> = pair.clone().into_inner().collect();
        debug!("parse_part_usage: Pair[{}] rule={:?}, text={:?}, has {} inner pairs", idx, pair.as_rule(), pair.as_str(), inner_pairs.len());
        for (inner_idx, inner_pair) in inner_pairs.iter().enumerate() {
            trace!("parse_part_usage: Pair[{}].Inner[{}] rule={:?}, text={:?}", idx, inner_idx, inner_pair.as_rule(), inner_pair.as_str());
        }
        match pair.as_rule() {
            // name is silent, so we need to match its alternatives: identifier, qualified_name, or string_literal
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if !seen_name {
                    name = Some(text.to_string());
                    name_position = Some(span_to_position(pair.as_span(), source));
                    seen_name = true;
                    debug!("parse_part_usage: Set name to: {:?}", name);
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    next_is_specialization = false;
                } else if next_is_type || (!next_is_redefines && !next_is_subsets && type_ref.is_none()) {
                    // If we've seen the name and no other flags are set, and we haven't set type_ref yet,
                    // then this must be the type_ref (the `:` is consumed by Pest's sequence matching)
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    next_is_type = false;
                    debug!("parse_part_usage: Set type_ref to: {:?}", type_ref);
                } else if next_is_redefines {
                    redefines = Some(text.to_string());
                    next_is_redefines = false;
                } else if next_is_subsets {
                    subsets = Some(text.to_string());
                    next_is_subsets = false;
                }
            }
            Rule::expr_value => {
                if next_is_value {
                    value = parse_expression(pair.clone());
                    next_is_value = false;
                }
            }
            Rule::member => {
                if let Ok(member) = parse_member(pair.clone().into_inner(), source) {
                    members.push(member);
                }
            }
            Rule::provides_statement => {
                if let Ok(prov) = parse_provides_statement(pair.clone().into_inner(), source) {
                    members.push(Member::ProvidesStatement(prov));
                }
            }
            Rule::requires_statement => {
                if let Ok(req) = parse_requires_statement(pair.clone().into_inner(), source) {
                    members.push(Member::RequiresStatement(req));
                }
            }
            Rule::attribute_def => {
                let inner_span = pair.as_span();
                if let Ok(attr_def) = parse_attribute_def(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::AttributeDef(attr_def));
                }
            }
            Rule::part_usage => {
                let inner_span = pair.as_span();
                if let Ok(part_usage) = parse_part_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::PartUsage(part_usage));
                }
            }
            Rule::connection_usage => {
                let inner_span = pair.as_span();
                if let Ok(conn_usage) = parse_connection_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::ConnectionUsage(conn_usage));
                }
            }
            Rule::port_usage => {
                let inner_span = pair.as_span();
                if let Ok(port_usage) = parse_port_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::PortUsage(port_usage));
                }
            }
            _ => {
                let text = pair.as_str();
                trace!("parse_part_usage: Other rule {:?}, text: {:?}", pair.as_rule(), text);
                if text == "ordered" {
                    ordered = true;
                } else if text == ":>" {
                    next_is_specialization = true;
                    trace!("parse_part_usage: Set next_is_specialization = true");
                } else if text == ":" && !next_is_specialization {
                    next_is_type = true;
                    trace!("parse_part_usage: Set next_is_type = true (saw ':')");
                } else if text == "redefines" {
                    next_is_redefines = true;
                } else if text == "subsets" {
                    next_is_subsets = true;
                } else if text == "=" {
                    next_is_value = true;
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                } else {
                    trace!("parse_part_usage: Unhandled text: {:?}", text);
                }
            }
        }
    }
    
    // Parse metadata annotations
    let mut metadata = Vec::new();
    for pair in all_pairs.iter() {
        if pair.as_rule() == Rule::metadata_annotation {
            if let Ok(meta) = parse_metadata_annotation(pair.clone()) {
                metadata.push(meta);
            }
        }
    }
    
    Ok(PartUsage {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        specializes,
        specializes_position,
        type_ref,
        type_ref_position,
        multiplicity,
        ordered,
        redefines,
        subsets,
        value,
        metadata,
        members,
    })
}

/// Parse a metadata annotation (e.g., @Layer(name = "02_SystemContext"))
fn parse_metadata_annotation(pair: Pair<'_, Rule>) -> Result<MetadataAnnotation> {
    let mut inner = pair.into_inner();
    let name_pair = inner.next().ok_or_else(|| ParseError::PestError("Metadata annotation missing name".to_string(), None))?;
    let name = name_pair.as_str().to_string();
    
    let mut attributes = HashMap::new();
    
    // Collect all remaining inner pairs
    let inner_vec: Vec<_> = inner.collect();
    debug!("parse_metadata_annotation: {} has {} inner pairs after name", name, inner_vec.len());
    
    // Check if there's a parenthesized attribute list: @Layer(name = "value") or @style(a = 1, b = "x")
    // Pest gives us: identifier, value, identifier, value, ... (pairs; "=" and "," are not separate)
    let mut i = 0;
    while i + 1 < inner_vec.len() {
        let attr_name_pair = &inner_vec[i];
        let value_pair = &inner_vec[i + 1];
        if attr_name_pair.as_rule() == Rule::identifier {
            let attr_name = attr_name_pair.as_str().trim();
            let value = match value_pair.as_rule() {
                Rule::string_literal | Rule::string => {
                    value_pair.as_str().trim_matches('"').trim_matches('\'').to_string()
                }
                Rule::identifier => value_pair.as_str().to_string(),
                Rule::integer | Rule::float => value_pair.as_str().to_string(),
                _ => value_pair.as_str().to_string(),
            };
            debug!("parse_metadata_annotation: Adding attribute {} = {}", attr_name, value);
            attributes.insert(attr_name.to_string(), value);
        }
        i += 2;
    }
    
    debug!("parse_metadata_annotation: Final result - name={}, attributes={:?}", name, attributes);
    Ok(MetadataAnnotation { name, attributes })
}

fn parse_attribute_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<AttributeDef> {
    let mut name = String::new();
    let mut visibility = None;
    let mut specializes = None;
    let mut type_ref = None;
    let mut multiplicity = None;
    let mut redefines = None;
    let mut default_value = None;
    let mut members = Vec::new();
    let mut next_is_specialization = false;
    let mut next_is_type = false;
    let mut next_is_redefines = false;
    let mut next_is_value = false;
    
    // Position tracking
    let mut name_position: Option<SourcePosition> = None;
    let mut specializes_position: Option<SourcePosition> = None;
    let mut type_ref_position: Option<SourcePosition> = None;
    let mut default_value_position: Option<SourcePosition> = None;
    
    debug!("parse_attribute_def: Starting to parse");
    for pair in pairs {
        debug!("parse_attribute_def: Rule {:?}, text: {:?}", pair.as_rule(), pair.as_str());
        match pair.as_rule() {
            Rule::name | Rule::qualified_name | Rule::identifier => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    // Store position of the name
                    name_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_attribute_def: Set name to: '{}' at line {}", name, name_position.as_ref().unwrap().line);
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    next_is_specialization = false;
                } else if next_is_type {
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    next_is_type = false;
                    debug!("parse_attribute_def: Set type_ref to: '{}' at line {}", type_ref.as_ref().unwrap(), type_ref_position.as_ref().unwrap().line);
                } else if next_is_redefines {
                    redefines = Some(text.to_string());
                    next_is_redefines = false;
                } else if !name.is_empty() && type_ref.is_none() && specializes.is_none() && default_value.is_none() && !next_is_value {
                    // If we've seen the name and haven't set type_ref, specializes, or default_value,
                    // and we're not expecting a value, this is likely the type_ref
                    // (The ":" is consumed by Pest's sequence matching)
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_attribute_def: Set type_ref to: '{}' (inferred from position) at line {}", type_ref.as_ref().unwrap(), type_ref_position.as_ref().unwrap().line);
                }
            }
            Rule::expr_value | Rule::expr_primary | Rule::expr_atom | Rule::expr_or => {
                // If we've seen the name and haven't set default_value yet, this is likely the default value
                // (The "=" is consumed by Pest's sequence matching, so we detect value by position)
                // If type_ref is already set, then this expression must be the default_value
                if !name.is_empty() && default_value.is_none() && !next_is_type && !next_is_specialization {
                    if type_ref.is_some() || (type_ref.is_none() && specializes.is_none()) {
                        debug!("parse_attribute_def: Found expr_value/expr_primary/expr_atom/expr_or after name/type_ref, assuming it's default_value");
                        default_value = parse_expression(pair.clone());
                        default_value_position = Some(span_to_position(pair.as_span(), source));
                        debug!("parse_attribute_def: Parsed default_value: {:?} at line {}", default_value, default_value_position.as_ref().unwrap().line);
                    }
                } else if next_is_value {
                    debug!("parse_attribute_def: Found expr_value/expr_primary/expr_atom/expr_or with next_is_value=true, parsing expression...");
                    default_value = parse_expression(pair.clone());
                    default_value_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_attribute_def: Parsed default_value: {:?} at line {}", default_value, default_value_position.as_ref().unwrap().line);
                    next_is_value = false;
                }
            }
            Rule::literal | Rule::integer | Rule::float | Rule::string | Rule::boolean => {
                // If we've seen the name and haven't set default_value yet, this is likely the default value
                // If type_ref is already set, then this literal must be the default_value
                if !name.is_empty() && default_value.is_none() && !next_is_type && !next_is_specialization {
                    if type_ref.is_some() || (type_ref.is_none() && specializes.is_none()) {
                        debug!("parse_attribute_def: Found literal/integer/float/string/boolean after name/type_ref, assuming it's default_value");
                        default_value = parse_expression(pair);
                        debug!("parse_attribute_def: Parsed default_value: {:?}", default_value);
                    }
                } else if next_is_value {
                    debug!("parse_attribute_def: Found literal/integer/float/string/boolean with next_is_value=true, parsing expression...");
                    // Handle numeric/string/boolean literals directly when they appear after =
                    default_value = parse_expression(pair);
                    debug!("parse_attribute_def: Parsed default_value: {:?}", default_value);
                    next_is_value = false;
                }
            }
            Rule::member => {
                if let Ok(member) = parse_member(pair.into_inner(), source) {
                    members.push(member);
                }
            }
            _ => {
                let text = pair.as_str();
                if text == "public" {
                    visibility = Some(Visibility::Public);
                } else if text == "private" {
                    visibility = Some(Visibility::Private);
                } else if text == ":>" {
                    next_is_specialization = true;
                } else if text == ":" && !next_is_specialization {
                    next_is_type = true;
                } else if text == "redefines" {
                    next_is_redefines = true;
                } else if text == "=" || text == "default" {
                    debug!("parse_attribute_def: Found = or default, setting next_is_value = true");
                    next_is_value = true;
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                }
            }
        }
    }
    
    debug!("parse_attribute_def: Final result - name='{}', default_value={:?}", name, default_value);
    Ok(AttributeDef {
        name,
        visibility,
        specializes,
        specializes_position,
        type_ref,
        multiplicity,
        redefines,
        default_value,
        members,
        name_position,
        type_ref_position,
        default_value_position,
        range: Some(span_to_source_range(span, source)),
    })
}

fn parse_attribute_usage(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<AttributeUsage> {
    let mut name = String::new();
    let mut name_position = None;
    let mut visibility = None;
    let mut specializes = None;
    let mut type_ref = None;
    let mut multiplicity = None;
    let mut redefines = None;
    let mut subsets = None;
    let mut value = None;
    let mut members = Vec::new();
    let mut next_is_specialization = false;
    let mut next_is_type = false;
    let mut next_is_redefines = false;
    let mut next_is_subsets = false;
    let mut next_is_value = false;
    
    for pair in pairs {
        match pair.as_rule() {
            Rule::name | Rule::qualified_name => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    next_is_specialization = false;
                } else if next_is_type {
                    type_ref = Some(text.to_string());
                    next_is_type = false;
                } else if next_is_redefines {
                    redefines = Some(text.to_string());
                    next_is_redefines = false;
                } else if next_is_subsets {
                    subsets = Some(text.to_string());
                    next_is_subsets = false;
                }
            }
            Rule::expr_value => {
                if next_is_value {
                    value = parse_expression(pair);
                    next_is_value = false;
                }
            }
            Rule::member => {
                if let Ok(member) = parse_member(pair.into_inner(), source) {
                    members.push(member);
                }
            }
            _ => {
                let text = pair.as_str();
                if text == "public" {
                    visibility = Some(Visibility::Public);
                } else if text == "private" {
                    visibility = Some(Visibility::Private);
                } else if text == ":>" {
                    next_is_specialization = true;
                } else if text == ":" && !next_is_specialization {
                    next_is_type = true;
                } else if text == "redefines" {
                    next_is_redefines = true;
                } else if text == "subsets" {
                    next_is_subsets = true;
                } else if text == "=" || text == "default" {
                    next_is_value = true;
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                }
            }
        }
    }
    
    Ok(AttributeUsage {
        name,
        name_position,
        visibility,
        specializes,
        type_ref,
        multiplicity,
        redefines,
        subsets,
        value,
        members,
        range: Some(span_to_source_range(span, source)),
    })
}

/// Mutable state accumulated while parsing a port definition.
struct PortDefAccumulator {
    name: String,
    name_position: Option<SourcePosition>,
    specializes: Option<String>,
    specializes_position: Option<SourcePosition>,
    type_ref: Option<String>,
    type_ref_position: Option<SourcePosition>,
    members: Vec<Member>,
    metadata: Vec<MetadataAnnotation>,
    next_is_specialization: bool,
    next_is_type: bool,
}

/// Processes one pair from a port definition (metadata, name, member, port_body, or `:>`/`:`).
fn process_port_def_pair(
    pair: pest::iterators::Pair<'_, Rule>,
    acc: &mut PortDefAccumulator,
    source: &str,
) {
    match pair.as_rule() {
        Rule::metadata_annotation => {
            if let Ok(meta) = parse_metadata_annotation(pair.clone()) {
                acc.metadata.push(meta);
            }
        }
        Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
            let text = pair.as_str().trim_matches('\'').trim_matches('"');
            if acc.name.is_empty() {
                acc.name = text.to_string();
                acc.name_position = Some(span_to_position(pair.as_span(), source));
            } else if acc.next_is_specialization {
                acc.specializes = Some(text.to_string());
                acc.specializes_position = Some(span_to_position(pair.as_span(), source));
                acc.next_is_specialization = false;
            } else if acc.next_is_type {
                acc.type_ref = Some(text.to_string());
                acc.type_ref_position = Some(span_to_position(pair.as_span(), source));
                acc.next_is_type = false;
            }
        }
        Rule::member => {
            if let Ok(member) = parse_member(pair.into_inner(), source) {
                acc.members.push(member);
            }
        }
        Rule::port_body => {
            for inner in pair.into_inner() {
                process_port_def_pair(inner, acc, source);
            }
        }
        _ => {
            let text = pair.as_str();
            if text == ":>" {
                acc.next_is_specialization = true;
            } else if text == ":" && !acc.next_is_specialization {
                acc.next_is_type = true;
            } else {
                for inner in pair.into_inner() {
                    process_port_def_pair(inner, acc, source);
                }
            }
        }
    }
}

fn parse_port_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<PortDef> {
    let mut acc = PortDefAccumulator {
        name: String::new(),
        name_position: None,
        specializes: None,
        specializes_position: None,
        type_ref: None,
        type_ref_position: None,
        members: Vec::new(),
        metadata: Vec::new(),
        next_is_specialization: false,
        next_is_type: false,
    };
    for pair in pairs {
        process_port_def_pair(pair, &mut acc, source);
    }
    Ok(PortDef {
        name: acc.name,
        name_position: acc.name_position,
        range: Some(span_to_source_range(span, source)),
        specializes: acc.specializes,
        specializes_position: acc.specializes_position,
        type_ref: acc.type_ref,
        type_ref_position: acc.type_ref_position,
        metadata: acc.metadata,
        members: acc.members,
    })
}

/// Mutable state accumulated while parsing a port usage.
struct PortUsageAccumulator {
    name: Option<String>,
    name_position: Option<SourcePosition>,
    type_ref: Option<String>,
    type_ref_position: Option<SourcePosition>,
    members: Vec<Member>,
    metadata: Vec<MetadataAnnotation>,
    next_is_type: bool,
}

/// Processes one pair from a port usage (metadata, name/identifier, member, port_body, or `:`).
fn process_port_usage_pair(
    pair: pest::iterators::Pair<'_, Rule>,
    acc: &mut PortUsageAccumulator,
    source: &str,
) {
    match pair.as_rule() {
        Rule::metadata_annotation => {
            if let Ok(meta) = parse_metadata_annotation(pair.clone()) {
                acc.metadata.push(meta);
            }
        }
        Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
            let text = pair.as_str().trim_matches('\'').trim_matches('"');
            if acc.name.is_none() {
                acc.name = Some(text.to_string());
                acc.name_position = Some(span_to_position(pair.as_span(), source));
            } else if acc.next_is_type {
                acc.type_ref = Some(text.to_string());
                acc.type_ref_position = Some(span_to_position(pair.as_span(), source));
                acc.next_is_type = false;
            }
        }
        Rule::member => {
            if let Ok(member) = parse_member(pair.into_inner(), source) {
                acc.members.push(member);
            }
        }
        Rule::port_body => {
            for inner in pair.into_inner() {
                process_port_usage_pair(inner, acc, source);
            }
        }
        _ => {
            if pair.as_str() == ":" {
                acc.next_is_type = true;
            } else {
                for inner in pair.into_inner() {
                    process_port_usage_pair(inner, acc, source);
                }
            }
        }
    }
}

fn parse_port_usage(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<PortUsage> {
    let mut acc = PortUsageAccumulator {
        name: None,
        name_position: None,
        type_ref: None,
        type_ref_position: None,
        members: Vec::new(),
        metadata: Vec::new(),
        next_is_type: false,
    };
    for pair in pairs {
        process_port_usage_pair(pair, &mut acc, source);
    }
    Ok(PortUsage {
        name: acc.name,
        name_position: acc.name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref: acc.type_ref,
        type_ref_position: acc.type_ref_position,
        metadata: acc.metadata,
        members: acc.members,
    })
}

fn parse_connection_usage(pairs: Pairs<'_, Rule>, file_source: &str, span: pest::Span<'_>) -> Result<ConnectionUsage> {
    let mut source = String::new();
    let mut target = String::new();
    let mut identifiers: Vec<String> = Vec::new();
    
    // Helper function to recursively extract identifiers from expr_value
    fn extract_identifier_from_expr(pair: pest::iterators::Pair<'_, Rule>) -> Option<String> {
        let rule = pair.as_rule();
        debug!("extract_identifier_from_expr: rule={:?}, text={:?}", rule, pair.as_str());
        match rule {
            Rule::name | Rule::qualified_name | Rule::identifier => {
                let ident = pair.as_str().trim().to_string();
                debug!("extract_identifier_from_expr: Found identifier: '{}'", ident);
                Some(ident)
            }
            Rule::expr_value | Rule::expr_or | Rule::expr_xor | Rule::expr_and | Rule::expr_compare 
            | Rule::expr_add_sub | Rule::expr_mul_div | Rule::expr_power | Rule::expr_primary 
            | Rule::expr_atom | Rule::expr_unit | Rule::expr_index | Rule::expr_call 
            | Rule::expr_arrow_call | Rule::expr_new => {
                // Recursively search in expression for identifiers
                debug!("extract_identifier_from_expr: Recursing into {:?}", rule);
                for inner_pair in pair.into_inner() {
                    if let Some(ident) = extract_identifier_from_expr(inner_pair) {
                        return Some(ident);
                    }
                }
                None
            }
            _ => {
                // Try inner pairs for any other rule
                for inner_pair in pair.into_inner() {
                    if let Some(ident) = extract_identifier_from_expr(inner_pair) {
                        return Some(ident);
                    }
                }
                None
            }
        }
    }
    
    for pair in pairs {
        let rule = pair.as_rule();
        debug!("parse_connection_usage: Processing rule={:?}, text={:?}", rule, pair.as_str());
        
        match rule {
            Rule::name | Rule::qualified_name | Rule::identifier => {
                let ident = pair.as_str().to_string();
                debug!("parse_connection_usage: Found direct identifier: {}", ident);
                identifiers.push(ident);
            }
            Rule::expr_value | Rule::expr_or | Rule::expr_xor | Rule::expr_and | Rule::expr_compare 
            | Rule::expr_add_sub | Rule::expr_mul_div | Rule::expr_power | Rule::expr_primary 
            | Rule::expr_atom | Rule::expr_unit | Rule::expr_index | Rule::expr_call 
            | Rule::expr_arrow_call | Rule::expr_new => {
                // Extract identifier from expr_value or any of its variants
                // (Pest reduces expr_value to specific variants like expr_or)
                debug!("parse_connection_usage: Found expression rule {:?}, extracting identifier...", rule);
                if let Some(ident) = extract_identifier_from_expr(pair) {
                    debug!("parse_connection_usage: Extracted identifier from expression: {}", ident);
                    identifiers.push(ident);
                } else {
                    debug!("parse_connection_usage: Failed to extract identifier from expression");
                }
            }
            Rule::member => {
                // Ignore members in connection usage body for now
            }
            _ => {}
        }
    }
    
    // Grammar gives us source and target as first two identifiers
    if identifiers.len() >= 2 {
        source = identifiers[0].clone();
        target = identifiers[1].clone();
    } else if identifiers.len() == 1 {
        source = identifiers[0].clone();
    }
    
    debug!("parse_connection_usage: source='{}', target='{}'", source, target);
    Ok(ConnectionUsage {
        name: None,
        name_position: None,
        range: Some(span_to_source_range(span, file_source)),
        source,
        target,
    })
}

fn parse_interface_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<InterfaceDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut specializes = None;
    let mut members = Vec::new();
    let mut metadata = Vec::new();
    let mut next_is_specialization = false;

    for pair in pairs {
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'').trim_matches('"');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    next_is_specialization = false;
                }
            }
            Rule::member => {
                if let Ok(member) = parse_member(pair.into_inner(), source) {
                    members.push(member);
                }
            }
            Rule::metadata_annotation => {
                if let Ok(meta) = parse_metadata_annotation(pair.clone()) {
                    metadata.push(meta);
                }
            }
            _ => {
                if pair.as_str() == ":>" {
                    next_is_specialization = true;
                } else {
                    // Recurse into body (e.g. "{" ~ member* ~ "}") to collect member pairs
                    for inner in pair.into_inner() {
                        if inner.as_rule() == Rule::member {
                            if let Ok(member) = parse_member(inner.into_inner(), source) {
                                members.push(member);
                            }
                        } else {
                            // One more level: repetition (member)* yields inner member pairs
                            for m in inner.into_inner() {
                                if m.as_rule() == Rule::member {
                                    if let Ok(member) = parse_member(m.into_inner(), source) {
                                        members.push(member);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(InterfaceDef {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        specializes,
        metadata,
        members,
    })
}

fn parse_item_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ItemDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut specializes = None;
    let mut members = Vec::new();
    let mut metadata = Vec::new();
    let mut next_is_specialization = false;
    let all_pairs: Vec<_> = pairs.collect();

    for pair in &all_pairs {
        match pair.as_rule() {
            Rule::name => {
                let text = pair.as_str();
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    next_is_specialization = false;
                }
            }
            Rule::member => {
                if let Ok(member) = parse_member(pair.clone().into_inner(), source) {
                    members.push(member);
                }
            }
            Rule::metadata_annotation => {
                if let Ok(meta) = parse_metadata_annotation(pair.clone()) {
                    metadata.push(meta);
                }
            }
            _ => {
                if pair.as_str() == ":>" {
                    next_is_specialization = true;
                }
            }
        }
    }

    Ok(ItemDef {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        specializes,
        metadata,
        members,
    })
}

fn parse_item_usage(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ItemUsage> {
    let mut direction = ItemDirection::In;
    let mut name = String::new();
    let mut name_position = None;
    let mut type_ref = None;
    let mut multiplicity = None;
    let mut next_is_type = false;
    
    for pair in pairs {
        match pair.as_rule() {
            Rule::name => {
                let text = pair.as_str();
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                } else if next_is_type {
                    type_ref = Some(text.to_string());
                    next_is_type = false;
                }
            }
            _ => {
                let text = pair.as_str();
                if text == "in" {
                    direction = ItemDirection::In;
                } else if text == "out" {
                    direction = ItemDirection::Out;
                } else if text == ":" {
                    next_is_type = true;
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                }
            }
        }
    }
    
    Ok(ItemUsage {
        direction,
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref,
        multiplicity,
    })
}

/// Parse "ref item name : Type { ... }" into ItemUsage (body members are not stored).
fn parse_ref_item(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ItemUsage> {
    let mut name = String::new();
    let mut name_position = None;
    let mut type_ref = None;
    let mut multiplicity = None;
    let mut next_is_type = false;
    for pair in pairs {
        match pair.as_rule() {
            Rule::name | Rule::qualified_name => {
                let text = pair.as_str();
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                } else if next_is_type {
                    type_ref = Some(text.to_string());
                    next_is_type = false;
                }
            }
            Rule::metadata_annotation => {}
            Rule::member => {}
            _ => {
                let text = pair.as_str();
                if text == ":" || text == ":>" {
                    next_is_type = true;
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                }
            }
        }
    }
    Ok(ItemUsage {
        direction: ItemDirection::In,
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref,
        multiplicity,
    })
}

fn parse_requirement_def(pairs: Pairs<'_, Rule>, full_text: &str, source: &str, span: pest::Span<'_>) -> Result<RequirementDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut specializes = None;
    let mut members = Vec::new();
    let mut next_is_specialization = false;
    
    debug!("parse_requirement_def: Starting to parse");
    let all_pairs: Vec<_> = pairs.collect();
    debug!("parse_requirement_def: Processing {} pairs", all_pairs.len());
    let mut doc_comment_text = String::new();
    for (idx, pair) in all_pairs.iter().enumerate() {
        trace!("parse_requirement_def: Pair[{}] rule={:?}, text={:?}", idx, pair.as_rule(), pair.as_str());
        match pair.as_rule() {
            // name is silent, so we need to match its alternatives: identifier, qualified_name, or string_literal
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_requirement_def: Set name to: {}", name);
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    next_is_specialization = false;
                }
            }
            Rule::member | Rule::import_statement => {
                if let Ok(member) = parse_member(pair.clone().into_inner(), source) {
                    members.push(member);
                }
            }
            Rule::doc_comment => {
                // Handle doc_comment directly (member is silent, so doc_comment appears directly)
                // doc_comment is atomic (@{}), so COMMENT is part of the match but not accessible as inner pair
                // Extract it from the full requirement_def text
                debug!("parse_requirement_def: Found doc_comment directly");
                // Find "doc" in the full text and extract the comment after it
                if let Some(doc_pos) = full_text.find("doc") {
                    let after_doc = &full_text[doc_pos + 3..];
                    // Find the comment (/* ... */ or // ...)
                    if let Some(comment_start) = after_doc.find("/*") {
                        if let Some(comment_end) = after_doc[comment_start + 2..].find("*/") {
                            doc_comment_text = after_doc[comment_start + 2..comment_start + 2 + comment_end]
                                .trim()
                                .to_string();
                            debug!("parse_requirement_def: Extracted doc comment text: {:?}", doc_comment_text);
                        }
                    } else if let Some(comment_start) = after_doc.find("//") {
                        // For // comments, extract until end of line
                        let comment_line = after_doc[comment_start + 2..]
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim_end()
                            .to_string();
                        doc_comment_text = comment_line;
                        debug!("parse_requirement_def: Extracted doc comment text: {:?}", doc_comment_text);
                    }
                }
            }
            Rule::COMMENT => {
                // COMMENT might appear separately (not part of doc_comment)
                // Only extract if we haven't already extracted from doc_comment
                if doc_comment_text.is_empty() {
                    let comment_text = pair.as_str();
                    // Remove /* and */ or // and newline
                    doc_comment_text = if comment_text.starts_with("/*") {
                        comment_text
                            .strip_prefix("/*")
                            .and_then(|s| s.strip_suffix("*/"))
                            .unwrap_or(comment_text)
                            .trim()
                            .to_string()
                    } else if comment_text.starts_with("//") {
                        comment_text
                            .strip_prefix("//")
                            .unwrap_or(comment_text)
                            .trim_end()
                            .to_string()
                    } else {
                        comment_text.trim().to_string()
                    };
                    debug!("parse_requirement_def: Extracted COMMENT text: {:?}", doc_comment_text);
                }
            }
            _ => {
                if pair.as_str() == ":>" {
                    next_is_specialization = true;
                }
            }
        }
    }
    
    // If we found a doc comment, add it to members
    if !doc_comment_text.is_empty() {
        members.push(Member::DocComment(crate::ast::DocComment { text: doc_comment_text }));
    }
    
    Ok(RequirementDef {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        specializes,
        members,
    })
}

fn parse_requirement_usage(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<RequirementUsage> {
    let mut name = String::new();
    let mut name_position = None;
    let mut type_ref = None;
    let mut redefines = None;
    let mut members = Vec::new();
    let mut next_is_type = false;
    let mut next_is_redefines = false;
    
    debug!("parse_requirement_usage: Starting to parse");
    for pair in pairs {
        trace!("parse_requirement_usage: Rule {:?}, text: {:?}", pair.as_rule(), pair.as_str());
        match pair.as_rule() {
            // name is silent, so we need to match its alternatives: identifier, qualified_name, or string_literal
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_requirement_usage: Set name to: {}", name);
                } else if next_is_type {
                    type_ref = Some(text.to_string());
                    next_is_type = false;
                } else if next_is_redefines {
                    redefines = Some(text.to_string());
                    next_is_redefines = false;
                }
            }
            Rule::member | Rule::import_statement => {
                if let Ok(member) = parse_member(pair.into_inner(), source) {
                    members.push(member);
                }
            }
            _ => {
                let text = pair.as_str();
                if text == ":" {
                    next_is_type = true;
                } else if text == "redefines" {
                    next_is_redefines = true;
                }
            }
        }
    }
    
    Ok(RequirementUsage {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref,
        redefines,
        members,
    })
}

fn parse_requirement_references(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<RequirementUsage> {
    let mut name = String::new();
    let mut name_position = None;
    let mut members = Vec::new();
    
    debug!("parse_requirement_references: Starting to parse");
    for pair in pairs {
        trace!("parse_requirement_references: Rule {:?}, text: {:?}", pair.as_rule(), pair.as_str());
        match pair.as_rule() {
            // name is silent, so we need to match its alternatives: identifier, qualified_name, or string_literal
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_requirement_references: Set name to: {}", name);
                }
            }
            Rule::member | Rule::import_statement => {
                if let Ok(member) = parse_member(pair.into_inner(), source) {
                    members.push(member);
                }
            }
            _ => {}
        }
    }
    
    Ok(RequirementUsage {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref: None,
        redefines: None,
        members,
    })
}

fn parse_action_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ActionDef> {
    let mut name = String::new();
    let mut name_position = None;
    
    for pair in pairs {
        match pair.as_rule() {
            Rule::identifier | Rule::string_literal => {
                if name.is_empty() {
                    name = pair.as_str().to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_action_def: Found name: {}", name);
                }
            }
            _ => {
                debug!("parse_action_def: Skipping rule {:?}", pair.as_rule());
            }
        }
    }
    
    debug!("parse_action_def: Returning ActionDef with name: {}", name);
    Ok(ActionDef {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        body: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_parsing() {
        let input = r#"
            package MyPackage {
                part def MyPart;
            }
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok());
    }

    #[test]
    fn test_nested_part_usage_in_part_def() {
        let input = r#"
            package P {
                part def A {
                    part b {
                        part c;
                    }
                }
            }
        "#;
        let doc = parse_sysml(input).expect("parse");
        let pkg = doc.packages.first().expect("package");
        let part_def_a = pkg.members.iter().find_map(|m| {
            if let Member::PartDef(pd) = m { Some(pd) } else { None }
        }).expect("PartDef A");
        assert_eq!(part_def_a.name, "A");
        assert_eq!(part_def_a.members.len(), 1, "PartDef A should have 1 member (part b)");
        let part_b = match &part_def_a.members[0] {
            Member::PartUsage(pu) => pu,
            _ => panic!("expected PartUsage b"),
        };
        assert_eq!(part_b.name.as_deref(), Some("b"));
        assert_eq!(part_b.members.len(), 1, "PartUsage b should have 1 member (part c)");
        let part_c = match &part_b.members[0] {
            Member::PartUsage(pu) => pu,
            _ => panic!("expected PartUsage c"),
        };
        assert_eq!(part_c.name.as_deref(), Some("c"));
    }

    #[test]
    fn test_metadata_annotation_parsing() {
        // Test direct metadata annotation parsing
        use pest::Parser;
        let input = r#"@Layer(name = "02_SystemContext")"#;
        
        let pairs = SysMLParser::parse(Rule::metadata_annotation, input);
        assert!(pairs.is_ok(), "Failed to parse metadata annotation: {:?}", pairs);
        
        let mut pairs = pairs.unwrap();
        if let Some(pair) = pairs.next() {
            let result = parse_metadata_annotation(pair);
            assert!(result.is_ok(), "Failed to parse: {:?}", result);
            let meta = result.unwrap();
            assert_eq!(meta.name, "Layer");
            assert_eq!(meta.attributes.get("name"), Some(&"02_SystemContext".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_part_usage() {
        // In Elan8 structure, metadata annotations are on separate lines before the part
        // The parser should pick these up and attach them to the part_usage
        let input = r#"
@Layer(name = "02_SystemContext")
part system : System;

@Layer(name = "02_SystemContext")
part user : Actor;
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        // For top-level members without packages, parser creates a dummy package
        assert!(doc.packages.len() >= 1, "Expected at least 1 package (dummy for top-level), got {}", doc.packages.len());
        
        // Find the package with empty name (dummy package for top-level members)
        let pkg = doc.packages.iter().find(|p| p.name.is_empty())
            .or_else(|| doc.packages.first())
            .expect("No package found");
        
        println!("Package '{}' has {} members", pkg.name, pkg.members.len());
        for (i, member) in pkg.members.iter().enumerate() {
            match member {
                Member::PartUsage(ref pu) => {
                    println!("Member {}: PartUsage name={:?}, type={:?}, metadata={:?}", 
                        i, pu.name, pu.type_ref, pu.metadata);
                }
                _ => {
                    println!("Member {}: {:?}", i, member);
                }
            }
        }
        
        // Find the system part usage
        let system_part = pkg.members.iter().find(|m| {
            if let Member::PartUsage(ref pu) = m {
                pu.name == Some("system".to_string())
            } else {
                false
            }
        });
        
        assert!(system_part.is_some(), "Could not find system part usage. Members: {:?}", pkg.members);
        if let Some(Member::PartUsage(ref part_usage)) = system_part {
            assert_eq!(part_usage.name, Some("system".to_string()));
            assert_eq!(part_usage.type_ref, Some("System".to_string()));
            println!("System part_usage has {} metadata annotations: {:?}", part_usage.metadata.len(), part_usage.metadata);
            assert!(part_usage.metadata.len() >= 1, "Expected at least 1 metadata annotation, got {}", part_usage.metadata.len());
            
            let layer_meta = part_usage.metadata.iter().find(|m| m.name == "Layer");
            assert!(layer_meta.is_some(), "Expected Layer metadata, found: {:?}", part_usage.metadata);
            assert_eq!(layer_meta.unwrap().attributes.get("name"), Some(&"02_SystemContext".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_part_def() {
        let input = r#"
            @Layer(name = "05_PhysicalArchitecture")
            part def CoffeeMaker {
                part controller : Controller;
            }
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        assert_eq!(doc.packages.len(), 1);
        
        let pkg = &doc.packages[0];
        let part_def_member = pkg.members.iter().find(|m| {
            if let Member::PartDef(ref pd) = m {
                pd.name == "CoffeeMaker"
            } else {
                false
            }
        });
        
        assert!(part_def_member.is_some(), "Could not find CoffeeMaker part def");
        if let Some(Member::PartDef(ref part_def)) = part_def_member {
            assert_eq!(part_def.name, "CoffeeMaker");
            assert!(part_def.metadata.len() >= 1, "Expected at least 1 metadata annotation, got {}", part_def.metadata.len());
            
            let layer_meta = part_def.metadata.iter().find(|m| m.name == "Layer");
            assert!(layer_meta.is_some(), "Expected Layer metadata");
            assert_eq!(layer_meta.unwrap().attributes.get("name"), Some(&"05_PhysicalArchitecture".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_multiple_attributes() {
        let input = r#"
            @Layer(name = "02_SystemContext")
            @Status(value = "Draft")
            part system : System;
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        let pkg = &doc.packages[0];
        
        let system_part = pkg.members.iter().find(|m| {
            if let Member::PartUsage(ref pu) = m {
                pu.name == Some("system".to_string())
            } else {
                false
            }
        });
        
        assert!(system_part.is_some(), "Could not find system part usage");
        if let Some(Member::PartUsage(ref part_usage)) = system_part {
            // Should have at least 1 metadata annotation (Layer)
            assert!(part_usage.metadata.len() >= 1, "Expected at least 1 metadata annotation, got {}", part_usage.metadata.len());
            
            let layer_meta = part_usage.metadata.iter().find(|m| m.name == "Layer");
            assert!(layer_meta.is_some(), "Expected Layer metadata");
            assert_eq!(layer_meta.unwrap().attributes.get("name"), Some(&"02_SystemContext".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_no_metadata() {
        let input = r#"
            part system : System;
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        let pkg = &doc.packages[0];
        
        let system_part = pkg.members.iter().find(|m| {
            if let Member::PartUsage(ref pu) = m {
                pu.name == Some("system".to_string())
            } else {
                false
            }
        });
        
        assert!(system_part.is_some(), "Could not find system part usage");
        if let Some(Member::PartUsage(ref part_usage)) = system_part {
            assert_eq!(part_usage.metadata.len(), 0, "Expected no metadata annotations, got {}", part_usage.metadata.len());
        }
    }

    #[test]
    fn test_port_usage_sysml_v2() {
        // SysML v2 compliant: port body contains only members (no connector/pin_map)
        let input = "port power : Power { }";
        let mut pairs = SysMLParser::parse(Rule::port_usage, input).expect("parse port_usage");
        let pair = pairs.next().expect("one pair");
        let span = pair.as_span();
        let port = parse_port_usage(pair.into_inner(), input, span).expect("parse_port_usage");
        assert_eq!(port.name.as_deref(), Some("power"));
        assert!(port.members.is_empty());
    }
}

