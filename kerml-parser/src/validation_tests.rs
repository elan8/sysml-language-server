//! Validation tests for SysML v2 parser
//!
//! This module contains tests that validate the parser against
//! the official SysML v2 validation files.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use crate::ast::{collect_semantic_ranges, SemanticRole, SourceRange};
use crate::parser::parse_sysml;
use crate::error::Result;

/// Returns the source text covered by `r` (parser uses byte offsets for start/end character).
#[cfg(test)]
fn range_text(source: &str, r: &SourceRange) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let line = match lines.get(r.start_line as usize) {
        Some(l) => l,
        None => return String::new(),
    };
    let start = r.start_character as usize;
    let end = r.end_character as usize;
    if start >= line.len() || end > line.len() || start >= end {
        return String::new();
    }
    line.get(start..end).unwrap_or("").to_string()
}

/// Writes semantic ranges (with extracted text) to a file under target/ for review/debugging.
#[cfg(test)]
fn write_semantic_ranges_for_review(source: &str, ranges: &[(SourceRange, SemanticRole)], out_path: &Path) {
    fn role_str(r: SemanticRole) -> &'static str {
        match r {
            SemanticRole::Type => "Type",
            SemanticRole::Namespace => "Namespace",
            SemanticRole::Class => "Class",
            SemanticRole::Interface => "Interface",
            SemanticRole::Property => "Property",
            SemanticRole::Function => "Function",
        }
    }
    if let Ok(mut f) = fs::File::create(out_path) {
        let _ = writeln!(f, "# Semantic token ranges (line/char 0-based, byte offsets)\n");
        for (r, role) in ranges {
            let text = range_text(source, r);
            let text_escaped = text.replace('\n', "\\n").replace('\r', "\\r");
            let _ = writeln!(
                f,
                "{}:{}..{} {} \"{}\"",
                r.start_line,
                r.start_character,
                r.end_character,
                role_str(*role),
                text_escaped
            );
        }
    }
}

/// Initialize a file logger for tests so debug/info logs are written to
/// `test-logs/kerml-parser-tests.log` under the crate directory (handy for development/debugging).
#[cfg(test)]
fn init_test_logger() {
    let _ = (|| {
        let log_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-logs");
        fs::create_dir_all(&log_dir).ok()?;
        let log_file = fs::File::create(log_dir.join("kerml-parser-tests.log")).ok()?;
        simplelog::WriteLogger::init(
            log::LevelFilter::Debug,
            simplelog::Config::default(),
            log_file,
        )
        .ok()
    })();
}

/// Environment variable for the root of a SysML-v2-Release clone (directory that contains `sysml/`).
/// Used by CI; if unset, falls back to `temp/SysML-v2-Release-2026-01` under workspace root.
pub const SYSML_V2_RELEASE_DIR_ENV: &str = "SYSML_V2_RELEASE_DIR";

/// Root of the SysML v2 Release tree (from env or default temp path).
fn sysml_v2_release_root() -> PathBuf {
    std::env::var_os(SYSML_V2_RELEASE_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("temp")
                .join("SysML-v2-Release-2026-01")
        })
}

/// Get the path to the validation directory (SysML v2 Release `sysml/src/validation`).
fn validation_dir() -> PathBuf {
    sysml_v2_release_root().join("sysml").join("src").join("validation")
}

/// Path to the Vehicle Example directory under SysML v2 Release examples.
pub fn vehicle_example_dir() -> PathBuf {
    sysml_v2_release_root()
        .join("sysml")
        .join("src")
        .join("examples")
        .join("Vehicle Example")
}

/// Path to the Vehicle Example Annex A file (challenging SysML v2 model used for parser integration testing).
pub fn vehicle_example_annex_a_path() -> PathBuf {
    vehicle_example_dir().join("SysML v2 Spec Annex A SimpleVehicleModel.sysml")
}

