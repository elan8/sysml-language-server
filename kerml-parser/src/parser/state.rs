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
    const SKIP: &[&str] = &["transition", "accept", "if", "do", "at", "when", "send", "new", "action", "via", "to", "first", "then"];

    let mut name = None;
    let mut source_state = None;
    let mut target_state = None;
    let mut all_names: Vec<String> = Vec::new();

    fn collect(pair: pest::iterators::Pair<'_, Rule>, names: &mut Vec<String>) {
        let txt = pair.as_str().trim_matches('\'').trim_matches('"');
        match pair.as_rule() {
            Rule::identifier | Rule::name | Rule::qualified_name | Rule::string_literal => {
                if !txt.is_empty() && !SKIP.contains(&txt) {
                    names.push(txt.to_string());
                }
            }
            _ => {
                for inner in pair.into_inner() {
                    collect(inner, names);
                }
            }
        }
    }

    for pair in pairs {
        collect(pair, &mut all_names);
    }

    // Pattern "transition [name] first A then B": last two names are source, target
    if all_names.len() >= 2 {
        source_state = Some(all_names[all_names.len() - 2].clone());
        target_state = Some(all_names.last().cloned().unwrap());
    }
    // If 3+ names, first is transition name (e.g. "transition t first a then b")
    if all_names.len() >= 3 {
        name = Some(all_names[0].clone());
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
            Rule::state_def => {
                match parse_state_def(pair.clone().into_inner(), source, pair.as_span(), parser) {
                    Ok(s) => members.push(Member::StateDef(s)),
                    Err(_) => {}
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
