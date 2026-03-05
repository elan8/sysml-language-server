//! Requirement definition and usage parsing.

use pest::iterators::Pairs;
use crate::ast::{Member, RequirementDef, RequirementUsage};
use crate::error::Result;
use super::MemberParser;
use super::Rule;
use super::span::{span_to_position, span_to_source_range};

pub(super) fn parse_requirement_def<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    full_text: &str,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<RequirementDef> {
    let mut name = String::new();
    let mut name_position = None;
    let mut specializes = None;
    let mut members = Vec::new();
    let mut next_is_specialization = false;

    log::debug!("parse_requirement_def: Starting to parse");
    let all_pairs: Vec<_> = pairs.collect();
    log::debug!("parse_requirement_def: Processing {} pairs", all_pairs.len());
    let mut doc_comment_text = String::new();
    for (idx, pair) in all_pairs.iter().enumerate() {
        log::trace!("parse_requirement_def: Pair[{}] rule={:?}, text={:?}", idx, pair.as_rule(), pair.as_str());
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_requirement_def: Set name to: {}", name);
                } else if next_is_specialization {
                    specializes = Some(text.to_string());
                    next_is_specialization = false;
                }
            }
            Rule::member | Rule::import_statement => {
                if let Ok(member) = parser.parse_member(pair.clone().into_inner(), source) {
                    members.push(member);
                }
            }
            Rule::doc_comment => {
                log::debug!("parse_requirement_def: Found doc_comment directly");
                if let Some(doc_pos) = full_text.find("doc") {
                    let after_doc = &full_text[doc_pos + 3..];
                    if let Some(comment_start) = after_doc.find("/*") {
                        if let Some(comment_end) = after_doc[comment_start + 2..].find("*/") {
                            doc_comment_text = after_doc[comment_start + 2..comment_start + 2 + comment_end]
                                .trim()
                                .to_string();
                            log::debug!("parse_requirement_def: Extracted doc comment text: {:?}", doc_comment_text);
                        }
                    } else if let Some(comment_start) = after_doc.find("//") {
                        let comment_line = after_doc[comment_start + 2..]
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim_end()
                            .to_string();
                        doc_comment_text = comment_line;
                        log::debug!("parse_requirement_def: Extracted doc comment text: {:?}", doc_comment_text);
                    }
                }
            }
            Rule::COMMENT => {
                if doc_comment_text.is_empty() {
                    let comment_text = pair.as_str();
                    doc_comment_text = if comment_text.starts_with("/*") {
                        comment_text
                            .strip_prefix("/*")
                            .and_then(|s| s.strip_suffix("*/"))
                            .unwrap_or(comment_text)
                            .trim()
                            .to_string()
                    } else if comment_text.starts_with("//") {
                        comment_text
                            .strip_prefix("//")
                            .unwrap_or(comment_text)
                            .trim_end()
                            .to_string()
                    } else {
                        comment_text.trim().to_string()
                    };
                    log::debug!("parse_requirement_def: Extracted COMMENT text: {:?}", doc_comment_text);
                }
            }
            _ => {
                if pair.as_str() == ":>" {
                    next_is_specialization = true;
                }
            }
        }
    }

    if !doc_comment_text.is_empty() {
        members.push(Member::DocComment(crate::ast::DocComment {
            text: doc_comment_text,
        }));
    }

    Ok(RequirementDef {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        specializes,
        members,
    })
}

pub(super) fn parse_requirement_usage<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<RequirementUsage> {
    let mut name = String::new();
    let mut name_position = None;
    let mut type_ref = None;
    let mut redefines = None;
    let mut members = Vec::new();
    let mut next_is_type = false;
    let mut next_is_redefines = false;

    log::debug!("parse_requirement_usage: Starting to parse");
    for pair in pairs {
        log::trace!(
            "parse_requirement_usage: Rule {:?}, text: {:?}",
            pair.as_rule(),
            pair.as_str()
        );
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_requirement_usage: Set name to: {}", name);
                } else if next_is_type {
                    type_ref = Some(text.to_string());
                    next_is_type = false;
                } else if next_is_redefines {
                    redefines = Some(text.to_string());
                    next_is_redefines = false;
                }
            }
            Rule::member | Rule::import_statement => {
                if let Ok(member) = parser.parse_member(pair.into_inner(), source) {
                    members.push(member);
                }
            }
            _ => {
                let text = pair.as_str();
                if text == ":" {
                    next_is_type = true;
                } else if text == "redefines" {
                    next_is_redefines = true;
                }
            }
        }
    }

    Ok(RequirementUsage {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref,
        redefines,
        members,
    })
}

pub(super) fn parse_requirement_references<P: MemberParser>(
    pairs: Pairs<'_, Rule>,
    source: &str,
    span: pest::Span<'_>,
    parser: &P,
) -> Result<RequirementUsage> {
    let mut name = String::new();
    let mut name_position = None;
    let mut members = Vec::new();

    log::debug!("parse_requirement_references: Starting to parse");
    for pair in pairs {
        log::trace!(
            "parse_requirement_references: Rule {:?}, text: {:?}",
            pair.as_rule(),
            pair.as_str()
        );
        match pair.as_rule() {
            Rule::name | Rule::identifier | Rule::qualified_name | Rule::string_literal => {
                let text = pair.as_str().trim_matches('\'');
                if name.is_empty() {
                    name = text.to_string();
                    name_position = Some(span_to_position(pair.as_span(), source));
                    log::debug!("parse_requirement_references: Set name to: {}", name);
                }
            }
            Rule::member | Rule::import_statement => {
                if let Ok(member) = parser.parse_member(pair.into_inner(), source) {
                    members.push(member);
                }
            }
            _ => {}
        }
    }

    Ok(RequirementUsage {
        name,
        name_position,
        range: Some(span_to_source_range(span, source)),
        type_ref: None,
        redefines: None,
        members,
    })
}
