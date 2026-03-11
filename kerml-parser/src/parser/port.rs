//! Port definition and usage parsing.

use pest::iterators::Pairs;
use crate::ast::{MetadataAnnotation, Member, PortDef, PortUsage, SourcePosition};
use crate::error::Result;
use super::MemberParser;
use super::Rule;
use super::metadata::parse_metadata_annotation;
use super::span::{span_to_position, span_to_source_range};

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

fn process_port_def_pair<P: MemberParser>(
    pair: pest::iterators::Pair<'_, Rule>,
    acc: &mut PortDefAccumulator,
    source: &str,
    parser: &P,
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
                let span_len = pair.as_span().end() - pair.as_span().start();
                if span_len <= text.len() + 1 {
                    acc.type_ref_position = Some(span_to_position(pair.as_span(), source));
                }
                acc.next_is_type = false;
            }
        }
        Rule::member => {
            if let Ok(member) = parser.parse_member(pair.into_inner(), source) {
                acc.members.push(member);
            }
        }
        Rule::item_usage => {
            let span = pair.as_span();
            if let Ok(i) = super::item::parse_item_usage(pair.into_inner(), source, span) {
                acc.members.push(Member::ItemUsage(i));
            }
        }
        Rule::out_statement => {
            let span = pair.as_span();
            if let Ok(i) = super::item::parse_out_statement(pair.into_inner(), source, span) {
                acc.members.push(Member::ItemUsage(i));
            }
        }
        Rule::in_statement => {
            let span = pair.as_span();
            if let Ok(i) = super::package::parse_in_statement(pair.into_inner(), source, span) {
                acc.members.push(Member::InStatement(i));
            }
        }
        Rule::inout_statement => {
            let span = pair.as_span();
            if let Ok(i) = super::item::parse_inout_statement(pair.into_inner(), source, span) {
                acc.members.push(Member::ItemUsage(i));
            }
        }
        Rule::port_body => {
            for inner in pair.into_inner() {
                process_port_def_pair(inner, acc, source, parser);
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
                    process_port_def_pair(inner, acc, source, parser);
                }
            }
        }
    }
}

pub(super) fn parse_port_def<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<PortDef> {
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
        process_port_def_pair(pair, &mut acc, source, parser);
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

fn process_port_usage_pair<P: MemberParser>(
    pair: pest::iterators::Pair<'_, Rule>,
    acc: &mut PortUsageAccumulator,
    source: &str,
    parser: &P,
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
                let span_len = pair.as_span().end() - pair.as_span().start();
                if span_len <= text.len() + 1 {
                    acc.type_ref_position = Some(span_to_position(pair.as_span(), source));
                }
                acc.next_is_type = false;
            }
        }
        Rule::member => {
            if let Ok(member) = parser.parse_member(pair.into_inner(), source) {
                acc.members.push(member);
            }
        }
        Rule::item_usage => {
            let span = pair.as_span();
            if let Ok(i) = super::item::parse_item_usage(pair.into_inner(), source, span) {
                acc.members.push(Member::ItemUsage(i));
            }
        }
        Rule::out_statement => {
            let span = pair.as_span();
            if let Ok(i) = super::item::parse_out_statement(pair.into_inner(), source, span) {
                acc.members.push(Member::ItemUsage(i));
            }
        }
        Rule::in_statement => {
            let span = pair.as_span();
            if let Ok(i) = super::package::parse_in_statement(pair.into_inner(), source, span) {
                acc.members.push(Member::InStatement(i));
            }
        }
        Rule::inout_statement => {
            let span = pair.as_span();
            if let Ok(i) = super::item::parse_inout_statement(pair.into_inner(), source, span) {
                acc.members.push(Member::ItemUsage(i));
            }
        }
        Rule::port_body => {
            for inner in pair.into_inner() {
                process_port_usage_pair(inner, acc, source, parser);
            }
        }
        _ => {
            if pair.as_str() == ":" {
                acc.next_is_type = true;
            } else {
                for inner in pair.into_inner() {
                    process_port_usage_pair(inner, acc, source, parser);
                }
            }
        }
    }
}

pub(super) fn parse_port_usage<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<PortUsage> {
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
        process_port_usage_pair(pair, &mut acc, source, parser);
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
