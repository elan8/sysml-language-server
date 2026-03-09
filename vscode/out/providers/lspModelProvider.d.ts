import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { PositionDTO, SysMLElementDTO, SysMLModelParams, SysMLModelResult } from "./sysmlModelTypes";
/** Convert LSP RangeDTO to vscode.Range. */
export declare function toVscodeRange(r: {
    start: PositionDTO;
    end: PositionDTO;
}): vscode.Range;
export interface SysMLServerStats {
    uptime: number;
    memory: {
        rss: number;
    };
    caches: {
        documents: number;
        symbolTables: number;
        semanticTokens: number;
    };
}
export interface SysMLClearCacheResult {
    documents: number;
    symbolTables: number;
    semanticTokens: number;
}
export declare class LspModelProvider {
    private readonly client;
    /** Resolves when the LSP client is ready. Prevents getModel before didOpen is processed. */
    private readonly whenReady;
    constructor(client: LanguageClient, 
    /** Resolves when the LSP client is ready. Prevents getModel before didOpen is processed. */
    whenReady?: Promise<void>);
    getModel(uri: string, scopes?: SysMLModelParams["scope"], token?: vscode.CancellationToken): Promise<SysMLModelResult>;
    getServerStats(): Promise<SysMLServerStats | undefined>;
    clearCache(): Promise<SysMLClearCacheResult | undefined>;
    /**
     * Find an element by name in the model. Searches graph.nodes and optionally
     * scopes by parentContext (qualified name or name of parent).
     */
    findElement(uri: string, elementName: string, parentContext?: string, token?: vscode.CancellationToken): Promise<SysMLElementDTO | undefined>;
}
//# sourceMappingURL=lspModelProvider.d.ts.map