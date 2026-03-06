//! Use case and actor parsing.

use pest::iterators::Pairs;
use crate::ast::ActorDef;
use crate::ast::Member;
use crate::ast::UseCase;
use crate::error::Result;
use super::MemberParser;
use super::span::{span_to_position, span_to_source_range};
use super::Rule;

pub(super) fn parse_use_case<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<UseCase> {
    let mut name = String::new();
    let mut name_position = None;
    let mut members = Vec::new();

    for pair in pairs {
        match pair.as_rule() {
            Rule::identifier | Rule::string_literal | Rule::name | Rule::qualified_name => {
                if name.is_empty() {
                    let text = pair.as_str().trim_matches('\'').trim_matches('"');
                    if text != "use" && text != "case" {
                        name = text.to_string();
                        name_position = Some(span_to_position(pair.as_span(), source));
                    }
                }
            }
            Rule::member => {
                if let Ok(member) = parser.parse_member(pair.clone().into_inner(), source) {
                    members.push(member);
                }
            }
            Rule::actor_statement => {
                let inner_span = pair.as_span();
                if let Ok(actor) = parse_actor_statement(pair.clone().into_inner(), source, inner_span, parser) {
                    members.push(Member::ActorDef(actor));
                }
            }
            _ => {}
        }
    }

    Ok(UseCase {
        name: if name.is_empty() {
            "(anonymous)".to_string()
        } else {
            name
        },
        name_position,
        range: Some(span_to_source_range(span, source)),
        members,
    })
}

pub(super) fn parse_actor_statement<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<ActorDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut type_ref = None;
    let mut members = Vec::new();
    let mut seen_name = false;

    for pair in pairs {
        match pair.as_rule() {
            Rule::identifier | Rule::string_literal | Rule::name | Rule::qualified_name => {
                let text = pair.as_str().trim_matches('\'').trim_matches('"');
                if text != "actor" && !name.is_empty() && type_ref.is_none() {
                    type_ref = Some(text.to_string());
                } else if text != "actor" && !seen_name {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    seen_name = true;
                }
            }
            Rule::member => {
                if let Ok(member) = parser.parse_member(pair.clone().into_inner(), source) {
                    members.push(member);
                }
            }
            _ => {}
        }
    }

    Ok(ActorDef {
        name: if name.is_empty() {
            "(anonymous)".to_string()
        } else {
            name
        },
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref,
        members,
    })
}
