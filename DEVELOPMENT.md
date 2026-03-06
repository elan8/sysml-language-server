# Development

Guidance for building, testing, and contributing to sysml-language-server.

## Building

### Rust server

From the repository root:

```bash
cargo build --release
```

The binary is at `target/release/sysml-language-server`. Put it on your PATH or set the extension setting `sysml-language-server.serverPath` to its path.

### VS Code extension

```bash
cd vscode
npm install
npm run compile
```

## Validation tests (SysML v2 suite)

The parser runs a full validation suite over all `.sysml` files in the official [SysML v2 Release](https://github.com/Systems-Modeling/SysML-v2-Release) `sysml/src/validation` directory. The test expects zero parser errors.

- **Standard `cargo test`**: The full validation suite is `#[ignore]`d (slow). It does not run by default.
- **CI**: The validation job clones the release and runs `cargo test -p kerml-parser -- --include-ignored`.
- **Locally**: Clone the release and run the ignored tests when you want to validate:

  ```bash
  git clone --depth 1 https://github.com/Systems-Modeling/SysML-v2-Release.git -b 2026-01 temp/SysML-v2-Release-2026-01
  cargo test -p kerml-parser -- test_full_validation_suite -- --ignored
  ```

  Or set `SYSML_V2_RELEASE_DIR` to the clone root. If the validation directory is not present, the test returns early without failing.

## Running tests

### Rust (parser + server)

```bash
cargo test
```

This runs workspace tests including kerml-parser unit/validation tests and sysml-language-server LSP integration tests.

To run only LSP integration tests:

```bash
cargo test -p sysml-language-server --test lsp_integration
```

Optional: set `SYSML_V2_RELEASE_DIR` to run `lsp_workspace_scan_sysml_release`, which indexes the SysML-v2-Release clone and asserts workspace/symbol returns results.

### VS Code extension tests

```bash
cd vscode
npm install
npm run compile
npm test
```

Extension tests run inside a downloaded VS Code instance. Running them from the CLI is only supported when no other VS Code instance is running. Tests that require the language server (hover, go-to-definition) only assert when `sysml-language-server` is on PATH. In CI, the server is built and added to PATH before `npm test`.

## Testing the extension (F5)

1. Build the Rust server: `cargo build` (debug) or `cargo build --release`.
2. Open the `vscode/` folder in VS Code.
3. Press F5 to launch the Extension Development Host.
4. In the new window, open a folder and create a `.sysml` or `.kerml` file. The language server should activate and show diagnostics.