/// Paths to the Vehicle Example definitions, individuals, and usages files (integration test).
pub fn vehicle_example_definition_paths() -> Vec<PathBuf> {
    let dir = vehicle_example_dir();
    vec![
        dir.join("VehicleDefinitions.sysml"),
        dir.join("VehicleIndividuals.sysml"),
        dir.join("VehicleUsages.sysml"),
    ]
}

/// Find all .sysml files in a directory recursively
fn find_sysml_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    
    if !dir.exists() {
        return Ok(files);
    }
    
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        
        if path.is_dir() {
            files.extend(find_sysml_files(&path)?);
        } else if path.extension().and_then(|s| s.to_str()) == Some("sysml") {
            files.push(path);
        }
    }
    
    Ok(files)
}

/// Parse a SysML file. Returns (document, line_count) on success.
fn parse_file(file_path: &Path) -> Result<(crate::ast::SysMLDocument, usize)> {
    let content = fs::read_to_string(file_path)?;
    let n_lines = content.lines().count();
    let doc = parse_sysml(&content)?;
    Ok((doc, n_lines))
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::{info, debug};

    /// Integration test: parse the Vehicle Example Annex A file (challenging SysML v2 model).
    /// This file exercises state machines, transitions, ref item, exhibit state, connect with multiplicity,
    /// and many other constructs. Used to drive parser quality improvements.
    #[test]
    fn test_vehicle_example_annex_a_simple_vehicle_model() {
        init_test_logger();

        let path = vehicle_example_annex_a_path();
        if !path.exists() {
            debug!(
                "Vehicle Example file not found: {:?}. Set {} or place SysML-v2-Release in temp/SysML-v2-Release-2026-01",
                path,
                super::SYSML_V2_RELEASE_DIR_ENV
            );
            return;
        }

        let content = fs::read_to_string(&path).expect("read Vehicle Example file");
        let doc = match parse_sysml(&content) {
            Ok(d) => d,
            Err(e) => {
                info!(
                    "Vehicle Example Annex A parse error (parser improvement opportunity): {}",
                    e
                );
                panic!("Vehicle Example Annex A should parse without error: {}", e);
            }
        };

        // Basic AST sanity: document has at least one package (e.g. SimpleVehicleModel)
        assert!(
            !doc.packages.is_empty(),
            "Vehicle Example should produce at least one package in the AST"
        );

        // Write semantic tokens to workspace target/ for review and debugging (e.g. to verify ISQ/Type ranges for :> QualifiedName)
        let ranges = collect_semantic_ranges(&doc);
        let target_dir = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target"));
        let _ = fs::create_dir_all(&target_dir);
        let out_path = target_dir.join("semantic_tokens_annex_a.txt");
        write_semantic_ranges_for_review(&content, &ranges, &out_path);
        debug!("Wrote {} semantic ranges to {:?}", ranges.len(), out_path);
    }

    /// Unit test: semantic ranges for attribute with :> qualified_name (position as Property, ISQ as Namespace, length as Type).
    #[test]
    fn test_semantic_ranges_attribute_specializes_qualified() {
        let source = "package P { part def V { attribute position:>ISQ::length; } }";
        let doc = parse_sysml(source).expect("parse");
        let ranges = collect_semantic_ranges(&doc);
        let has_property = ranges.iter().any(|(r, role)| {
            *role == SemanticRole::Property && range_text(source, r) == "position"
        });
        let has_namespace = ranges.iter().any(|(r, role)| {
            *role == SemanticRole::Namespace && range_text(source, r) == "ISQ"
        });
        let has_type = ranges.iter().any(|(r, role)| {
            *role == SemanticRole::Type && range_text(source, r) == "length"
        });
        assert!(has_property, "expected Property for attribute name 'position'");
        assert!(has_namespace, "expected Namespace for 'ISQ' in ISQ::length");
        assert!(has_type, "expected Type for 'length' in ISQ::length");
    }

    /// Integration test: parse Vehicle Example VehicleDefinitions.sysml, VehicleIndividuals.sysml, and VehicleUsages.sysml.
    #[test]
    fn test_vehicle_example_definitions_individuals_usages() {
        init_test_logger();

        let paths = vehicle_example_definition_paths();
        for path in &paths {
            if !path.exists() {
                debug!(
                    "Vehicle Example file not found: {:?}. Set {} or place SysML-v2-Release in temp/SysML-v2-Release-2026-01",
                    path,
                    super::SYSML_V2_RELEASE_DIR_ENV
                );
                return;
            }
        }

        for path in &paths {
            let content = fs::read_to_string(path).expect("read Vehicle Example file");
            let doc = match parse_sysml(&content) {
                Ok(d) => d,
                Err(e) => {
                    info!(
                        "Vehicle Example {} parse error: {}",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        e
                    );
                    panic!(
                        "Vehicle Example {} should parse without error: {}",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        e
                    );
                }
            };
            assert!(
                !doc.packages.is_empty() || !doc.imports.is_empty(),
                "Vehicle Example {} should produce at least one package or import",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            // VehicleDefinitions.sysml: expect port defs and interface def in package body
            if path.file_name().map(|n| n == "VehicleDefinitions.sysml").unwrap_or(false) {
                let n_port_def: usize = doc.packages.iter()
                    .flat_map(|p| &p.members)
                    .filter(|m| matches!(m, crate::ast::Member::PortDef(_)))
                    .count();
                let n_interface_def: usize = doc.packages.iter()
                    .flat_map(|p| &p.members)
                    .filter(|m| matches!(m, crate::ast::Member::InterfaceDef(_)))
                    .count();
                assert!(n_port_def >= 3, "VehicleDefinitions.sysml should have at least 3 port defs (DriveIF, AxleMountIF, WheelHubIF), got {}", n_port_def);
                assert!(n_interface_def >= 1, "VehicleDefinitions.sysml should have at least 1 interface def (Mounting), got {}", n_interface_def);
            }
        }
    }

    /// Full validation suite: parse all .sysml files in SysML-v2-Release sysml/src/validation.
    /// Expects zero parser errors. Ignores missing dir (returns early).
    ///
    /// This test is `#[ignore]` because it parses many files and is slow. Run with:
    ///   cargo test -p kerml-parser -- --ignored
    /// CI runs it via the validation job with SYSML_V2_RELEASE_DIR set.
    #[test]
    #[ignore = "slow; run with: cargo test -p kerml-parser -- --ignored"]
    fn test_full_validation_suite() {
        init_test_logger();

        let validation_path = validation_dir();

        if !validation_path.exists() {
            debug!("Validation directory not found: {:?}", validation_path);
            debug!(
                "Skipping. Clone SysML-v2-Release and set {} to its root, or place in temp/SysML-v2-Release-2026-01",
                super::SYSML_V2_RELEASE_DIR_ENV
            );
            return;
        }

        let files = find_sysml_files(&validation_path).expect("Failed to find validation files");

        assert!(
            !files.is_empty(),
            "No .sysml files found in validation directory"
        );

        let mut failed_files = Vec::new();

        for file in &files {
            let relative_path = file
                .strip_prefix(&validation_path)
                .unwrap_or(file)
                .to_string_lossy()
                .to_string();

            match parse_file(file) {
                Ok((doc, n_lines)) => {
                    let n_pkgs = doc.packages.len();
                    let n_members = doc.packages.iter().map(|p| p.members.len()).sum::<usize>();
                    let summary = format!("✓ {} ({} pkgs, {} members, {} lines)", relative_path, n_pkgs, n_members, n_lines);
                    info!("{}", summary);
                    eprintln!("{}", summary);
                }
                Err(e) => {
                    debug!("✗ {} - Error: {}", relative_path, e);
                    failed_files.push((relative_path, e));
                }
            }
        }

        if !failed_files.is_empty() {
            info!("\nFailed to parse {} file(s):", failed_files.len());
            for (file, error) in &failed_files {
                info!("  {}: {}", file, error);
            }
            panic!(
                "Validation suite: {} of {} files failed to parse",
                failed_files.len(),
                files.len()
            );
        }

        let total_msg = format!("Validation suite passed: {} files parsed successfully", files.len());
        info!("{}", total_msg);
        eprintln!("{}", total_msg);
    }
    
    /// Test individual validation files (for easier debugging)
    #[test]
    fn test_parts_tree_basic() {
        init_test_logger();
        
        let file = validation_dir()
            .join("01-Parts Tree")
            .join("1a-Parts Tree.sysml");
        
        if file.exists() {
            parse_file(&file).map(|_| ()).expect("Failed to parse 1a-Parts Tree.sysml");
        } else {
            debug!("Test file not found: {:?}", file);
        }
    }

    /// Test typed attribute syntax: attribute name : Type = value;
    #[test]
    fn test_typed_attribute_syntax() {
        init_test_logger();
        
        let input = r#"
package Test {
    part def MyPart {
        attribute price : Real = 3.50;
        attribute name : String = "test";
        attribute count : Integer = 42;
    }
}
"#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse typed attributes: {:?}", result.err());
    }

    /// Test typed attribute with qualified type name
    #[test]
    fn test_typed_attribute_qualified_type() {
        init_test_logger();
        
        let input = r#"
package Test {
    part def MyPart {
        attribute powerRating : ISQ::PowerValue = 1200;
        attribute capacity : SI::VolumeValue = 1.5;
    }
}
"#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse typed attributes with qualified types: {:?}", result.err());
    }

    /// Test calc def with result expression (SysML v2 7.19.2 - expression without semicolon)
    #[test]
    fn test_calc_def_result_expression() {
        init_test_logger();

        let input = r#"
package Test {
    calc def FlightTimeEstimate {
        doc /* Flight time from capacity and current draw. */
        in capacity : Real;
        in currentDraw : Real;
        return flightTime : Real;
        capacity / currentDraw
    }
}
"#;

        let result = parse_sysml(input);
        assert!(
            result.is_ok(),
            "Failed to parse calc def with result expression: {:?}",
            result.err()
        );
    }

    /// Test typed attribute with unit expression
    #[test]
    fn test_typed_attribute_with_unit() {
        init_test_logger();
        
        let input = r#"
package Test {
    part def MyPart {
        attribute powerRating : PowerValue = 1200 [W];
        attribute capacity : VolumeValue = 1.5 [L];
        attribute length : LengthValue = 1.2 [m];
    }
}
"#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse typed attributes with units: {:?}", result.err());
    }

    /// Test inline part with typed attributes
    #[test]
    fn test_inline_part_with_typed_attributes() {
        init_test_logger();
        
        let input = r#"
package Test {
    part def Container {
        part frame { 
            attribute partNumber = "CM-001"; 
            attribute price : Real = 3.50; 
        }
    }
}
"#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse inline part with typed attributes: {:?}", result.err());
    }

    /// Test multiple typed attributes in inline part
    #[test]
    fn test_multiple_typed_attributes_inline() {
        init_test_logger();
        
        let input = r#"
package Test {
    part def HousingSubAssembly {
        attribute partNumber = "CM-HSG-001";
        attribute material = "ABS Plastic";
        
        part frame { attribute partNumber = "CM-HSG-010"; attribute material = "ABS Plastic"; attribute price : Real = 3.50; }
        part warmingPlate { attribute partNumber = "CM-HSG-020"; attribute material = "Aluminum"; attribute price : Real = 8.25; }
    }
}
"#;
        
        let result = parse_sysml(input);
        assert!(result.is_ok(), "Failed to parse multiple typed attributes in inline parts: {:?}", result.err());
    }
}

