# Packaging Expectations

This document describes what should be true about packaging before a release is considered ready.

## VS Code Extension Packaging

The `.vsix` is expected to be the primary install path for most users.

Before release:

- The extension compiles successfully.
- Webview assets are built successfully.
- The `.vsix` contains the extension code plus bundled server binaries for the supported target platforms.
- The extension starts correctly with the bundled binary when `sysml-language-server.serverPath` is left at its default value.

## Bundled Server Layout

The extension runtime expects bundled binaries under:

- `vscode/server/linux-x64/sysml-language-server`
- `vscode/server/darwin-x64/sysml-language-server`
- `vscode/server/win32-x64/sysml-language-server.exe`

These directories are populated by the release workflow and are not expected to exist permanently in the development workspace.

## Server-Only Archives

Release assets should also include standalone server archives per platform so other editors can consume the language server without the VS Code extension.

Expected release artifacts:

- Linux tarball
- macOS tarball
- Windows zip

## Verification Steps

Before publishing:

1. Build release server binaries for all intended targets.
2. Package the extension with bundled binaries.
3. Inspect the produced `.vsix` and confirm the expected server paths are present.
4. Install the `.vsix` in a clean VS Code environment and verify startup with the default configuration.
5. Confirm the standalone archives extract to a working server binary.

## Current Caveat

The repository may be packaging-ready before packaging is fully verified on every release candidate. Documentation of the expected layout is not the same as release verification; the final release checklist must still be completed.
