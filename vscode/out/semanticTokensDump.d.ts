/**
 * Debug dump of semantic tokens received from the LSP (frontend side).
 * Used when sysml-language-server.debug.dumpSemanticTokens is true.
 */
import * as vscode from "vscode";
export declare const SEMANTIC_TYPE_NAMES: string[];
/** Decoded token: line, start (UTF-16), length (UTF-16), type index, and extracted text */
export interface DecodedToken {
    line: number;
    start: number;
    length: number;
    type: number;
    text: string;
}
/**
 * Decode LSP semantic tokens (delta-encoded) into an array of DecodedToken.
 */
export declare function decodeSemanticTokens(document: vscode.TextDocument, tokens: vscode.SemanticTokens): DecodedToken[];
/**
 * Find the token that contains the given position (0-based line and character, UTF-16).
 */
export declare function getTokenAtPosition(decoded: DecodedToken[], line: number, character: number): DecodedToken | undefined;
/**
 * Decode LSP semantic tokens (delta-encoded) and write a human-readable dump to outPath.
 * Server legend: 0=KEYWORD, 5=VARIABLE, 6=TYPE, 10=PROPERTY.
 */
export declare function dumpSemanticTokens(document: vscode.TextDocument, tokens: vscode.SemanticTokens, outPath: string): void;
//# sourceMappingURL=semanticTokensDump.d.ts.map