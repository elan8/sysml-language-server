//! Item definition and usage parsing.

use pest::iterators::Pairs;
use crate::ast::{ItemDef, ItemDirection, ItemUsage};
use crate::error::Result;
use super::MemberParser;
use super::Rule;
use super::metadata::parse_metadata_annotation;
use super::span::{span_to_position, span_to_source_range};
use super::expr::parse_multiplicity_str;

pub(super) fn parse_item_def<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<ItemDef> {
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
                if let Ok(member) = parser.parse_member(pair.clone().into_inner(), source) {
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

pub(super) fn parse_item_usage(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ItemUsage> {
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
pub(super) fn parse_ref_item(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ItemUsage> {
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
