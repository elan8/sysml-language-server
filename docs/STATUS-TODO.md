# SysML Language Server Status and TODO

This document tracks the current state of the project on the path to `1.0`.

## Current Status

Overall state: usable beta for day-to-day VS Code testing, but not yet a `1.0` stable release.

What is already solid:

- Core LSP flows exist: diagnostics, hover, completion, definition, references, rename, formatting, semantic tokens, folding ranges.
- Crash-on-edit behavior has been hardened in the server.
- VS Code startup, restart, and failure messaging are much more explicit.
- VS Code integration tests now fail on real startup/readiness regressions instead of silently passing.
- Test fixtures now support multiple workspace layouts under `vscode/testFixture/workspaces/`.

What still keeps this from `1.0`:

- Some server runtime paths still need defensive cleanup and guard audits.
- Large-workspace behavior needs stronger test coverage and clearer product guarantees.
- Troubleshooting and release-readiness docs are still incomplete.
- Performance behavior under repeated edits and larger workspaces is not yet well bounded.

## Done

- [x] Fix crash-prone incremental edit handling for UTF-16/LSP position updates.
- [x] Add regression coverage for invalid intermediate edits.
- [x] Remove major runtime `unwrap` and panic points from key production paths.
- [x] Improve extension startup, crash, and restart UX.
- [x] Make VS Code tests strict about language server readiness.
- [x] Add restart-recovery regression tests.
- [x] Fix CI webview asset build drift.
- [x] Introduce workspace fixture subfolders for multiple test workspaces.
- [x] Surface workspace indexing limits in extension configuration and warnings.
- [x] Add regression tests for repeated open/edit/close cycles.
- [x] Add regression coverage for semantic tokens after edits.
- [x] Harden multi-file visualization model fetch against partial request failures.
- [x] Add VS Code end-to-end coverage for multi-file references and rename flows.
- [x] Add malformed-range and UTF-16/emoji edit regressions beyond the initial crash fix.
- [x] Harden explorer/model request paths against cancellations and client-not-running failures.

## In Progress

- [ ] Finish runtime guard audit across remaining production code paths.
- [ ] Strengthen large-workspace behavior with broader smoke and performance coverage.
- [ ] Document release expectations and packaging verification more completely.

## Next

### Reliability

- [ ] Audit remaining runtime assumptions in server document, model, and visualization flows.

### Workspace and Performance

- [x] Add a bounded large-workspace smoke test fixture and CI coverage.
- [x] Revisit repeated recomputation in `didChange`.
- [x] Add more explicit indexing progress and partial-result behavior in the explorer UX.

### Docs and Release

- [x] Write a concise troubleshooting guide.
- [x] Add a `1.0` release checklist.
- [x] Document supported workflows and experimental areas clearly.
- [ ] Verify packaging expectations for bundled binaries and release artifacts.

## Working Rule Until 1.0

- Every crash gets a regression test.
- Every user-visible failure gets a visible message or state.
- No major new feature outranks a known reliability issue in the edit loop.
