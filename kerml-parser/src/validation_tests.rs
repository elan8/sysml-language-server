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

/// Get the path to the validation directory
fn validation_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is kerml-parser, so go up one level to workspace root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("temp")
        .join("SysML-v2-Release-2026-01")
        .join("sysml")
        .join("src")
        .join("validation")
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

    /// Test all validation files
    #[test]
    fn test_all_validation_files() {
        init_test_logger();
        
        let validation_path = validation_dir();
        
        if !validation_path.exists() {
            debug!("Validation directory not found: {:?}", validation_path);
            debug!("Skipping validation tests. Make sure SysML-v2-Release-2026-01 is in temp/");
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

