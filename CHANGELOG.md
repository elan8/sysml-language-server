# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-03-12

### Changed

- **New sysml-parser** — Switched to a new sysml-parser dependency for improved parsing and alignment with SysML v2.

## [0.3.0] - 2026-03-10

### Added

- **General View diagram** — New diagram view showing the model structure with element hierarchy, attributes, ports, and parts. Nodes use standard SysML-style compartments.

## [0.2.2] - 2026-03-06

### Changed

- VS Code extension display name updated to "SysML v2 Language Support" to meet marketplace requirements and reduce name confusion with other language server extensions.

## [0.2.1] - 2026-03-06

### Fixed

- **UTF-8 / multi-byte handling:** `position_to_byte_offset` now correctly converts LSP character indices to byte offsets (e.g. for "café"). `completion_prefix` iterates by character to avoid panics on multi-byte content. Error masking in `parse_sysml_collect_errors` uses character boundaries so multi-byte lines no longer produce invalid UTF-8.
- **Parse error messages:** Low-level Pest messages are mapped to clearer user-facing text (e.g. "expected metadata_annotation" → "unexpected token; perhaps missing an attribute or expression"); original message is appended for debugging. Additional mappings for package, member, name, identifier, import, expressions, literals, parentheses, etc.

### Changed

- Removed unused `line_char_to_byte_offset` from kerml-parser (server already has equivalent logic). Extended `improve_pest_error_message` with more grammar-rule mappings.

### Added

- Unit tests for multi-byte edge cases: `position_to_byte_offset`, `word_at_position`, `completion_prefix`, and `parse_sysml_collect_errors` with UTF-8 in the error region.

## [0.2.0] - 2025-03-06

### Added

- Calc def result expressions: parser now supports bare result expressions (e.g. `capacity / currentDraw`) without a final semicolon, per SysML v2 7.19.2.
- Full validation suite test: parses all `.sysml` files in SysML-v2-Release `sysml/src/validation`; test is `#[ignore]`d (run with `cargo test -p kerml-parser -- --ignored`); CI runs it with `--include-ignored`. Per-file summary (pkgs, members, lines) logged when running the suite.

### Fixed

- "position" no longer incorrectly marked as keyword in semantic tokens; it is a contextual keyword only and valid as an identifier (e.g. `out position : String`).
- Shared reserved keyword list: single source of truth in `language::RESERVED_KEYWORDS` for semantic token fallback and goto-definition/rename suppression; eliminates discrepancies between keyword lists.

## [0.1.0] - 2026-03-05

### Added

- LSP over stdio: text sync, diagnostics, hover, completion, go to definition, find references, rename, document symbols, workspace symbol search, code actions, formatting.
- Workspace-aware indexing for `.sysml` and `.kerml` files (workspace folders and root URI).
- VS Code extension with SysML/KerML syntax highlighting and language configuration.
- Parser aligned with the [SysML v2 Release](https://github.com/Systems-Modeling/SysML-v2-Release) validation suite.

### Known limitations

- Parser is aligned with the SysML v2 Release validation suite; it does not claim full OMG spec compliance.
- Some constructs may have incomplete semantic token or outline coverage.

[0.4.0]: https://github.com/elan8/sysml-language-server/releases/tag/v0.4.0
[0.3.0]: https://github.com/elan8/sysml-language-server/releases/tag/v0.3.0
[0.2.2]: https://github.com/elan8/sysml-language-server/releases/tag/v0.2.2
[0.2.1]: https://github.com/elan8/sysml-language-server/releases/tag/v0.2.1
[0.2.0]: https://github.com/elan8/sysml-language-server/releases/tag/v0.2.0
[0.1.0]: https://github.com/elan8/sysml-language-server/releases/tag/v0.1.0
