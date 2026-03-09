//! Package parsing: package rule, in/end statements.

use pest::iterators::{Pair, Pairs};
use crate::ast::*;
use crate::error::{ParseError, Result};
use log::debug;

use super::Rule;
use super::MemberParser;
use super::span::{span_to_position, span_to_source_range};
use super::part;
use super::port;
use super::requirement;
use super::connection;
use super::interface;
use super::action;
use super::state;

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

fn process_package_pair<P: MemberParser>(
    pair: &Pair<'_, Rule>,
    state: &mut PackageParseState<'_>,
    parser: &P,
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
            match super::document::parse_import(pair.clone().into_inner(), source) {
                Ok(import) => state.imports.push(import),
                Err(e) => return Err(e),
            }
        }
        Rule::member => {
            match parser.parse_member(pair.clone().into_inner(), source) {
                Ok(member) => state.members.push(member),
                Err(e) => return Err(e),
            }
        }
        Rule::part_def => {
            let member_span = pair.as_span();
            match part::parse_part_def(pair.clone().into_inner(), source, member_span, parser) {
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
            match part::parse_part_usage(pair.clone().into_inner(), source, member_span, parser) {
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
            match requirement::parse_requirement_def(pair.clone().into_inner(), requirement_def_full_text, source, member_span, parser) {
                Ok(req_def) => state.members.push(Member::RequirementDef(req_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::requirement_usage => {
            let member_span = pair.as_span();
            match requirement::parse_requirement_usage(pair.clone().into_inner(), source, member_span, parser) {
                Ok(req_usage) => state.members.push(Member::RequirementUsage(req_usage)),
                Err(e) => return Err(e),
            }
        }
        Rule::action_def => {
            let member_span = pair.as_span();
            match action::parse_action_def(pair.clone().into_inner(), source, member_span) {
                Ok(action_def) => state.members.push(Member::ActionDef(action_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::state_def => {
            let member_span = pair.as_span();
            match state::parse_state_def(pair.clone().into_inner(), source, member_span, parser) {
                Ok(state_def) => state.members.push(Member::StateDef(state_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::connection_usage => {
            let conn_span = pair.as_span();
            match connection::parse_connection_usage(pair.clone().into_inner(), source, conn_span) {
                Ok(conn) => state.members.push(Member::ConnectionUsage(conn)),
                Err(e) => return Err(e),
            }
        }
        Rule::port_def => {
            let member_span = pair.as_span();
            match port::parse_port_def(pair.clone().into_inner(), source, member_span, parser) {
                Ok(port_def) => state.members.push(Member::PortDef(port_def)),
                Err(e) => return Err(e),
            }
        }
        Rule::interface_def => {
            let member_span = pair.as_span();
            match interface::parse_interface_def(pair.clone().into_inner(), source, member_span, parser) {
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
            let inner: Vec<_> = pair.clone().into_inner().collect();
            for inner_pair in &inner {
                process_package_pair(inner_pair, state, parser)?;
            }
        }
    }
    Ok(())
}

pub(super) fn parse_package<P: MemberParser>(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>, parser: &P) -> Result<Package> {
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
        process_package_pair(pair, &mut state, parser)?;
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

pub(super) fn parse_in_statement(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<InStatement> {
    let mut name = String::new();
    let mut name_position = None;
    let mut specializes = None;
    let mut specializes_position = None;
    let mut type_ref = None;
    let mut type_ref_position = None;
    let mut next_is_specializes = false;
    let mut next_is_type = false;

    #[allow(clippy::too_many_arguments)]
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

pub(super) fn parse_end_statement(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<EndStatement> {
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
