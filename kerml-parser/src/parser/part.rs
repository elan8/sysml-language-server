//! Part definition and usage parsing.

use pest::iterators::Pairs;
use crate::ast::{Member, PartDef, PartUsage};
use crate::error::Result;
use super::MemberParser;
use super::Rule;
use super::attribute;
use super::connection;
use super::metadata::parse_metadata_annotation;
use super::port;
use super::requirement;
use super::span::{span_to_position, span_to_source_range};
use super::expr::{parse_expression, parse_multiplicity_str};
use super::statements::{parse_provides_statement, parse_requires_statement};

pub(super) fn parse_part_def<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<PartDef> {
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

    log::debug!("parse_part_def: Starting to parse");
    let all_pairs: Vec<_> = pairs.collect();
    log::debug!("parse_part_def: Processing {} pairs", all_pairs.len());
    for (idx, pair) in all_pairs.iter().enumerate() {
        log::debug!(
            "parse_part_def: Pair[{}] rule={:?}, text={:?}, inner_count={}",
            idx,
            pair.as_rule(),
            pair.as_str(),
            pair.clone().into_inner().count()
        );
        let inner_pairs: Vec<_> = pair.clone().into_inner().collect();
        if !inner_pairs.is_empty() {
            log::debug!(
                "parse_part_def: Pair[{}] has {} inner pairs: {:?}",
                idx,
                inner_pairs.len(),
                inner_pairs
                    .iter()
                    .map(|p| (p.as_rule(), p.as_str()))
                    .collect::<Vec<_>>()
            );
        }
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if !seen_name {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    seen_name = true;
                    log::debug!("parse_part_def: Set name to: {}", name);
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_part_def: Set specializes to: {:?}", specializes);
                    next_is_specialization = false;
                } else if seen_colon {
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_part_def: Set type_ref to: {:?}", type_ref);
                    seen_colon = false;
                } else if specializes.is_none() && type_ref.is_none() {
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_part_def: Inferred specializes from second identifier: {:?}", specializes);
                } else {
                    log::debug!(
                        "parse_part_def: Ignoring identifier '{}' (seen_name={}, next_is_specialization={}, seen_colon={}, specializes={:?}, type_ref={:?})",
                        text, seen_name, next_is_specialization, seen_colon, specializes, type_ref
                    );
                }
            }
            Rule::member => {
                if let Ok(member) = parser.parse_member(pair.clone().into_inner(), source) {
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
                if let Ok(part_usage) = parse_part_usage(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::PartUsage(part_usage));
                }
            }
            Rule::port_usage => {
                let inner_span = pair.as_span();
                if let Ok(port_usage) = port::parse_port_usage(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::PortUsage(port_usage));
                }
            }
            Rule::connection_usage => {
                let inner_span = pair.as_span();
                if let Ok(conn_usage) = connection::parse_connection_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::ConnectionUsage(conn_usage));
                }
            }
            Rule::requirement_usage => {
                let inner_span = pair.as_span();
                if let Ok(req_usage) = requirement::parse_requirement_usage(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::RequirementUsage(req_usage));
                }
            }
            Rule::attribute_def => {
                let inner_span = pair.as_span();
                if let Ok(attr_def) = attribute::parse_attribute_def(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::AttributeDef(attr_def));
                }
            }
            Rule::part_def => {
                let inner_span = pair.as_span();
                if let Ok(nested_part_def) = parse_part_def(pair.clone().into_inner(), source, inner_span, parser) {
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
                    if let Some(next_pair) = all_pairs.get(idx + 1) {
                        if next_pair.as_str() == ">" {
                            next_is_specialization = true;
                            log::debug!("parse_part_def: Saw ':>', set next_is_specialization = true");
                        } else {
                            seen_colon = true;
                            log::debug!("parse_part_def: Saw ':' (not followed by '>'), set seen_colon = true");
                        }
                    } else {
                        seen_colon = true;
                        log::debug!("parse_part_def: Saw ':' (no next token), set seen_colon = true");
                    }
                } else if text == ">" && idx > 0 && all_pairs.get(idx - 1).map(|p| p.as_str()) == Some(":") {
                    log::debug!("parse_part_def: Saw '>' (part of ':>'), already handled");
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                } else {
                    log::trace!("parse_part_def: Unhandled text in _ branch: {:?}", text);
                }
            }
        }
    }

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

pub(super) fn parse_part_usage<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<PartUsage> {
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

    log::debug!("parse_part_usage: Starting to parse");
    let all_pairs: Vec<_> = pairs.collect();
    log::debug!("parse_part_usage: Processing {} pairs", all_pairs.len());
    for (idx, pair) in all_pairs.iter().enumerate() {
        let inner_pairs: Vec<_> = pair.clone().into_inner().collect();
        log::debug!(
            "parse_part_usage: Pair[{}] rule={:?}, text={:?}, has {} inner pairs",
            idx,
            pair.as_rule(),
            pair.as_str(),
            inner_pairs.len()
        );
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if !seen_name {
                    name = Some(text.to_string());
                    name_position = Some(span_to_position(pair.as_span(), source));
                    seen_name = true;
                    log::debug!("parse_part_usage: Set name to: {:?}", name);
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    next_is_specialization = false;
                } else if next_is_type || (!next_is_redefines && !next_is_subsets && type_ref.is_none()) {
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    next_is_type = false;
                    log::debug!("parse_part_usage: Set type_ref to: {:?}", type_ref);
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
                if let Ok(member) = parser.parse_member(pair.clone().into_inner(), source) {
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
                if let Ok(attr_def) = attribute::parse_attribute_def(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::AttributeDef(attr_def));
                }
            }
            Rule::part_usage => {
                let inner_span = pair.as_span();
                if let Ok(part_usage) = parse_part_usage(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::PartUsage(part_usage));
                }
            }
            Rule::connection_usage => {
                let inner_span = pair.as_span();
                if let Ok(conn_usage) = connection::parse_connection_usage(pair.clone().into_inner(), source, inner_span) {
                    members.push(Member::ConnectionUsage(conn_usage));
                }
            }
            Rule::port_usage => {
                let inner_span = pair.as_span();
                if let Ok(port_usage) = port::parse_port_usage(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::PortUsage(port_usage));
                }
            }
            _ => {
                let text = pair.as_str();
                log::trace!("parse_part_usage: Other rule {:?}, text: {:?}", pair.as_rule(), text);
                if text == "ordered" {
                    ordered = true;
                } else if text == ":>" {
                    next_is_specialization = true;
                    log::trace!("parse_part_usage: Set next_is_specialization = true");
                } else if text == ":" && !next_is_specialization {
                    next_is_type = true;
                    log::trace!("parse_part_usage: Set next_is_type = true (saw ':')");
                } else if text == "redefines" {
                    next_is_redefines = true;
                } else if text == "subsets" {
                    next_is_subsets = true;
                } else if text == "=" {
                    next_is_value = true;
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                } else {
                    log::trace!("parse_part_usage: Unhandled text: {:?}", text);
                }
            }
        }
    }

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
