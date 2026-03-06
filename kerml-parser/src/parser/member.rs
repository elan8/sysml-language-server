//! Member parsing: ParserImpl and the main member rule dispatch.

use pest::iterators::Pairs;
use crate::ast::*;
use crate::error::{ParseError, Result};
use log::{debug, trace};

use super::Rule;
use super::MemberParser;
use super::part;
use super::attribute;
use super::port;
use super::connection;
use super::interface;
use super::item;
use super::requirement;
use super::action;
use super::state;
use super::usecase;
use super::statements::{parse_allocate_statement, parse_bind_statement, parse_provides_statement, parse_requires_statement};

/// Default implementation of MemberParser used by the public API.
pub(crate) struct ParserImpl;

impl MemberParser for ParserImpl {
    fn parse_member(&self, pairs: Pairs<'_, Rule>, source: &str) -> Result<Member> {
        parse_member_impl(pairs, source, self)
    }
}

pub(super) fn parse_member_impl<P: MemberParser>(mut pairs: Pairs<'_, Rule>, source: &str, parser: &P) -> Result<Member> {
    if let Some(pair) = pairs.next() {
        let rule = pair.as_rule();
        let span = pair.as_span();
        trace!("parse_member: Matched rule {:?}, text: {:?}", rule, pair.as_str());
        match rule {
            Rule::part_def => {
                debug!("parse_member: Parsing part_def");
                Ok(Member::PartDef(part::parse_part_def(pair.into_inner(), source, span, parser)?))
            },
            Rule::part_usage => Ok(Member::PartUsage(part::parse_part_usage(pair.into_inner(), source, span, parser)?)),
            Rule::attribute_def => Ok(Member::AttributeDef(attribute::parse_attribute_def(pair.into_inner(), source, span, parser)?)),
            Rule::attribute_usage => Ok(Member::AttributeUsage(attribute::parse_attribute_usage(pair.into_inner(), source, span, parser)?)),
            Rule::port_def => Ok(Member::PortDef(port::parse_port_def(pair.into_inner(), source, span, parser)?)),
            Rule::port_usage => Ok(Member::PortUsage(port::parse_port_usage(pair.into_inner(), source, span, parser)?)),
            Rule::connection_usage => Ok(Member::ConnectionUsage(connection::parse_connection_usage(pair.into_inner(), source, span)?)),
            Rule::interface_def => Ok(Member::InterfaceDef(interface::parse_interface_def(pair.into_inner(), source, span, parser)?)),
            Rule::item_def => Ok(Member::ItemDef(item::parse_item_def(pair.into_inner(), source, span, parser)?)),
            Rule::item_usage => Ok(Member::ItemUsage(item::parse_item_usage(pair.into_inner(), source, span)?)),
            Rule::ref_item => Ok(Member::ItemUsage(item::parse_ref_item(pair.into_inner(), source, span)?)),
            Rule::requirement_def => {
                let full_text = pair.as_str();
                Ok(Member::RequirementDef(requirement::parse_requirement_def(pair.into_inner(), full_text, source, span, parser)?))
            },
            Rule::requirement_usage => Ok(Member::RequirementUsage(requirement::parse_requirement_usage(pair.into_inner(), source, span, parser)?)),
            Rule::requirement_references => Ok(Member::RequirementUsage(requirement::parse_requirement_references(pair.into_inner(), source, span, parser)?)),
            Rule::action_def => Ok(Member::ActionDef(action::parse_action_def(pair.into_inner(), source, span)?)),
            Rule::state_def => Ok(Member::StateDef(state::parse_state_def(pair.into_inner(), source, span, parser)?)),
            Rule::exhibit_state => Ok(Member::ExhibitState(state::parse_exhibit_state(pair.into_inner(), source, span, parser)?)),
            Rule::use_case => Ok(Member::UseCase(usecase::parse_use_case(pair.into_inner(), source, span, parser)?)),
            Rule::actor_statement => Ok(Member::ActorDef(usecase::parse_actor_statement(pair.into_inner(), source, span, parser)?)),
            Rule::package => Ok(Member::Package(super::package::parse_package(pair.into_inner(), source, span, parser)?)),
            Rule::language_extension => {
                let mut inner = pair.into_inner();
                if let Some(member_pair) = inner.nth(1) {
                    parser.parse_member(member_pair.into_inner(), source)
                } else {
                    Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Language extension missing member").into())
                }
            },
            Rule::bind_statement => {
                Ok(Member::BindStatement(parse_bind_statement(pair.into_inner(), source)?))
            }
            Rule::allocate_statement => {
                Ok(Member::AllocateStatement(parse_allocate_statement(pair.into_inner(), source)?))
            }
            Rule::provides_statement => {
                Ok(Member::ProvidesStatement(parse_provides_statement(pair.into_inner(), source)?))
            }
            Rule::requires_statement => {
                Ok(Member::RequiresStatement(parse_requires_statement(pair.into_inner(), source)?))
            }
            Rule::in_statement => Ok(Member::InStatement(super::package::parse_in_statement(pair.into_inner(), source, span)?)),
            Rule::end_statement => Ok(Member::EndStatement(super::package::parse_end_statement(pair.into_inner(), source, span)?)),
            // These are recognized but not fully parsed yet - just skip them for now
            Rule::flow_statement | Rule::succession_statement | Rule::succession_flow_statement | Rule::assign_statement | Rule::transition_statement |
            Rule::accept_statement | Rule::state_machine_statement | Rule::variation_statement |
            Rule::send_node_statement |
            Rule::subject_statement |
            Rule::dependency_statement | Rule::occurrence_def | Rule::occurrence_usage |
            Rule::enum_def | Rule::constraint_def |
            Rule::calc_def | Rule::assert_constraint | Rule::perform_action | Rule::value_def |
            Rule::value_usage | Rule::action_usage | Rule::action_statement | Rule::ref_part |
            Rule::ref_statement | Rule::connection_def | Rule::alias_statement | Rule::metadata_def |
            Rule::doc_comment => {
                // Parse doc comment: "doc" ~ COMMENT?
                // The rule is atomic (@{}), so we get the full text including "doc"
                let full_text = pair.as_str();
                // Remove "doc" keyword and whitespace, then extract comment
                let text = if let Some(after_doc) = full_text.strip_prefix("doc") {
                    let comment_text = after_doc.trim();
                    // Remove /* and */ or // and newline
                    if comment_text.starts_with("/*") {
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
                    }
                } else {
                    String::new()
                };
                Ok(Member::DocComment(crate::ast::DocComment { text }))
            }
            Rule::view_def | Rule::event_occurrence_statement |
            Rule::require_constraint_statement => {
                // For now, just consume the pairs to allow parsing to continue
                // These will be properly implemented later
                Ok(Member::PartDef(PartDef {
                    metadata: Vec::new(), // Nested part defs don't have metadata at this level
                    name: format!("_unparsed_{:?}", pair.as_rule()),
                    name_position: None,
                    range: None,
                    is_abstract: false,
                    specializes: None,
                    specializes_position: None,
                    type_ref: None,
                    type_ref_position: None,
                    multiplicity: None,
                    ordered: false,
                    members: Vec::new(),
                }))
            }
            _ => Err(ParseError::Message(format!("Unknown member type: {:?}", pair.as_rule())))
        }
    } else {
        Err(ParseError::Message("Empty member".to_string()))
    }
}
