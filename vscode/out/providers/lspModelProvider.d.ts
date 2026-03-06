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
    constructor(client: LanguageClient);
    getModel(uri: string, scopes?: SysMLModelParams["scope"], token?: vscode.CancellationToken): Promise<SysMLModelResult>;
    getServerStats(): Promise<SysMLServerStats | undefined>;
    clearCache(): Promise<SysMLClearCacheResult | undefined>;
    /**
     * Find an element by name in the model. Performs a depth-first search
     * over elements returned by getModel.
     */
    findElement(uri: string, elementName: string, parentContext?: string, token?: vscode.CancellationToken): Promise<SysMLElementDTO | undefined>;
    private findRecursive;
}
//# sourceMappingURL=lspModelProvider.d.ts.map