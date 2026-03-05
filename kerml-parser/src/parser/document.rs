//! Document and import parsing: top-level document rule and import statements.

use pest::iterators::Pairs;
use crate::ast::*;
use crate::error::Result;
use log::debug;

use super::Rule;
use super::MemberParser;
use super::span::span_to_position;
use super::package;
use super::part;
use super::metadata::parse_metadata_annotation;
use super::statements::parse_allocate_statement;

pub(super) fn parse_document<P: MemberParser>(pairs: Pairs<'_, Rule>, source: &str, parser: &P) -> Result<SysMLDocument> {
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
                match package::parse_package(pair.clone().into_inner(), source, span, parser) {
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
                match parser.parse_member(pair.clone().into_inner(), source) {
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
                match part::parse_part_usage(pair.clone().into_inner(), source, span, parser) {
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
                match part::parse_part_def(pair.clone().into_inner(), source, span, parser) {
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

pub(super) fn parse_import(pairs: Pairs<'_, Rule>, source: &str) -> Result<Import> {
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
