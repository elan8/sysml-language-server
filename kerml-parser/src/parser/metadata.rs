//! Metadata annotation parsing.

use std::collections::HashMap;
use pest::iterators::Pair;
use crate::ast::MetadataAnnotation;
use crate::error::{ParseError, Result};
use super::Rule;

/// Parse a metadata annotation (e.g., @Layer(name = "02_SystemContext"))
pub(super) fn parse_metadata_annotation(pair: Pair<'_, Rule>) -> Result<MetadataAnnotation> {
    let mut inner = pair.into_inner();
    let name_pair = inner.next().ok_or_else(|| ParseError::PestError("Metadata annotation missing name".to_string(), None))?;
    let name = name_pair.as_str().to_string();

    let mut attributes = HashMap::new();

    // Collect all remaining inner pairs
    let inner_vec: Vec<_> = inner.collect();
    log::debug!("parse_metadata_annotation: {} has {} inner pairs after name", name, inner_vec.len());

    // Check if there's a parenthesized attribute list: @Layer(name = "value") or @style(a = 1, b = "x")
    // Pest gives us: identifier, value, identifier, value, ... (pairs; "=" and "," are not separate)
    let mut i = 0;
    while i + 1 < inner_vec.len() {
        let attr_name_pair = &inner_vec[i];
        let value_pair = &inner_vec[i + 1];
        if attr_name_pair.as_rule() == Rule::identifier {
            let attr_name = attr_name_pair.as_str().trim();
            let value = match value_pair.as_rule() {
                Rule::string_literal | Rule::string => {
                    value_pair.as_str().trim_matches('"').trim_matches('\'').to_string()
                }
                Rule::identifier => value_pair.as_str().to_string(),
                Rule::integer | Rule::float => value_pair.as_str().to_string(),
                _ => value_pair.as_str().to_string(),
            };
            log::debug!("parse_metadata_annotation: Adding attribute {} = {}", attr_name, value);
            attributes.insert(attr_name.to_string(), value);
        }
        i += 2;
    }

    log::debug!("parse_metadata_annotation: Final result - name={}, attributes={:?}", name, attributes);
    Ok(MetadataAnnotation { name, attributes })
}
