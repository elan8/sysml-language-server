# sysml-language-server

Language server for [SysML v2](https://www.omg.org/sysml/sysmlv2/) (and KerML). Provides LSP over stdio and a VS Code extension.

## LSP features

- [x] Text sync (open / change / close)
- [x] Diagnostics (parse errors from KerML)
- [x] Hover
- [x] Completion
- [x] Go to definition
- [x] Find references
- [ ] Document symbols / outline
- [ ] Code actions
- [ ] Formatting

## Editor features (VS Code extension)

- [x] Syntax highlighting (TextMate grammar for `.sysml` / `.kerml`)

## Components

- **Rust server** (`server/`): LSP binary `sysml-language-server` (stdio).
- **VS Code extension** (`vscode/`): TypeScript client that spawns the server.

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

## Testing the extension (F5)

1. Build the Rust server: `cargo build` (debug) or `cargo build --release`.
2. Open the `vscode/` folder in VS Code.
3. Press F5 to launch the Extension Development Host.
4. In the new window, open a folder and create a `.sysml` or `.kerml` file. The language server should activate and show basic diagnostics (e.g. hint for empty document).

## License

MIT. See [LICENSE](LICENSE).
