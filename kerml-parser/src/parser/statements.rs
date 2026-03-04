//! Statement parsing (bind, allocate, provides, requires) with no parse_member dependency.

use pest::iterators::Pairs;
use crate::ast::{AllocateStatement, BindStatement, ProvidesStatement, RequiresStatement};
use crate::error::Result;
use super::Rule;

/// Parse bind_statement inner pairs: "bind" ~ logical ~ "=" ~ physical ~ ("{" ... "}" | ";")
/// Pest gives us inner pairs for the sub-rules (logical expr, physical expr_value, optional block).
pub(super) fn parse_bind_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<BindStatement> {
    let all: Vec<_> = pairs.collect();
    let mut logical = String::new();
    let mut physical = String::new();
    let mut params = Vec::<(String, String)>::new();
    let mut seen_first = false;
    for pair in &all {
        let s = pair.as_str().trim();
        // Skip literals and block delimiters
        if s == "bind" || s == "=" || s == ";" || s == "{" || s == "}" {
            continue;
        }
        if !seen_first {
            logical = s.to_string();
            seen_first = true;
        } else if physical.is_empty() {
            physical = s.to_string();
        } else {
            // Body: collect params from attribute_usage or assign_statement
            if pair.as_rule() == Rule::attribute_usage {
                if let Some((k, v)) = extract_attribute_usage_param(pair) {
                    params.push((k, v));
                }
            } else if pair.as_rule() == Rule::assign_statement {
                if let Some((k, v)) = extract_assign_statement_param(pair) {
                    params.push((k, v));
                }
            } else {
                for inner in pair.clone().into_inner() {
                    if inner.as_rule() == Rule::attribute_usage {
                        if let Some((k, v)) = extract_attribute_usage_param(&inner) {
                            params.push((k, v));
                        }
                    } else if inner.as_rule() == Rule::assign_statement {
                        if let Some((k, v)) = extract_assign_statement_param(&inner) {
                            params.push((k, v));
                        }
                    }
                }
            }
        }
    }
    Ok(BindStatement { logical, physical, params })
}

fn extract_attribute_usage_param(pair: &pest::iterators::Pair<'_, Rule>) -> Option<(String, String)> {
    let inner: Vec<_> = pair.clone().into_inner().collect();
    let mut name = String::new();
    let mut value = String::new();
    for p in &inner {
        match p.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name => {
                if name.is_empty() {
                    name = p.as_str().trim().to_string();
                } else if value.is_empty() {
                    value = p.as_str().trim().to_string();
                }
            }
            Rule::expr_value | Rule::expr_primary | Rule::expr_atom => {
                value = p.as_str().trim().to_string();
            }
            _ => {}
        }
    }
    if !name.is_empty() {
        Some((name, value))
    } else {
        None
    }
}

fn extract_assign_statement_param(pair: &pest::iterators::Pair<'_, Rule>) -> Option<(String, String)> {
    let inner: Vec<_> = pair.clone().into_inner().collect();
    let mut target = String::new();
    let mut value = String::new();
    let mut seen_assign = false;
    for p in &inner {
        let s = p.as_str().trim();
        if s == ":=" {
            seen_assign = true;
            continue;
        }
        match p.as_rule() {
            Rule::expr_value | Rule::expr_primary | Rule::expr_atom | Rule::name | Rule::qualified_name | Rule::identifier => {
                if !seen_assign {
                    target = s.to_string();
                } else {
                    value = s.to_string();
                }
            }
            _ => {}
        }
    }
    if !target.is_empty() {
        Some((target, value))
    } else {
        None
    }
}

/// Parse allocate_statement inner pairs: "allocate" ~ (name ~ "::>" ~ name | name) ~ "to" ~ (name ~ "::>" ~ name | name) ~ ...
pub(super) fn parse_allocate_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<AllocateStatement> {
    let all: Vec<_> = pairs.collect();
    let mut source = String::new();
    let mut target = String::new();
    let mut to_idx = None;
    for (i, pair) in all.iter().enumerate() {
        let s = pair.as_str().trim();
        if s == "allocate" {
            continue;
        }
        if s == "to" {
            to_idx = Some(i);
            break;
        }
        if source.is_empty() {
            source = s.to_string();
        } else if !s.is_empty() && s != "::>" {
            source.push(' ');
            source.push_str(s);
        }
    }
    if let Some(i) = to_idx {
        for pair in all.iter().skip(i + 1) {
            let s = pair.as_str().trim();
            if s == ";" || s == "{" || s == "}" {
                break;
            }
            if target.is_empty() {
                target = s.to_string();
            } else if !s.is_empty() && s != "::>" {
                target.push(' ');
                target.push_str(s);
            }
        }
    }
    Ok(AllocateStatement { source, target })
}

/// Parse provides_statement: "provides" ~ name ~ ("=" ~ name)? ~ ";"
pub(super) fn parse_provides_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<ProvidesStatement> {
    let mut names: Vec<String> = Vec::new();
    for pair in pairs {
        let s = pair.as_str().trim().trim_matches('\'');
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                if s != "provides" && s != "requires" && !s.is_empty() {
                    names.push(s.to_string());
                }
            }
            _ => {
                // Recurse into optional group ("=" ~ name) to pick up second name
                for inner in pair.into_inner() {
                    let t = inner.as_str().trim().trim_matches('\'');
                    if (inner.as_rule() == Rule::name
                        || inner.as_rule() == Rule::identifier
                        || inner.as_rule() == Rule::qualified_name
                        || inner.as_rule() == Rule::string_literal)
                        && !t.is_empty()
                    {
                        names.push(t.to_string());
                    }
                }
            }
        }
    }
    let capability = names.first().cloned().unwrap_or_default();
    let execution_kind = if names.len() > 1 {
        Some(names[1].clone())
    } else {
        None
    };
    Ok(ProvidesStatement { capability, execution_kind })
}

/// Parse requires_statement: "requires" ~ name ~ ("=" ~ name)? ~ ";"
pub(super) fn parse_requires_statement(pairs: Pairs<'_, Rule>, _source: &str) -> Result<RequiresStatement> {
    let mut names: Vec<String> = Vec::new();
    for pair in pairs {
        let s = pair.as_str().trim().trim_matches('\'');
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                if s != "provides" && s != "requires" && !s.is_empty() {
                    names.push(s.to_string());
                }
            }
            _ => {
                for inner in pair.into_inner() {
                    let t = inner.as_str().trim().trim_matches('\'');
                    if (inner.as_rule() == Rule::name
                        || inner.as_rule() == Rule::identifier
                        || inner.as_rule() == Rule::qualified_name
                        || inner.as_rule() == Rule::string_literal)
                        && !t.is_empty()
                    {
                        names.push(t.to_string());
                    }
                }
            }
        }
    }
    let capability = names.first().cloned().unwrap_or_default();
    let execution_kind = if names.len() > 1 {
        Some(names[1].clone())
    } else {
        None
    };
    Ok(RequiresStatement { capability, execution_kind })
}
