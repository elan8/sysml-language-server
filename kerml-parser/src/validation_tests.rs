//! Validation tests for SysML v2 parser
//!
//! This module contains tests that validate the parser against
//! the official SysML v2 validation files.

use std::fs;
use std::path::{Path, PathBuf};
use crate::parser::parse_sysml;
use crate::error::Result;

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

/// Test parsing a single SysML file
fn test_parse_file(file_path: &Path) -> Result<()> {
    let content = fs::read_to_string(file_path)?;
    parse_sysml(&content)?;
    Ok(())
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
        }
    }

    /// Test all validation files
    #[test]
    fn test_all_validation_files() {
        init_test_logger();
        
        let validation_path = validation_dir();
        
        if !validation_path.exists() {
            debug!("Validation directory not found: {:?}", validation_path);
            debug!("Skipping validation tests. Clone https://github.com/Systems-Modeling/SysML-v2-Release and set {} to its root, or place a clone in temp/SysML-v2-Release-2026-01", super::SYSML_V2_RELEASE_DIR_ENV);
            return;
        }
        
        let files = find_sysml_files(&validation_path)
            .expect("Failed to find validation files");
        
        assert!(!files.is_empty(), "No .sysml files found in validation directory");
        
        let mut failed_files = Vec::new();
        
        for file in &files {
            let relative_path = file.strip_prefix(&validation_path)
                .unwrap_or(file)
                .to_string_lossy()
                .to_string();
            
            match test_parse_file(file) {
                Ok(_) => {
                    info!("✓ {}", relative_path);
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
            panic!("Some validation files failed to parse");
        }
    }
    
    /// Test individual validation files (for easier debugging)
    #[test]
    fn test_parts_tree_basic() {
        init_test_logger();
        
        let file = validation_dir()
            .join("01-Parts Tree")
            .join("1a-Parts Tree.sysml");
        
        if file.exists() {
            test_parse_file(&file).expect("Failed to parse 1a-Parts Tree.sysml");
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

