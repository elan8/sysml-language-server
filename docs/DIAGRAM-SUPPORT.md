# Diagram Support Status

This document tracks the current visualization support level for the path to `1.0`.

## Release-Enabled

- `general-view`
  Primary shipped visualization for `1.0`. Supports broad structural inspection and export, with category filters for multiple SysML element kinds.

## Experimental Opt-In

These views are available only when `sysml-language-server.visualization.enableExperimentalViews` is enabled.

- `interconnection-view`
  Useful for parts, ports, and connectors, but still needs stronger routing/layout quality before it should be release-enabled by default.
- `action-flow-view`
  Useful for behavior experiments, but not yet covered strongly enough for release-gating.
- `state-transition-view`
  Useful for state-machine exploration, but still needs stronger regression coverage and polish.
- `sequence-view`
  Early interaction visualization support. Not yet stable enough for `1.0`.

## Missing or Not Yet Productized

- View-specific graduation criteria in the product UI
- Strong regression coverage per diagram type
- Release-quality layout/routing guarantees outside `general-view`
- A clearly supported subset of expected SysML diagram workflows beyond the general model view

## `1.0` Graduation Rule

A view should only move from experimental to release-enabled when all of the following are true:

- it has deterministic regression coverage in CI
- it renders representative fixtures without broken or misleading layout
- navigation and empty/error states are clear in VS Code
- known gaps are small enough to document as caveats instead of blockers
