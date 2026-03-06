"use strict";
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
exports.log = log;
exports.logError = logError;
exports.showChannel = showChannel;
exports.getOutputChannel = getOutputChannel;
const vscode = __importStar(require("vscode"));
let outputChannel;
function getChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("SysML");
    }
    return outputChannel;
}
function isDebugEnabled() {
    return vscode.workspace
        .getConfiguration("sysml-language-server")
        .get("debug", false);
}
function timestamp() {
    return new Date().toISOString();
}
/**
 * Log a debug message to the SysML output channel (only when debug is enabled).
 */
function log(msg, ...args) {
    if (!isDebugEnabled())
        return;
    const channel = getChannel();
    const extra = args.length > 0 ? " " + args.map((a) => JSON.stringify(a)).join(" ") : "";
    channel.appendLine(`[${timestamp()}] ${msg}${extra}`);
}
/**
 * Log an error (always, regardless of debug setting).
 */
function logError(msg, err) {
    const channel = getChannel();
    const errStr = err instanceof Error ? err.message : String(err ?? "");
    channel.appendLine(`[${timestamp()}] ERROR: ${msg}${errStr ? ` — ${errStr}` : ""}`);
    if (err instanceof Error && err.stack) {
        channel.appendLine(err.stack);
    }
}
/**
 * Show the SysML output channel (e.g. when user wants to see logs).
 */
function showChannel() {
    getChannel().show();
}
/**
 * Get the SysML output channel for appending lines (used by visualization panel).
 */
function getOutputChannel() {
    return getChannel();
}
//# sourceMappingURL=logger.js.map