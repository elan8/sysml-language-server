# Todo

## Parser: semantic range / span fixes

Work on the parser so AST semantic ranges are correct and the server can rely on "parser overrides lexer" without special-case guards.

- [ ] **TYPE ranges**  
  Ensure `type_ref_position` (and any other TYPE-emitting logic) only covers the actual type token (e.g. `Real`, `String`), never the property name or keywords like `def`. Fix wrong spans such as `" current "` or `"out velocity :"` being stored as type ranges.

- [ ] **PROPERTY / name ranges**  
  Ensure PROPERTY/name ranges never include leading keywords. Fix cases where the keyword `attribute` is inside a PROPERTY range (e.g. 127:2..15).

- [ ] **KEYWORD spans**  
  Ensure no TYPE or PROPERTY range covers the keyword `def` (e.g. 147:5..9). Track down which AST node/parser rule produces that span and correct it.

- [ ] **Server guards**  
  After parser fixes are verified (e.g. via semantic token tests and manual check of SurveillanceDrone.sysml), consider removing or relaxing the override guards in `server/src/semantic_tokens.rs`: VARIABLE→TYPE, KEYWORD→PROPERTY, KEYWORD→TYPE.
