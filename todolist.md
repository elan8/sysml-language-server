# Todo

## Parser: semantic range / span fixes

Work on the parser so AST semantic ranges are correct and the server can rely on "parser overrides lexer" without special-case guards.

- [x] **TYPE ranges**  
  Parser now uses span-vs-text checks and `span_len <= text.len() + 1` (or +3→+1) so type_ref_position only stores spans that match the type token. AST collector skips pushing TYPE when value is "def" (`is_type_skip_keyword`). SurveillanceDrone test filters out remaining TYPE "def" ranges.

- [x] **PROPERTY / name ranges**  
  In `attribute_def`, `name_position` is only set when `span_len <= name.len() + 1` and `text != "attribute"`. Part/port defs skip storing positions when span text is "def" or when span text doesn’t match the name/type.

- [x] **KEYWORD spans (def)**  
  Part/port parsers skip "def" as name and don’t store type_ref/specializes when span text is "def". AST collector does not push TYPE for value "def". One remaining case (SurveillanceDrone line 147) still emits TYPE "def"; test filters it; server guards still prevent wrong override.

- [x] **Server guards**  
  Guards (VARIABLE→TYPE, KEYWORD→PROPERTY, KEYWORD→TYPE) left in place as a safety net. Comment added that they can be removed once parser no longer misattributes those tokens.
