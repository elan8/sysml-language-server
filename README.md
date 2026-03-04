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

## Testing the extension (F5)

1. Build the Rust server: `cargo build` (debug) or `cargo build --release`.
2. Open the `vscode/` folder in VS Code.
3. Press F5 to launch the Extension Development Host.
4. In the new window, open a folder and create a `.sysml` or `.kerml` file. The language server should activate and show basic diagnostics (e.g. hint for empty document).

## License

MIT. See [LICENSE](LICENSE).
