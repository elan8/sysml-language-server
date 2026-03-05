//! Interface definition parsing.

use pest::iterators::Pairs;
use crate::ast::InterfaceDef;
use crate::error::Result;
use super::MemberParser;
use super::Rule;
use super::metadata::parse_metadata_annotation;
use super::span::{span_to_position, span_to_source_range};

pub(super) fn parse_interface_def<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<InterfaceDef> {
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
                if let Ok(member) = parser.parse_member(pair.into_inner(), source) {
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
                    for inner in pair.into_inner() {
                        if inner.as_rule() == Rule::member {
                            if let Ok(member) = parser.parse_member(inner.into_inner(), source) {
                                members.push(member);
                            }
                        } else {
                            for m in inner.into_inner() {
                                if m.as_rule() == Rule::member {
                                    if let Ok(member) = parser.parse_member(m.into_inner(), source) {
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
