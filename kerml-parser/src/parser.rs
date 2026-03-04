//! Pest-based parser for SysML v2 grammar.
//!
//! Parses input via the `document` rule in the Pest grammar, then walks
//! pairs to build the AST (packages, members, etc.). Source positions are converted
//! from byte offsets to line/character for LSP and diagnostics.

use pest::Parser;
use pest::iterators::{Pair, Pairs};
use crate::error::{ParseError, Result};
use crate::ast::*;
use log::{debug, trace};
use std::collections::HashMap;

/// Convert a Pest span to SourcePosition
/// The span contains byte offsets, we need to convert to line/character
fn span_to_position(span: pest::Span<'_>, source: &str) -> SourcePosition {
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
fn byte_offset_to_line_char(source: &str, byte_offset: usize) -> (u32, u32) {
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
fn span_to_source_range(span: pest::Span<'_>, source: &str) -> SourceRange {
    let (start_line, start_character) = byte_offset_to_line_char(source, span.start());
    let (end_line, end_character) = byte_offset_to_line_char(source, span.end());
    SourceRange {
        start_line,
        start_character,
        end_line,
        end_character,
    }
}

#[derive(pest_derive::Parser)]
#[grammar = "grammar.pest"]
pub struct SysMLParser;

/// Parses SysML v2 source text into a [SysMLDocument](crate::ast::SysMLDocument) AST.
pub fn parse_sysml(input: &str) -> Result<SysMLDocument> {
    let mut pairs = SysMLParser::parse(Rule::document, input)
        .map_err(|e| ParseError::PestError(format!("{}", e)))?;
    
    // Get the inner pairs of the document rule
    if let Some(document_pair) = pairs.next() {
        parse_document(document_pair.into_inner(), input)
    } else {
        Err(ParseError::Message("Empty document".to_string()))
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

fn parse_import(pairs: Pairs<'_, Rule>, _source: &str) -> Result<Import> {
    let mut visibility = None;
    let mut path = String::new();
    let mut wildcard = false;
    
    for pair in pairs {
        match pair.as_rule() {
            Rule::name | Rule::qualified_name => {
                path = pair.as_str().to_string();
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
    
    Ok(Import { visibility, path, wildcard })
}

fn parse_package(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<Package> {
    let mut is_library = false;
    let mut name = String::new();
    let mut name_position = None;
    let mut imports = Vec::new();
    let mut members = Vec::new();
    
    // Collect all pairs first for debugging
    let all_pairs: Vec<_> = pairs.collect();
    debug!("parse_package: Processing {} top-level pairs", all_pairs.len());
    
    // Check for "standard library" or "library" keywords before package name
    let mut seen_standard = false;
    let mut seen_library = false;
    
    // Track metadata annotations that appear before members
    let mut pending_metadata: Vec<MetadataAnnotation> = Vec::new();
    
    for (idx, pair) in all_pairs.iter().enumerate() {
        let rule = pair.as_rule();
        let text = pair.as_str();
        debug!("parse_package: Pair[{}] rule={:?}, text={:?}", idx, rule, text);
        
        // Check if this pair has inner pairs
        let inner_pairs: Vec<_> = pair.clone().into_inner().collect();
        if !inner_pairs.is_empty() {
            debug!("parse_package: Pair[{}] has {} inner pairs", idx, inner_pairs.len());
            for (inner_idx, inner_pair) in inner_pairs.iter().enumerate() {
                trace!("parse_package: Pair[{}].Inner[{}] rule={:?}, text={:?}", 
                    idx, inner_idx, inner_pair.as_rule(), inner_pair.as_str());
            }
        }
        
        match rule {
            Rule::package_name | Rule::name | Rule::qualified_name | Rule::identifier | Rule::string_literal => {
                if name.is_empty() {
                    name = pair.as_str().trim_matches('\'').trim_matches('"').to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    debug!("parse_package: Set package name to: {}", name);
                    // If we've seen "standard" or "library" before the name, mark as library
                    if seen_standard || seen_library {
                        is_library = true;
                    }
                }
            }
            Rule::import_statement => {
                debug!("parse_package: Found import_statement");
                match parse_import(pair.clone().into_inner(), source) {
                    Ok(import) => imports.push(import),
                    Err(e) => return Err(e),
                }
            }
            Rule::member => {
                debug!("parse_package: Found member rule, parsing...");
                match parse_member(pair.clone().into_inner(), source) {
                    Ok(member) => {
                        debug!("parse_package: Successfully parsed member");
                        members.push(member);
                    },
                    Err(e) => {
                        debug!("parse_package: Failed to parse member: {:?}", e);
                        return Err(e);
                    },
                }
            }
            Rule::part_def => {
                debug!("parse_package: Found part_def directly, parsing...");
                let member_span = pair.as_span();
                match parse_part_def(pair.clone().into_inner(), source, member_span) {
                    Ok(mut part_def) => {
                        let mut combined_metadata = pending_metadata.clone();
                        combined_metadata.append(&mut part_def.metadata);
                        part_def.metadata = combined_metadata;
                        pending_metadata.clear();
                        members.push(Member::PartDef(part_def));
                    },
                    Err(e) => {
                        debug!("parse_package: Failed to parse part_def: {:?}", e);
                        return Err(e);
                    },
                }
            }
            Rule::part_usage => {
                debug!("parse_package: Found part_usage directly, parsing...");
                let member_span = pair.as_span();
                match parse_part_usage(pair.clone().into_inner(), source, member_span) {
                    Ok(mut part_usage) => {
                        let mut combined_metadata = pending_metadata.clone();
                        combined_metadata.append(&mut part_usage.metadata);
                        part_usage.metadata = combined_metadata;
                        pending_metadata.clear();
                        members.push(Member::PartUsage(part_usage));
                    },
                    Err(e) => {
                        debug!("parse_package: Failed to parse part_usage: {:?}", e);
                        return Err(e);
                    },
                }
            }
            Rule::requirement_def => {
                debug!("parse_package: Found requirement_def directly, parsing...");
                let requirement_def_full_text = pair.as_str();
                let member_span = pair.as_span();
                match parse_requirement_def(pair.clone().into_inner(), requirement_def_full_text, source, member_span) {
                    Ok(req_def) => {
                        members.push(Member::RequirementDef(req_def));
                    },
                    Err(e) => {
                        debug!("parse_package: Failed to parse requirement_def: {:?}", e);
                        return Err(e);
                    },
                }
            }
            Rule::requirement_usage => {
                debug!("parse_package: Found requirement_usage directly, parsing...");
                let member_span = pair.as_span();
                match parse_requirement_usage(pair.clone().into_inner(), source, member_span) {
                    Ok(req_usage) => {
                        members.push(Member::RequirementUsage(req_usage));
                    },
                    Err(e) => {
                        debug!("parse_package: Failed to parse requirement_usage: {:?}", e);
                        return Err(e);
                    },
                }
            }
            Rule::action_def => {
                debug!("parse_package: Found action_def directly, parsing...");
                let member_span = pair.as_span();
                match parse_action_def(pair.clone().into_inner(), source, member_span) {
                    Ok(action_def) => {
                        members.push(Member::ActionDef(action_def));
                    },
                    Err(e) => {
                        debug!("parse_package: Failed to parse action_def: {:?}", e);
                        return Err(e);
                    },
                }
            }
            Rule::connection_usage => {
                debug!("parse_package: Found connection_usage directly, parsing...");
                let conn_span = pair.as_span();
                match parse_connection_usage(pair.clone().into_inner(), source, conn_span) {
                    Ok(conn) => {
                        members.push(Member::ConnectionUsage(conn));
                    },
                    Err(e) => {
                        debug!("parse_package: Failed to parse connection_usage: {:?}", e);
                        return Err(e);
                    },
                }
            }
            Rule::COMMENT => {
                trace!("parse_package: Found COMMENT, skipping");
            }
            _ => {
                trace!("parse_package: Matched other rule: {:?}, text: {:?}", rule, text);
                // Check for "standard" or "library" keywords
                let text_lower = text.to_lowercase();
                if text_lower == "standard" {
                    seen_standard = true;
                } else if text_lower == "library" {
                    seen_library = true;
                    // If we see "library" (with or without "standard" before it), mark as library
                    is_library = true;
                }
            }
        }
    }
    
    debug!("parse_package: Final package '{}' has {} members", name, members.len());
    
    if name.is_empty() {
        return Err(ParseError::Message("Package name is required".to_string()));
    }
    
    Ok(Package {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        is_library,
        imports,
        members,
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
            // These are recognized but not fully parsed yet - just skip them for now
            Rule::flow_statement | Rule::assign_statement | Rule::transition_statement |
            Rule::accept_statement | Rule::state_machine_statement | Rule::variation_statement |
            Rule::state_def | Rule::exhibit_state | Rule::subject_statement |
            Rule::end_statement | Rule::dependency_statement | Rule::occurrence_def | Rule::occurrence_usage |
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
                    type_ref: None,
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
    let mut type_ref = None;
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
                    debug!("parse_part_def: Set specializes to: {:?}", specializes);
                    next_is_specialization = false;
                } else if seen_colon {
                    type_ref = Some(text.to_string());
                    debug!("parse_part_def: Set type_ref to: {:?}", type_ref);
                    seen_colon = false;
                } else if specializes.is_none() && type_ref.is_none() {
                    // If we see a second identifier after the name and we haven't set specializes or type_ref yet,
                    // and we haven't seen a colon, this is likely the specializes name from the :> pattern
                    // (Pest matches :> name but only exposes the name as a pair, not the :> tokens)
                    specializes = Some(text.to_string());
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
        type_ref,
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
    let mut type_ref = None;
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
                    next_is_specialization = false;
                } else if next_is_type || (!next_is_redefines && !next_is_subsets && type_ref.is_none()) {
                    // If we've seen the name and no other flags are set, and we haven't set type_ref yet,
                    // then this must be the type_ref (the `:` is consumed by Pest's sequence matching)
                    type_ref = Some(text.to_string());
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
        type_ref,
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
    let name_pair = inner.next().ok_or_else(|| ParseError::PestError("Metadata annotation missing name".to_string()))?;
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
    type_ref: Option<String>,
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
        Rule::name => {
            let text = pair.as_str();
            if acc.name.is_empty() {
                acc.name = text.to_string();
                acc.name_position = Some(span_to_position(pair.as_span(), source));
            } else if acc.next_is_specialization {
                acc.specializes = Some(text.to_string());
                acc.next_is_specialization = false;
            } else if acc.next_is_type {
                acc.type_ref = Some(text.to_string());
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
        type_ref: None,
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
        type_ref: acc.type_ref,
        metadata: acc.metadata,
        members: acc.members,
    })
}

/// Mutable state accumulated while parsing a port usage.
struct PortUsageAccumulator {
    name: Option<String>,
    name_position: Option<SourcePosition>,
    type_ref: Option<String>,
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
        Rule::name | Rule::identifier => {
            let text = pair.as_str();
            if acc.name.is_none() {
                acc.name = Some(text.to_string());
                acc.name_position = Some(span_to_position(pair.as_span(), source));
            } else if acc.next_is_type {
                acc.type_ref = Some(text.to_string());
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

/// Parse bind_statement inner pairs: "bind" ~ logical ~ "=" ~ physical ~ ("{" ... "}" | ";")
/// Pest gives us inner pairs for the sub-rules (logical expr, physical expr_value, optional block).
fn parse_bind_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<BindStatement> {
    let all: Vec<_> = pairs.collect();
    let mut logical = String::new();
    let mut physical = String::new();
    let mut params = Vec::<(String, String)>::new();
    let mut seen_first = false;
    for pair in &all {
        let s = pair.as_str().trim();
        // Skip literals and block delimiters
        if s == "bind" || s == "=" || s == ";" || s == "{" || s == "}" {
            continue;
        }
        if !seen_first {
            logical = s.to_string();
            seen_first = true;
        } else if physical.is_empty() {
            physical = s.to_string();
        } else {
            // Body: collect params from attribute_usage or assign_statement
            if pair.as_rule() == Rule::attribute_usage {
                if let Some((k, v)) = extract_attribute_usage_param(pair) {
                    params.push((k, v));
                }
            } else if pair.as_rule() == Rule::assign_statement {
                if let Some((k, v)) = extract_assign_statement_param(pair) {
                    params.push((k, v));
                }
            } else {
                for inner in pair.clone().into_inner() {
                    if inner.as_rule() == Rule::attribute_usage {
                        if let Some((k, v)) = extract_attribute_usage_param(&inner) {
                            params.push((k, v));
                        }
                    } else if inner.as_rule() == Rule::assign_statement {
                        if let Some((k, v)) = extract_assign_statement_param(&inner) {
                            params.push((k, v));
                        }
                    }
                }
            }
        }
    }
    Ok(BindStatement { logical, physical, params })
}

fn extract_attribute_usage_param(pair: &pest::iterators::Pair<'_, Rule>) -> Option<(String, String)> {
    let inner: Vec<_> = pair.clone().into_inner().collect();
    let mut name = String::new();
    let mut value = String::new();
    for p in &inner {
        match p.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name => {
                if name.is_empty() {
                    name = p.as_str().trim().to_string();
                } else if value.is_empty() {
                    value = p.as_str().trim().to_string();
                }
            }
            Rule::expr_value | Rule::expr_primary | Rule::expr_atom => {
                value = p.as_str().trim().to_string();
            }
            _ => {}
        }
    }
    if !name.is_empty() {
        Some((name, value))
    } else {
        None
    }
}

fn extract_assign_statement_param(pair: &pest::iterators::Pair<'_, Rule>) -> Option<(String, String)> {
    let inner: Vec<_> = pair.clone().into_inner().collect();
    let mut target = String::new();
    let mut value = String::new();
    let mut seen_assign = false;
    for p in &inner {
        let s = p.as_str().trim();
        if s == ":=" {
            seen_assign = true;
            continue;
        }
        match p.as_rule() {
            Rule::expr_value | Rule::expr_primary | Rule::expr_atom | Rule::name | Rule::qualified_name | Rule::identifier => {
                if !seen_assign {
                    target = s.to_string();
                } else {
                    value = s.to_string();
                }
            }
            _ => {}
        }
    }
    if !target.is_empty() {
        Some((target, value))
    } else {
        None
    }
}

/// Parse allocate_statement inner pairs: "allocate" ~ (name ~ "::>" ~ name | name) ~ "to" ~ (name ~ "::>" ~ name | name) ~ ...
fn parse_allocate_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<AllocateStatement> {
    let all: Vec<_> = pairs.collect();
    let mut source = String::new();
    let mut target = String::new();
    let mut to_idx = None;
    for (i, pair) in all.iter().enumerate() {
        let s = pair.as_str().trim();
        if s == "allocate" {
            continue;
        }
        if s == "to" {
            to_idx = Some(i);
            break;
        }
        if source.is_empty() {
            source = s.to_string();
        } else if !s.is_empty() && s != "::>" {
            source.push(' ');
            source.push_str(s);
        }
    }
    if let Some(i) = to_idx {
        for pair in all.iter().skip(i + 1) {
            let s = pair.as_str().trim();
            if s == ";" || s == "{" || s == "}" {
                break;
            }
            if target.is_empty() {
                target = s.to_string();
            } else if !s.is_empty() && s != "::>" {
                target.push(' ');
                target.push_str(s);
            }
        }
    }
    Ok(AllocateStatement { source, target })
}

/// Parse provides_statement: "provides" ~ name ~ ("=" ~ name)? ~ ";"
fn parse_provides_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<ProvidesStatement> {
    let mut names: Vec<String> = Vec::new();
    for pair in pairs {
        let s = pair.as_str().trim().trim_matches('\'');
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                if s != "provides" && s != "requires" && !s.is_empty() {
                    names.push(s.to_string());
                }
            }
            _ => {
                // Recurse into optional group ("=" ~ name) to pick up second name
                for inner in pair.into_inner() {
                    let t = inner.as_str().trim().trim_matches('\'');
                    if (inner.as_rule() == Rule::name
                        || inner.as_rule() == Rule::identifier
                        || inner.as_rule() == Rule::qualified_name
                        || inner.as_rule() == Rule::string_literal)
                        && !t.is_empty()
                    {
                        names.push(t.to_string());
                    }
                }
            }
        }
    }
    let capability = names.first().cloned().unwrap_or_default();
    let execution_kind = if names.len() > 1 {
        Some(names[1].clone())
    } else {
        None
    };
    Ok(ProvidesStatement { capability, execution_kind })
}

/// Parse requires_statement: "requires" ~ name ~ ("=" ~ name)? ~ ";"
fn parse_requires_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<RequiresStatement> {
    let mut names: Vec<String> = Vec::new();
    for pair in pairs {
        let s = pair.as_str().trim().trim_matches('\'');
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                if s != "provides" && s != "requires" && !s.is_empty() {
                    names.push(s.to_string());
                }
            }
            _ => {
                for inner in pair.into_inner() {
                    let t = inner.as_str().trim().trim_matches('\'');
                    if (inner.as_rule() == Rule::name
                        || inner.as_rule() == Rule::identifier
                        || inner.as_rule() == Rule::qualified_name
                        || inner.as_rule() == Rule::string_literal)
                        && !t.is_empty()
                    {
                        names.push(t.to_string());
                    }
                }
            }
        }
    }
    let capability = names.first().cloned().unwrap_or_default();
    let execution_kind = if names.len() > 1 {
        Some(names[1].clone())
    } else {
        None
    };
    Ok(RequiresStatement { capability, execution_kind })
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

fn parse_multiplicity_str(text: &str) -> Option<Multiplicity> {
    let inner = text.trim_matches(|c| c == '[' || c == ']');
    
    if inner == "*" {
        return Some(Multiplicity::Unbounded);
    }
    
    if inner.contains("..") {
        let parts: Vec<&str> = inner.split("..").collect();
        if parts.len() == 2 {
            if let (Ok(start), Ok(end)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                return Some(Multiplicity::Range(start, end));
            }
        }
    } else if let Ok(n) = inner.parse::<u32>() {
        return Some(Multiplicity::Fixed(n));
    }
    
    None
}

fn parse_expression(pair: Pair<'_, Rule>) -> Option<Expression> {
    match pair.as_rule() {
        Rule::expr_value => {
            // Get the first inner pair
            if let Some(inner) = pair.into_inner().next() {
                return parse_expression(inner);
            }
        }
        Rule::expr_atom | Rule::expr_primary => {
            // For expr_atom, we need to check the structure
            let mut inner = pair.into_inner().peekable();
            if let Some(first) = inner.next() {
                // Check if this is a string_literal.field pattern
                if first.as_rule() == Rule::string_literal {
                    let base = first.as_str().trim_matches('\'').to_string();
                    // Collect the field names (the "." ~ name parts)
                    let mut fields = vec![base];
                    let mut collecting_fields = true;
                    for next_pair in inner {
                        if collecting_fields && next_pair.as_rule() == Rule::name {
                            fields.push(next_pair.as_str().to_string());
                        } else {
                            // If we hit something else, try to parse it
                            if let Some(expr) = parse_expression(next_pair) {
                                // This shouldn't happen in expr_atom, but handle it
                                return Some(expr);
                            }
                            collecting_fields = false;
                        }
                    }
                    if fields.len() > 1 {
                        // This is a qualified name with dots like 'generate torque'.engineTorque
                        return Some(Expression::QualifiedName(fields));
                    } else {
                        // Just a string literal
                        return Some(Expression::Literal(Literal::String(fields[0].clone())));
                    }
                }
                // Otherwise, recurse
                return parse_expression(first);
            }
        }
        Rule::literal | Rule::integer | Rule::float | Rule::string | Rule::boolean => {
            let text = pair.as_str();
            if let Ok(n) = text.parse::<i64>() {
                return Some(Expression::Literal(Literal::Integer(n)));
            } else if let Ok(f) = text.parse::<f64>() {
                return Some(Expression::Literal(Literal::Float(f)));
            } else if text == "true" {
                return Some(Expression::Literal(Literal::Boolean(true)));
            } else if text == "false" {
                return Some(Expression::Literal(Literal::Boolean(false)));
            } else {
                return Some(Expression::Literal(Literal::String(text.trim_matches('"').to_string())));
            }
        }
        Rule::string_literal => {
            return Some(Expression::Literal(Literal::String(pair.as_str().trim_matches('\'').to_string())));
        }
        Rule::name => {
            return Some(Expression::Variable(pair.as_str().to_string()));
        }
        Rule::qualified_name => {
            // Handle both :: and . separators
            let text = pair.as_str();
            let segments: Vec<String> = if text.contains("::") {
                text.split("::").map(|s| s.to_string()).collect()
            } else if text.contains(".") {
                text.split(".").map(|s| s.to_string()).collect()
            } else {
                vec![text.to_string()]
            };
            return Some(Expression::QualifiedName(segments));
        }
        Rule::expr_unit => {
            // Parse value [unit] expressions
            let mut inner = pair.into_inner();
            if let (Some(value_pair), Some(unit_pair)) = (inner.next(), inner.next()) {
                if let Some(value) = parse_expression(value_pair) {
                    let unit = unit_pair.as_str().trim_matches(|c| c == '[' || c == ']').to_string();
                    return Some(Expression::ValueWithUnit {
                        value: Box::new(value),
                        unit,
                    });
                }
            }
        }
        Rule::expr_index => {
            // Parse frontWheel#(1) style expressions
            // Also supports 'generate torque'.engineTorque#(1)
            let inner = pair.into_inner();
            let mut target_parts = Vec::new();
            let mut index_expr = None;
            
            for p in inner {
                match p.as_rule() {
                    Rule::string_literal => {
                        target_parts.push(p.as_str().trim_matches('\'').to_string());
                    }
                    Rule::name => {
                        if index_expr.is_none() {
                            target_parts.push(p.as_str().to_string());
                        } else {
                            // This is part of the index expression
                            if let Some(expr) = parse_expression(p) {
                                index_expr = Some(expr);
                            }
                        }
                    }
                    Rule::expr_value => {
                        if let Some(expr) = parse_expression(p) {
                            index_expr = Some(expr);
                        }
                    }
                    _ => {}
                }
            }
            
            if !target_parts.is_empty() {
                if let Some(index) = index_expr {
                    let target = if target_parts.len() == 1 {
                        target_parts[0].clone()
                    } else {
                        target_parts.join(".")
                    };
                    return Some(Expression::Index {
                        target,
                        index: Box::new(index),
                    });
                }
            }
        }
        Rule::expr_call => {
            // Parse function calls like 'generate torque'.engineTorque()
            let inner = pair.into_inner();
            let mut func_name_parts = Vec::new();
            let mut args = Vec::new();
            let mut in_args = false;
            
            for p in inner {
                match p.as_rule() {
                    Rule::string_literal => {
                        if !in_args {
                            func_name_parts.push(p.as_str().trim_matches('\'').to_string());
                        }
                    }
                    Rule::name | Rule::qualified_name => {
                        if !in_args {
                            func_name_parts.push(p.as_str().to_string());
                        } else if let Some(expr) = parse_expression(p) {
                            args.push(expr);
                        }
                    }
                    Rule::expr_value => {
                        in_args = true;
                        if let Some(expr) = parse_expression(p) {
                            args.push(expr);
                        }
                    }
                    _ => {}
                }
            }
            
            if !func_name_parts.is_empty() {
                let func_name = func_name_parts.join(".");
                return Some(Expression::FunctionCall(Call {
                    name: func_name,
                    arguments: args,
                }));
            }
        }
        _ => {
            // Try to parse inner pairs
            for inner in pair.into_inner() {
                if let Some(expr) = parse_expression(inner) {
                    return Some(expr);
                }
            }
        }
    }
    
    None
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

