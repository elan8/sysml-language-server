//! State definition and exhibit state parsing.

use pest::iterators::Pairs;
use crate::ast::{ExhibitState, Member, StateDef, TransitionStatement};
use crate::error::Result;
use super::MemberParser;
use super::span::{span_to_position, span_to_source_range};
use super::Rule;

fn parse_transition_statement(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
) -> TransitionStatement {
    let mut name = None;
    let mut source_state = None;
    let mut target_state = None;
    let mut next_is_first = false;
    let mut next_is_then = false;

    for pair in pairs {
        match pair.as_rule() {
            Rule::identifier => {
                let txt = pair.as_str();
                if txt == "first" {
                    next_is_first = true;
                } else if txt == "then" {
                    next_is_then = true;
                } else if next_is_first {
                    source_state = Some(txt.trim_matches('\'').trim_matches('"').to_string());
                    next_is_first = false;
                } else if next_is_then {
                    target_state = Some(txt.trim_matches('\'').trim_matches('"').to_string());
                    next_is_then = false;
                } else if name.is_none() && !matches!(txt, "transition" | "accept" | "if" | "do" | "at" | "when" | "send" | "new" | "action" | "via" | "to")
                {
                    name = Some(txt.trim_matches('\'').trim_matches('"').to_string());
                }
            }
            Rule::name | Rule::qualified_name | Rule::string_literal => {
                let txt = pair.as_str().trim_matches('\'').trim_matches('"');
                if next_is_first {
                    source_state = Some(txt.to_string());
                    next_is_first = false;
                } else if next_is_then {
                    target_state = Some(txt.to_string());
                    next_is_then = false;
                } else if name.is_none() {
                    name = Some(txt.to_string());
                }
            }
            _ => {}
        }
    }

    TransitionStatement {
        name,
        source: source_state,
        target: target_state,
        range: Some(span_to_source_range(span, source)),
    }
}

pub(super) fn parse_state_def<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<StateDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut members = Vec::new();

    for pair in pairs {
        match pair.as_rule() {
            Rule::identifier | Rule::string_literal | Rule::name | Rule::qualified_name => {
                if name.is_empty() {
                    let text = pair.as_str().trim_matches('\'').trim_matches('"');
                    if text != "def" && text != "state" {
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
            Rule::transition_statement => {
                let trans = parse_transition_statement(
                    pair.clone().into_inner(),
                    source,
                    pair.as_span(),
                );
                members.push(Member::TransitionStatement(trans));
            }
            Rule::state_machine_statement | Rule::accept_statement | Rule::statement => {
                // Consumed by the state body; not parsed into Members
            }
            _ => {}
        }
    }

    Ok(StateDef {
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

pub(super) fn parse_exhibit_state<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<ExhibitState> {
    let mut name = String::new();
    let mut name_position = None;
    let mut members = Vec::new();

    for pair in pairs {
        match pair.as_rule() {
            Rule::identifier | Rule::string_literal | Rule::name | Rule::qualified_name => {
                if name.is_empty() {
                    let text = pair.as_str().trim_matches('\'').trim_matches('"');
                    if text != "state" && text != "exhibit" {
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
            _ => {}
        }
    }

    Ok(ExhibitState {
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
