//! Attribute definition and usage parsing.

use pest::iterators::Pairs;
use crate::ast::*;
use crate::error::Result;
use super::MemberParser;
use super::Rule;
use super::expr::{parse_expression, parse_multiplicity_str};
use super::span::{span_to_position, span_to_source_range};

pub(super) fn parse_attribute_def<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<AttributeDef> {
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

    let mut name_position: Option<SourcePosition> = None;
    let mut specializes_position: Option<SourcePosition> = None;
    let mut type_ref_position: Option<SourcePosition> = None;
    let mut default_value_position: Option<SourcePosition> = None;

    log::debug!("parse_attribute_def: Starting to parse");
    for pair in pairs {
        log::debug!("parse_attribute_def: Rule {:?}, text: {:?}", pair.as_rule(), pair.as_str());
        match pair.as_rule() {
            Rule::name | Rule::qualified_name | Rule::identifier => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    let span_len = pair.as_span().end() - pair.as_span().start();
                    if span_len <= name.len() + 1 && text != "attribute" {
                        name_position = Some(span_to_position(pair.as_span(), source));
                    }
                    log::debug!("parse_attribute_def: Set name to: '{}' at line {}", name, name_position.as_ref().map(|p| p.line).unwrap_or(0));
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    specializes_position = Some(span_to_position(pair.as_span(), source));
                    next_is_specialization = false;
                } else if next_is_type {
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    next_is_type = false;
                    log::debug!("parse_attribute_def: Set type_ref to: '{}' at line {}", type_ref.as_ref().unwrap(), type_ref_position.as_ref().unwrap().line);
                } else if next_is_redefines {
                    redefines = Some(text.to_string());
                    next_is_redefines = false;
                } else if !name.is_empty() && type_ref.is_none() && specializes.is_none() && default_value.is_none() && !next_is_value {
                    type_ref = Some(text.to_string());
                    type_ref_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_attribute_def: Set type_ref to: '{}' (inferred from position) at line {}", type_ref.as_ref().unwrap(), type_ref_position.as_ref().unwrap().line);
                }
            }
            Rule::expr_value | Rule::expr_primary | Rule::expr_atom | Rule::expr_or => {
                if !name.is_empty() && default_value.is_none() && !next_is_type && !next_is_specialization {
                    if type_ref.is_some() || (type_ref.is_none() && specializes.is_none()) {
                        log::debug!("parse_attribute_def: Found expr_value/expr_primary/expr_atom/expr_or after name/type_ref, assuming it's default_value");
                        default_value = parse_expression(pair.clone());
                        default_value_position = Some(span_to_position(pair.as_span(), source));
                        log::debug!("parse_attribute_def: Parsed default_value: {:?} at line {}", default_value, default_value_position.as_ref().unwrap().line);
                    }
                } else if next_is_value {
                    log::debug!("parse_attribute_def: Found expr_value/expr_primary/expr_atom/expr_or with next_is_value=true, parsing expression...");
                    default_value = parse_expression(pair.clone());
                    default_value_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_attribute_def: Parsed default_value: {:?} at line {}", default_value, default_value_position.as_ref().unwrap().line);
                    next_is_value = false;
                }
            }
            Rule::literal | Rule::integer | Rule::float | Rule::string | Rule::boolean => {
                if !name.is_empty() && default_value.is_none() && !next_is_type && !next_is_specialization {
                    if type_ref.is_some() || (type_ref.is_none() && specializes.is_none()) {
                        log::debug!("parse_attribute_def: Found literal/integer/float/string/boolean after name/type_ref, assuming it's default_value");
                        default_value = parse_expression(pair);
                        log::debug!("parse_attribute_def: Parsed default_value: {:?}", default_value);
                    }
                } else if next_is_value {
                    log::debug!("parse_attribute_def: Found literal/integer/float/string/boolean with next_is_value=true, parsing expression...");
                    default_value = parse_expression(pair);
                    log::debug!("parse_attribute_def: Parsed default_value: {:?}", default_value);
                    next_is_value = false;
                }
            }
            Rule::member => {
                if let Ok(member) = parser.parse_member(pair.into_inner(), source) {
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
                    log::debug!("parse_attribute_def: Found = or default, setting next_is_value = true");
                    next_is_value = true;
                } else if text.starts_with('[') {
                    multiplicity = parse_multiplicity_str(text);
                }
            }
        }
    }

    log::debug!("parse_attribute_def: Final result - name='{}', default_value={:?}", name, default_value);
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

pub(super) fn parse_attribute_usage<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<AttributeUsage> {
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
                if let Ok(member) = parser.parse_member(pair.into_inner(), source) {
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
