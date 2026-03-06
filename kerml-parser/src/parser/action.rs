//! Action definition parsing.

use pest::iterators::Pairs;
use crate::ast::{ActionDef, Assignment, Call, Expression, PerformAction, Statement};
use crate::error::Result;
use super::expr::parse_expression;
use super::span::{span_to_position, span_to_source_range};
use super::Rule;

fn expr_to_target_string(expr: &Expression) -> String {
    use crate::ast::Expression;
    match expr {
        Expression::Variable(s) => s.clone(),
        Expression::QualifiedName(parts) => parts.join("."),
        Expression::Index { target, index } => format!("{}#({})", target, expr_to_target_string(index)),
        _ => String::new(),
    }
}

fn parse_assign_statement(pairs: Pairs<'_, Rule>) -> Option<Statement> {
    let mut exprs: Vec<Expression> = Vec::new();

    for pair in pairs {
        if pair.as_rule() == Rule::expr_value {
            if let Some(expr) = parse_expression(pair) {
                exprs.push(expr);
            }
        }
    }

    if exprs.len() >= 2 {
        let target = expr_to_target_string(&exprs[0]);
        Some(Statement::Assignment(Assignment {
            target: if target.is_empty() {
                "(anonymous)".to_string()
            } else {
                target
            },
            expression: exprs.into_iter().nth(1).unwrap(),
        }))
    } else {
        None
    }
}

fn collect_body_statements(pair: pest::iterators::Pair<'_, Rule>, body: &mut Vec<Statement>) {
    match pair.as_rule() {
        Rule::assign_statement => {
            if let Some(stmt) = parse_assign_statement(pair.into_inner()) {
                body.push(stmt);
            }
        }
        Rule::perform_action => {
            if let Some(stmt) = parse_perform_action(pair.into_inner()) {
                body.push(stmt);
            }
        }
        Rule::send_node_statement => {
            let inner = pair.into_inner();
            for p in inner {
                if p.as_rule() == Rule::expr_value {
                    if let Some(expr) = parse_expression(p) {
                        let name_str = expr_to_target_string(&expr);
                        if !name_str.is_empty() {
                            body.push(Statement::Call(Call {
                                name: format!("send {}", name_str),
                                arguments: vec![],
                            }));
                        }
                    }
                    break;
                }
            }
        }
        _ => {
            for inner in pair.into_inner() {
                collect_body_statements(inner, body);
            }
        }
    }
}

fn parse_perform_action(pairs: Pairs<'_, Rule>) -> Option<Statement> {
    let mut action_ref = String::new();

    for pair in pairs {
        match pair.as_rule() {
            Rule::string_literal | Rule::name | Rule::qualified_name | Rule::identifier => {
                let txt = pair.as_str().trim_matches('\'').trim_matches('"');
                if txt != "perform" && txt != "action" && action_ref.is_empty() {
                    action_ref = txt.to_string();
                }
            }
            Rule::expr_value => {
                if let Some(expr) = parse_expression(pair) {
                    action_ref = expr_to_target_string(&expr);
                }
            }
            _ => {}
        }
    }

    if action_ref.is_empty() {
        None
    } else {
        Some(Statement::PerformAction(PerformAction { action_ref }))
    }
}

pub(super) fn parse_action_def(pairs: Pairs<'_, Rule>, source: &str, span: pest::Span<'_>) -> Result<ActionDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut body = Vec::new();
    let mut seen_def = false;

    for pair in pairs {
        match pair.as_rule() {
            Rule::name | Rule::qualified_name => {
                if seen_def && name.is_empty() {
                    let txt = pair.as_str().trim_matches('\'').trim_matches('"');
                    name = txt.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                }
            }
            Rule::identifier | Rule::string_literal => {
                let txt = pair.as_str();
                if txt == "def" {
                    seen_def = true;
                } else if seen_def && name.is_empty() && txt != "action" {
                    name = txt.trim_matches('\'').trim_matches('"').to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                }
            }
            Rule::assign_statement => {
                if let Some(stmt) = parse_assign_statement(pair.into_inner()) {
                    body.push(stmt);
                }
            }
            Rule::perform_action => {
                if let Some(stmt) = parse_perform_action(pair.into_inner()) {
                    body.push(stmt);
                }
            }
            Rule::send_node_statement => {
                collect_body_statements(pair.clone(), &mut body);
            }
            Rule::item_usage | Rule::statement | Rule::member => {
                collect_body_statements(pair.clone(), &mut body);
            }
            _ => {
                collect_body_statements(pair.clone(), &mut body);
            }
        }
    }

    Ok(ActionDef {
        name: if name.is_empty() {
            "(anonymous)".to_string()
        } else {
            name
        },
        name_position,
        range: Some(span_to_source_range(span, source)),
        body,
    })
}
