//! Expression and multiplicity parsing (no parse_member dependency).

use pest::iterators::Pair;
use crate::ast::{Call, Expression, Literal, Multiplicity};
use super::Rule;

pub(super) fn parse_multiplicity_str(text: &str) -> Option<Multiplicity> {
    let inner = text.trim_matches(|c| c == '[' || c == ']');

    if inner == "*" {
        return Some(Multiplicity::Unbounded);
    }

    if inner.contains("..") {
        let parts: Vec<&str> = inner.split("..").collect();
        if parts.len() == 2 {
            if let (Ok(start), Ok(end)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                return Some(Multiplicity::Range(start, end));
            }
        }
    } else if let Ok(n) = inner.parse::<u32>() {
        return Some(Multiplicity::Fixed(n));
    }

    None
}

pub(super) fn parse_expression(pair: Pair<'_, Rule>) -> Option<Expression> {
    match pair.as_rule() {
        Rule::expr_value => {
            // Get the first inner pair
            if let Some(inner) = pair.into_inner().next() {
                return parse_expression(inner);
            }
        }
        Rule::expr_atom | Rule::expr_primary => {
            // For expr_atom, we need to check the structure
            let mut inner = pair.into_inner().peekable();
            if let Some(first) = inner.next() {
                // Check if this is a string_literal.field pattern
                if first.as_rule() == Rule::string_literal {
                    let base = first.as_str().trim_matches('\'').to_string();
                    // Collect the field names (the "." ~ name parts)
                    let mut fields = vec![base];
                    let mut collecting_fields = true;
                    for next_pair in inner {
                        if collecting_fields && next_pair.as_rule() == Rule::name {
                            fields.push(next_pair.as_str().to_string());
                        } else {
                            // If we hit something else, try to parse it
                            if let Some(expr) = parse_expression(next_pair) {
                                // This shouldn't happen in expr_atom, but handle it
                                return Some(expr);
                            }
                            collecting_fields = false;
                        }
                    }
                    if fields.len() > 1 {
                        // This is a qualified name with dots like 'generate torque'.engineTorque
                        return Some(Expression::QualifiedName(fields));
                    } else {
                        // Just a string literal
                        return Some(Expression::Literal(Literal::String(fields[0].clone())));
                    }
                }
                // Otherwise, recurse
                return parse_expression(first);
            }
        }
        Rule::literal | Rule::integer | Rule::float | Rule::string | Rule::boolean => {
            let text = pair.as_str();
            if let Ok(n) = text.parse::<i64>() {
                return Some(Expression::Literal(Literal::Integer(n)));
            } else if let Ok(f) = text.parse::<f64>() {
                return Some(Expression::Literal(Literal::Float(f)));
            } else if text == "true" {
                return Some(Expression::Literal(Literal::Boolean(true)));
            } else if text == "false" {
                return Some(Expression::Literal(Literal::Boolean(false)));
            } else {
                return Some(Expression::Literal(Literal::String(text.trim_matches('"').to_string())));
            }
        }
        Rule::string_literal => {
            return Some(Expression::Literal(Literal::String(pair.as_str().trim_matches('\'').to_string())));
        }
        Rule::name => {
            return Some(Expression::Variable(pair.as_str().to_string()));
        }
        Rule::qualified_name => {
            // Handle both :: and . separators
            let text = pair.as_str();
            let segments: Vec<String> = if text.contains("::") {
                text.split("::").map(|s| s.to_string()).collect()
            } else if text.contains(".") {
                text.split(".").map(|s| s.to_string()).collect()
            } else {
                vec![text.to_string()]
            };
            return Some(Expression::QualifiedName(segments));
        }
        Rule::expr_unit => {
            // Parse value [unit] expressions
            let mut inner = pair.into_inner();
            if let (Some(value_pair), Some(unit_pair)) = (inner.next(), inner.next()) {
                if let Some(value) = parse_expression(value_pair) {
                    let unit = unit_pair.as_str().trim_matches(|c| c == '[' || c == ']').to_string();
                    return Some(Expression::ValueWithUnit {
                        value: Box::new(value),
                        unit,
                    });
                }
            }
        }
        Rule::expr_index => {
            // Parse frontWheel#(1) style expressions
            // Also supports 'generate torque'.engineTorque#(1)
            let inner = pair.into_inner();
            let mut target_parts = Vec::new();
            let mut index_expr = None;

            for p in inner {
                match p.as_rule() {
                    Rule::string_literal => {
                        target_parts.push(p.as_str().trim_matches('\'').to_string());
                    }
                    Rule::name => {
                        if index_expr.is_none() {
                            target_parts.push(p.as_str().to_string());
                        } else {
                            // This is part of the index expression
                            if let Some(expr) = parse_expression(p) {
                                index_expr = Some(expr);
                            }
                        }
                    }
                    Rule::expr_value => {
                        if let Some(expr) = parse_expression(p) {
                            index_expr = Some(expr);
                        }
                    }
                    _ => {}
                }
            }

            if !target_parts.is_empty() {
                if let Some(index) = index_expr {
                    let target = if target_parts.len() == 1 {
                        target_parts[0].clone()
                    } else {
                        target_parts.join(".")
                    };
                    return Some(Expression::Index {
                        target,
                        index: Box::new(index),
                    });
                }
            }
        }
        Rule::expr_call => {
            // Parse function calls like 'generate torque'.engineTorque()
            let inner = pair.into_inner();
            let mut func_name_parts = Vec::new();
            let mut args = Vec::new();
            let mut in_args = false;

            for p in inner {
                match p.as_rule() {
                    Rule::string_literal => {
                        if !in_args {
                            func_name_parts.push(p.as_str().trim_matches('\'').to_string());
                        }
                    }
                    Rule::name | Rule::qualified_name => {
                        if !in_args {
                            func_name_parts.push(p.as_str().to_string());
                        } else if let Some(expr) = parse_expression(p) {
                            args.push(expr);
                        }
                    }
                    Rule::expr_value => {
                        in_args = true;
                        if let Some(expr) = parse_expression(p) {
                            args.push(expr);
                        }
                    }
                    _ => {}
                }
            }

            if !func_name_parts.is_empty() {
                let func_name = func_name_parts.join(".");
                return Some(Expression::FunctionCall(Call {
                    name: func_name,
                    arguments: args,
                }));
            }
        }
        _ => {
            // Try to parse inner pairs
            for inner in pair.into_inner() {
                if let Some(expr) = parse_expression(inner) {
                    return Some(expr);
                }
            }
        }
    }

    None
}
