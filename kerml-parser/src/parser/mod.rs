//! Pest-based parser for SysML v2 grammar.
//!
//! Parses input via the `document` rule in the Pest grammar, then walks
//! pairs to build the AST (packages, members, etc.). Source positions are converted
//! from byte offsets to line/character for LSP and diagnostics.

use pest::Parser;
use pest::iterators::Pairs;
use pest::error::LineColLocation;
use crate::error::{ParseError, Result};
use crate::ast::*;

mod span;
mod expr;
mod statements;
mod metadata;
mod action;
mod connection;
mod attribute;
mod interface;
mod item;
mod port;
mod requirement;
mod part;
mod member;
mod package;
mod document;

/// Trait for parsing nested members; allows breaking recursion across modules.
pub(super) trait MemberParser {
    fn parse_member(&self, pairs: Pairs<'_, Rule>, source: &str) -> Result<Member>;
}

#[derive(pest_derive::Parser)]
#[grammar = "grammar.pest"]
pub struct SysMLParser;

/// Maps low-level Pest error messages to friendlier user-facing text.
/// Original message is appended for debugging.
fn improve_pest_error_message(raw: &str) -> String {
    let friendly = if raw.contains("expected metadata_annotation") {
        "unexpected token; perhaps missing an attribute or expression"
    } else if raw.contains("expected WHITESPACE") {
        "unexpected token; possibly missing space"
    } else if raw.contains("expected EOI") {
        "unexpected token at end of input"
    } else if raw.contains(r#"expected ";"#) || raw.contains("expected ;") {
        "unexpected token; perhaps missing semicolon"
    } else if raw.contains(r#"expected "}"#) || raw.contains("expected }") {
        "unexpected token; perhaps missing closing brace"
    } else if raw.contains(r#"expected "{"#) || raw.contains("expected {") {
        "unexpected token; perhaps missing opening brace"
    } else {
        return raw.to_string();
    };
    format!("{} (raw: {})", friendly, raw)
}

/// Parses SysML v2 source text into a [SysMLDocument](crate::ast::SysMLDocument) AST.
pub fn parse_sysml(input: &str) -> Result<SysMLDocument> {
    let mut pairs = SysMLParser::parse(Rule::document, input).map_err(|e| {
        let raw_msg = format!("{}", e);
        let msg = improve_pest_error_message(&raw_msg);
        let pos = match &e.line_col {
            LineColLocation::Pos((line, col)) | LineColLocation::Span((line, col), _) => {
                Some(((line.saturating_sub(1)) as u32, (col.saturating_sub(1)) as u32))
            }
        };
        ParseError::PestError(msg, pos)
    })?;
    
    // Get the inner pairs of the document rule
    if let Some(document_pair) = pairs.next() {
        let parser = member::ParserImpl;
        document::parse_document(document_pair.into_inner(), input, &parser)
    } else {
        Err(ParseError::Message("Empty document".to_string()))
    }
}

/// Maximum number of parse errors to collect when using error recovery.
const MAX_COLLECTED_ERRORS: usize = 20;

/// Parses SysML and collects multiple parse errors by masking error regions and re-parsing.
/// Returns `(Ok(doc), [])` if parse succeeds, otherwise `(Err(..), errors)` with at least one error.
/// Pest stops at the first error, so we mask from the error position to end of line and re-parse
/// to discover further errors.
pub fn parse_sysml_collect_errors(input: &str) -> (Result<SysMLDocument>, Vec<ParseError>) {
    let mut errors = Vec::new();
    let mut current = input.to_string();
    let mut last_pos: Option<(u32, u32)> = None;

    loop {
        match parse_sysml(&current) {
            Ok(doc) => {
                return (
                    if errors.is_empty() {
                        Ok(doc)
                    } else {
                        Err(ParseError::Message("Parse failed".to_string()))
                    },
                    errors,
                );
            }
            Err(e) => {
                let mut current_error = Some(e);
                let pos = current_error.as_ref().and_then(ParseError::position);
                if errors.len() >= MAX_COLLECTED_ERRORS {
                    errors.push(current_error.take().unwrap());
                    return (
                        Err(ParseError::Message("Parse failed".to_string())),
                        errors,
                    );
                }
                if let Some((line, col)) = pos {
                    if last_pos == Some((line, col)) {
                        errors.push(current_error.take().unwrap());
                        return (
                            Err(ParseError::Message("Parse failed".to_string())),
                            errors,
                        );
                    }
                    last_pos = Some((line, col));
                    errors.push(current_error.take().unwrap());
                    if let Some((line_start, line_end)) = span::line_byte_range(&current, line) {
                        let line_str = &current[line_start..line_end];
                        // Compute mask region in character boundaries to avoid splitting multi-byte UTF-8.
                        // Mask from character col to end of line.
                        let mask_start_byte = line_str
                            .char_indices()
                            .nth(col as usize)
                            .map(|(o, _)| line_start + o)
                            .unwrap_or(line_end);
                        // Ensure we only slice at valid UTF-8 boundaries
                        if mask_start_byte < line_end
                            && current.is_char_boundary(mask_start_byte)
                            && current.is_char_boundary(line_end)
                        {
                            let len = line_end - mask_start_byte;
                            let replacement = " ".repeat(len);
                            current = format!(
                                "{}{}{}",
                                &current[..mask_start_byte],
                                replacement,
                                &current[line_end..]
                            );
                            continue;
                        }
                    }
                }
                if let Some(e) = current_error {
                    errors.push(e);
                }
                return (
                    Err(ParseError::Message("Parse failed".to_string())),
                    errors,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_parsing() {
        let input = r#"
            package MyPackage {
                part def MyPart;
            }
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok());
    }

    #[test]
    fn test_nested_part_usage_in_part_def() {
        let input = r#"
            package P {
                part def A {
                    part b {
                        part c;
                    }
                }
            }
        "#;
        let doc = parse_sysml(input).expect("parse");
        let pkg = doc.packages.first().expect("package");
        let part_def_a = pkg.members.iter().find_map(|m| {
            if let Member::PartDef(pd) = m { Some(pd) } else { None }
        }).expect("PartDef A");
        assert_eq!(part_def_a.name, "A");
        assert_eq!(part_def_a.members.len(), 1, "PartDef A should have 1 member (part b)");
        let part_b = match &part_def_a.members[0] {
            Member::PartUsage(pu) => pu,
            _ => panic!("expected PartUsage b"),
        };
        assert_eq!(part_b.name.as_deref(), Some("b"));
        assert_eq!(part_b.members.len(), 1, "PartUsage b should have 1 member (part c)");
        let part_c = match &part_b.members[0] {
            Member::PartUsage(pu) => pu,
            _ => panic!("expected PartUsage c"),
        };
        assert_eq!(part_c.name.as_deref(), Some("c"));
    }

    #[test]
    fn test_metadata_annotation_parsing() {
        // Test direct metadata annotation parsing
        use pest::Parser;
        let input = r#"@Layer(name = "02_SystemContext")"#;
        
        let pairs = SysMLParser::parse(Rule::metadata_annotation, input);
        assert!(pairs.is_ok(), "Failed to parse metadata annotation: {:?}", pairs);
        
        let mut pairs = pairs.unwrap();
        if let Some(pair) = pairs.next() {
            let result = metadata::parse_metadata_annotation(pair);
            assert!(result.is_ok(), "Failed to parse: {:?}", result);
            let meta = result.unwrap();
            assert_eq!(meta.name, "Layer");
            assert_eq!(meta.attributes.get("name"), Some(&"02_SystemContext".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_part_usage() {
        // In Elan8 structure, metadata annotations are on separate lines before the part
        // The parser should pick these up and attach them to the part_usage
        let input = r#"
@Layer(name = "02_SystemContext")
part system : System;

@Layer(name = "02_SystemContext")
part user : Actor;
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        // For top-level members without packages, parser creates a dummy package
        assert!(doc.packages.len() >= 1, "Expected at least 1 package (dummy for top-level), got {}", doc.packages.len());
        
        // Find the package with empty name (dummy package for top-level members)
        let pkg = doc.packages.iter().find(|p| p.name.is_empty())
            .or_else(|| doc.packages.first())
            .expect("No package found");
        
        println!("Package '{}' has {} members", pkg.name, pkg.members.len());
        for (i, member) in pkg.members.iter().enumerate() {
            match member {
                Member::PartUsage(ref pu) => {
                    println!("Member {}: PartUsage name={:?}, type={:?}, metadata={:?}", 
                        i, pu.name, pu.type_ref, pu.metadata);
                }
                _ => {
                    println!("Member {}: {:?}", i, member);
                }
            }
        }
        
        // Find the system part usage
        let system_part = pkg.members.iter().find(|m| {
            if let Member::PartUsage(ref pu) = m {
                pu.name == Some("system".to_string())
            } else {
                false
            }
        });
        
        assert!(system_part.is_some(), "Could not find system part usage. Members: {:?}", pkg.members);
        if let Some(Member::PartUsage(ref part_usage)) = system_part {
            assert_eq!(part_usage.name, Some("system".to_string()));
            assert_eq!(part_usage.type_ref, Some("System".to_string()));
            println!("System part_usage has {} metadata annotations: {:?}", part_usage.metadata.len(), part_usage.metadata);
            assert!(part_usage.metadata.len() >= 1, "Expected at least 1 metadata annotation, got {}", part_usage.metadata.len());
            
            let layer_meta = part_usage.metadata.iter().find(|m| m.name == "Layer");
            assert!(layer_meta.is_some(), "Expected Layer metadata, found: {:?}", part_usage.metadata);
            assert_eq!(layer_meta.unwrap().attributes.get("name"), Some(&"02_SystemContext".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_part_def() {
        let input = r#"
            @Layer(name = "05_PhysicalArchitecture")
            part def CoffeeMaker {
                part controller : Controller;
            }
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        assert_eq!(doc.packages.len(), 1);
        
        let pkg = &doc.packages[0];
        let part_def_member = pkg.members.iter().find(|m| {
            if let Member::PartDef(ref pd) = m {
                pd.name == "CoffeeMaker"
            } else {
                false
            }
        });
        
        assert!(part_def_member.is_some(), "Could not find CoffeeMaker part def");
        if let Some(Member::PartDef(ref part_def)) = part_def_member {
            assert_eq!(part_def.name, "CoffeeMaker");
            assert!(part_def.metadata.len() >= 1, "Expected at least 1 metadata annotation, got {}", part_def.metadata.len());
            
            let layer_meta = part_def.metadata.iter().find(|m| m.name == "Layer");
            assert!(layer_meta.is_some(), "Expected Layer metadata");
            assert_eq!(layer_meta.unwrap().attributes.get("name"), Some(&"05_PhysicalArchitecture".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_multiple_attributes() {
        let input = r#"
            @Layer(name = "02_SystemContext")
            @Status(value = "Draft")
            part system : System;
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        let pkg = &doc.packages[0];
        
        let system_part = pkg.members.iter().find(|m| {
            if let Member::PartUsage(ref pu) = m {
                pu.name == Some("system".to_string())
            } else {
                false
            }
        });
        
        assert!(system_part.is_some(), "Could not find system part usage");
        if let Some(Member::PartUsage(ref part_usage)) = system_part {
            // Should have at least 1 metadata annotation (Layer)
            assert!(part_usage.metadata.len() >= 1, "Expected at least 1 metadata annotation, got {}", part_usage.metadata.len());
            
            let layer_meta = part_usage.metadata.iter().find(|m| m.name == "Layer");
            assert!(layer_meta.is_some(), "Expected Layer metadata");
            assert_eq!(layer_meta.unwrap().attributes.get("name"), Some(&"02_SystemContext".to_string()));
        }
    }

    #[test]
    fn test_metadata_parsing_no_metadata() {
        let input = r#"
            part system : System;
        "#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        
        let doc = result.unwrap();
        let pkg = &doc.packages[0];
        
        let system_part = pkg.members.iter().find(|m| {
            if let Member::PartUsage(ref pu) = m {
                pu.name == Some("system".to_string())
            } else {
                false
            }
        });
        
        assert!(system_part.is_some(), "Could not find system part usage");
        if let Some(Member::PartUsage(ref part_usage)) = system_part {
            assert_eq!(part_usage.metadata.len(), 0, "Expected no metadata annotations, got {}", part_usage.metadata.len());
        }
    }

    #[test]
    fn test_port_usage_sysml_v2() {
        // SysML v2 compliant: port body contains only members (no connector/pin_map)
        let input = "port power : Power { }";
        let mut pairs = SysMLParser::parse(Rule::port_usage, input).expect("parse port_usage");
        let pair = pairs.next().expect("one pair");
        let span = pair.as_span();
        let parser = member::ParserImpl;
        let port = port::parse_port_usage(pair.into_inner(), input, span, &parser).expect("parse_port_usage");
        assert_eq!(port.name.as_deref(), Some("power"));
        assert!(port.members.is_empty());
    }

    #[test]
    fn test_parse_sysml_collect_errors_multibyte_utf8() {
        // Invalid SysML with multi-byte character in error region: "déf" contains é (2 bytes).
        // Missing semicolon after X triggers parse error.
        let input = "package P { part déf X }";
        let (result, errors) = parse_sysml_collect_errors(input);
        assert!(result.is_err());
        assert!(!errors.is_empty(), "should collect at least one parse error");
        // Should not panic; masking must handle UTF-8 character boundaries
    }
}

