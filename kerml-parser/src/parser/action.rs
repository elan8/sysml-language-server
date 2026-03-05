//! Action definition parsing.

use pest::iterators::Pairs;
use crate::ast::ActionDef;
use crate::error::Result;
use super::span::{span_to_position, span_to_source_range};
use super::Rule;

pub(super) fn parse_action_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ActionDef> {
    let mut name = String::new();
    let mut name_position = None;

    for pair in pairs {
        match pair.as_rule() {
            Rule::identifier | Rule::string_literal => {
                if name.is_empty() {
                    name = pair.as_str().to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_action_def: Found name: {}", name);
                }
            }
            _ => {
                log::debug!("parse_action_def: Skipping rule {:?}", pair.as_rule());
            }
        }
    }

    log::debug!("parse_action_def: Returning ActionDef with name: {}", name);
    Ok(ActionDef {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        body: Vec::new(),
    })
}
