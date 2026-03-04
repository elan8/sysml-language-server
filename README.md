# sysml-language-server

Language server for [SysML v2](https://www.omg.org/sysml/sysmlv2/) (and KerML). Provides LSP over stdio and a VS Code extension.

## LSP features

- [x] Text sync (open / change / close)
- [x] Diagnostics (parse errors from KerML)
- [x] Hover
- [x] Completion
- [x] Go to definition
- [x] Find references
- [x] Document symbols / outline
- [x] Code actions
- [x] Formatting

## Editor features (VS Code extension)

- [x] Syntax highlighting (TextMate grammar for `.sysml` / `.kerml`)

## Components

- **Rust server** (`server/`): LSP binary `sysml-language-server` (stdio).
- **VS Code extension** (`vscode/`): TypeScript client that spawns the server.
- **kerml-parser** (`kerml-parser/`): Parses SysML v2 textual notation (aligned with the [SysML v2 Release](https://github.com/Systems-Modeling/SysML-v2-Release) validation suite). The parser does not claim full OMG spec compliance.

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

The parser can run tests over the official [SysML v2 Release](https://github.com/Systems-Modeling/SysML-v2-Release) validation files. CI clones the release and runs these tests. Locally, either:

- Clone the release and set the environment variable to its root:
  ```bash
  git clone --depth 1 https://github.com/Systems-Modeling/SysML-v2-Release.git -b 2026-01 /path/to/SysML-v2-Release-2026-01
  export SYSML_V2_RELEASE_DIR=/path/to/SysML-v2-Release-2026-01
  cargo test -p kerml-parser
  ```
- Or place a clone at `temp/SysML-v2-Release-2026-01` (relative to the repo root); then `cargo test -p kerml-parser` will use it automatically.

If the validation directory is not present, the validation test is skipped.

## Running tests

### Rust (parser + server)

From the repository root:

```bash
cargo test
```

This runs all workspace tests, including:

- **kerml-parser**: unit and validation tests.
- **sysml-language-server**: unit tests in `language.rs` and LSP integration tests in `server/tests/lsp_integration.rs` (spawns the server binary and sends initialize, didOpen, hover, completion, definition, diagnostics over stdio).

To run only the LSP integration tests:

```bash
cargo test -p sysml-language-server --test lsp_integration
```

### VS Code extension tests

Extension tests run inside a downloaded VS Code instance (Extension Development Host). From the repo root:

```bash
cd vscode
npm install
npm run compile
npm test
```

**Note:** Running extension tests from the command line is only supported when no other instance of VS Code is running (or use VS Code Insiders for development and run tests from the stable CLI). Tests that require the language server (hover, go-to-definition) only assert when the `sysml-language-server` binary is on your PATH; otherwise they skip. In CI, the server is built and added to PATH before `npm test`.

## Testing the extension (F5)

1. Build the Rust server: `cargo build` (debug) or `cargo build --release`.
2. Open the `vscode/` folder in VS Code.
3. Press F5 to launch the Extension Development Host.
4. In the new window, open a folder and create a `.sysml` or `.kerml` file. The language server should activate and show basic diagnostics (e.g. hint for empty document).

## License

MIT. See [LICENSE](LICENSE).
