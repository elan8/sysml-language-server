import * as vscode from "vscode";
/**
 * Log a debug message to the SysML output channel (only when debug is enabled).
 */
export declare function log(msg: string, ...args: unknown[]): void;
/**
 * Log an error (always, regardless of debug setting).
 */
export declare function logError(msg: string, err?: unknown): void;
/**
 * Show the SysML output channel (e.g. when user wants to see logs).
 */
export declare function showChannel(): void;
/**
 * Get the SysML output channel for appending lines (used by visualization panel).
 */
export declare function getOutputChannel(): vscode.OutputChannel;
//# sourceMappingURL=logger.d.ts.map