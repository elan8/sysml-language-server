"use strict";
/**
 * Debug dump of semantic tokens received from the LSP (frontend side).
 * Used when sysml-language-server.debug.dumpSemanticTokens is true.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_TYPE_NAMES = void 0;
exports.decodeSemanticTokens = decodeSemanticTokens;
exports.getTokenAtPosition = getTokenAtPosition;
exports.dumpSemanticTokens = dumpSemanticTokens;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.SEMANTIC_TYPE_NAMES = [
    "KEYWORD",
    "STRING",
    "NUMBER",
    "COMMENT",
    "OPERATOR",
    "VARIABLE",
    "TYPE",
    "NAMESPACE",
    "CLASS",
    "INTERFACE",
    "PROPERTY",
    "FUNCTION",
];
/**
 * Decode LSP semantic tokens (delta-encoded) into an array of DecodedToken.
 */
function decodeSemanticTokens(document, tokens) {
    const data = tokens.data;
    const lines = document.getText().split(/\r?\n/);
    const decoded = [];
    let line = 0;
    let startChar = 0;
    for (let i = 0; i + 5 <= data.length; i += 5) {
        line += data[i];
        startChar = data[i] === 0 ? startChar + data[i + 1] : data[i + 1];
        const length = data[i + 2];
        const type = data[i + 3];
        const lineStr = lines[line] ?? "";
        const text = lineStr.slice(startChar, startChar + length); // slice uses UTF-16 indices
        decoded.push({ line, start: startChar, length, type, text });
    }
    return decoded;
}
/**
 * Find the token that contains the given position (0-based line and character, UTF-16).
 */
function getTokenAtPosition(decoded, line, character) {
    return decoded.find((t) => t.line === line &&
        character >= t.start &&
        character < t.start + t.length);
}
/**
 * Decode LSP semantic tokens (delta-encoded) and write a human-readable dump to outPath.
 * Server legend: 0=KEYWORD, 5=VARIABLE, 6=TYPE, 10=PROPERTY.
 */
function dumpSemanticTokens(document, tokens, outPath) {
    const decoded = decodeSemanticTokens(document, tokens);
    const lines = document.getText().split(/\r?\n/);
    let report = "Frontend semantic tokens dump (from LSP)\n";
    report += "==========================================\n";
    report += `Document: ${document.uri.toString()}\n`;
    report += `Legend: 0=KEYWORD, 5=VARIABLE, 6=TYPE, 10=PROPERTY\n`;
    report += "Expected: in/out=KEYWORD, panAngle/current/velocity/position=!KEYWORD\n\n";
    report += "Source (first 30 lines):\n";
    lines.slice(0, 30).forEach((l, i) => {
        report += `  ${i}: ${l}\n`;
    });
    report += "\nTokens:\n";
    for (const t of decoded) {
        const typeName = exports.SEMANTIC_TYPE_NAMES[t.type] ?? `?${t.type}`;
        report += `  ${t.line}:${t.start} len=${t.length} type=${typeName} ${JSON.stringify(t.text)}\n`;
    }
    report += "\nProblematic identifiers (should NOT be KEYWORD):\n";
    const problemIds = [
        "panAngle",
        "current",
        "velocity",
        "position",
        "tiltAngle",
        "mode",
        "voltage",
        "attitude",
        "altitude",
    ];
    for (const ident of problemIds) {
        const found = decoded.filter((t) => t.text === ident);
        if (found.length === 0) {
            report += `  ${ident}: NOT FOUND\n`;
        }
        else {
            for (const t of found) {
                const typeName = exports.SEMANTIC_TYPE_NAMES[t.type] ?? `?${t.type}`;
                const status = t.type === 0 ? " *** WRONG (KEYWORD) ***" : " ok";
                report += `  ${ident}: ${typeName} at ${t.line}:${t.start}${status}\n`;
            }
        }
    }
    report += "\nTroubleshooting if identifiers still appear highlighted like keywords:\n";
    report += "  1. Ensure editor.semanticHighlighting.enabled is true (or configuredByTheme with a theme that has semanticHighlighting)\n";
    report += "  2. Try editor.renderWhitespace: 'none' (some themes misbehave with 'all')\n";
    report += "  3. Disable other SysML/KerML extensions that might provide conflicting TextMate grammars\n";
    report += "  4. Reload window (Ctrl+Shift+P → Developer: Reload Window)\n";
    report += "\n(Set sysml-language-server.debug.dumpSemanticTokens to false to stop dumps.)\n";
    try {
        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outPath, report, "utf8");
    }
    catch (e) {
        console.error("Failed to write semantic tokens dump:", e);
    }
}
//# sourceMappingURL=semanticTokensDump.js.map