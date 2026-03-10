//! Connection usage parsing.

use pest::iterators::Pairs;
use crate::ast::ConnectionUsage;
use crate::error::Result;
use super::span::span_to_source_range;
use super::Rule;

fn extract_identifier_from_expr(pair: pest::iterators::Pair<'_, Rule>) -> Option<String> {
    let rule = pair.as_rule();
    log::debug!("extract_identifier_from_expr: rule={:?}, text={:?}", rule, pair.as_str());
    match rule {
        Rule::name | Rule::qualified_name | Rule::identifier => {
            let ident = pair.as_str().trim().to_string();
            log::debug!("extract_identifier_from_expr: Found identifier: '{}'", ident);
            Some(ident)
        }
        Rule::expr_value | Rule::expr_or | Rule::expr_xor | Rule::expr_and | Rule::expr_compare
        | Rule::expr_add_sub | Rule::expr_mul_div | Rule::expr_power | Rule::expr_primary
        | Rule::expr_atom | Rule::expr_unit | Rule::expr_index | Rule::expr_call
        | Rule::expr_arrow_call | Rule::expr_new => {
            log::debug!("extract_identifier_from_expr: Recursing into {:?}", rule);
            for inner_pair in pair.into_inner() {
                if let Some(ident) = extract_identifier_from_expr(inner_pair) {
                    return Some(ident);
                }
            }
            None
        }
        _ => {
            for inner_pair in pair.into_inner() {
                if let Some(ident) = extract_identifier_from_expr(inner_pair) {
                    return Some(ident);
                }
            }
            None
        }
    }
}

pub(super) fn parse_connection_usage(
    pairs: Pairs<'_, Rule>,
    file_source: &str,
    span: pest::Span<'_>,
) -> Result<ConnectionUsage> {
    let mut source = String::new();
    let mut target = String::new();
    let mut identifiers: Vec<String> = Vec::new();

    for pair in pairs {
        let rule = pair.as_rule();
        log::debug!("parse_connection_usage: Processing rule={:?}, text={:?}", rule, pair.as_str());

        match rule {
            Rule::name | Rule::qualified_name | Rule::identifier => {
                let ident = pair.as_str().trim().to_string();
                if !ident.is_empty() {
                    log::debug!("parse_connection_usage: Found direct identifier: {}", ident);
                    identifiers.push(ident);
                }
            }
            Rule::connect_end => {
                // connect_end matches qualified_name, name, string_literal, etc.
                // Use as_str() to get the full endpoint text (e.g. "flightControl.flightController.motorCmd")
                let ident = pair.as_str().trim().to_string();
                if !ident.is_empty() {
                    log::debug!("parse_connection_usage: Found connect_end: {}", ident);
                    identifiers.push(ident);
                }
            }
            Rule::expr_value | Rule::expr_or | Rule::expr_xor | Rule::expr_and | Rule::expr_compare
            | Rule::expr_add_sub | Rule::expr_mul_div | Rule::expr_power | Rule::expr_primary
            | Rule::expr_atom | Rule::expr_unit | Rule::expr_index | Rule::expr_call
            | Rule::expr_arrow_call | Rule::expr_new => {
                log::debug!(
                    "parse_connection_usage: Found expression rule {:?}, extracting identifier...",
                    rule
                );
                if let Some(ident) = extract_identifier_from_expr(pair) {
                    log::debug!("parse_connection_usage: Extracted identifier from expression: {}", ident);
                    identifiers.push(ident);
                } else {
                    log::debug!("parse_connection_usage: Failed to extract identifier from expression");
                }
            }
            Rule::member => {}
            _ => {}
        }
    }

    if identifiers.len() >= 2 {
        source = identifiers[0].clone();
        target = identifiers[1].clone();
    } else if identifiers.len() == 1 {
        source = identifiers[0].clone();
    }

    log::debug!("parse_connection_usage: source='{}', target='{}'", source, target);
    Ok(ConnectionUsage {
        name: None,
        name_position: None,
        range: Some(span_to_source_range(span, file_source)),
        source,
        target,
    })
}
