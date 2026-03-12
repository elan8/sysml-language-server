//! Validation test: run parse_with_diagnostics on the SurveillanceDrone.sysml fixture.
//!
//! This reproduces the scenario where the language server reports a parse error at the end
//! of the file (line 420) when opening in VS Code.
//!
//! **Root cause (bug in sysml-parser):** `parse_with_diagnostics` loops over `root_element`
//! without skipping trailing whitespace at the start of each iteration. After successfully
//! parsing the single top-level package, the remaining input is only a trailing newline
//! (or `\r\n`). The loop then calls `root_element("\n")`. Inside `root_element`, ws is
//! skipped so we reach empty input, then `alt(package, namespace)` fails and reports
//! "expected keyword or token" at line 420. The fix is in sysml-parser: at the start of
//! the while loop, skip `ws_and_comments` and break if the remaining input is empty, so
//! we never try to parse another root element when only trailing whitespace is left.
//!
//! Run with: `cargo test -p sysml-language-server --test parse_validation`

use std::path::PathBuf;

fn surveillance_drone_fixture_path() -> PathBuf {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let server_dir = PathBuf::from(manifest_dir);
    // server/tests/../vscode/testFixture/SurveillanceDrone.sysml when manifest is server/
    server_dir
        .join("..")
        .join("vscode")
        .join("testFixture")
        .join("SurveillanceDrone.sysml")
        .canonicalize()
        .expect("SurveillanceDrone.sysml fixture path")
}

#[test]
fn parse_with_diagnostics_surveillance_drone_has_no_errors() {
    let path = surveillance_drone_fixture_path();
    let content = std::fs::read_to_string(&path).expect("read SurveillanceDrone.sysml");
    let result = sysml_parser::parse_with_diagnostics(&content);

    if !result.errors.is_empty() {
        eprintln!(
            "parse_with_diagnostics reported {} error(s) on {} ({} bytes, {} lines):",
            result.errors.len(),
            path.display(),
            content.len(),
            content.lines().count()
        );
        for (i, e) in result.errors.iter().enumerate() {
            eprintln!(
                "  error {}: {} (line {:?}, column {:?}, code {:?})",
                i + 1,
                e.message,
                e.line,
                e.column,
                e.code
            );
            if let Some((sl, sc, el, ec)) = e.to_lsp_range() {
                eprintln!(
                    "         LSP range: line {} char {} -> line {} char {}",
                    sl, sc, el, ec
                );
            }
        }
        eprintln!(
            "Trailing content: {:?}",
            content.chars().rev().take(20).collect::<String>()
        );
        panic!(
            "expected no parse errors for SurveillanceDrone.sysml; got {} (see stderr)",
            result.errors.len()
        );
    }

    assert!(
        result.root.elements.len() >= 1,
        "expected at least one root element (package)"
    );
}
