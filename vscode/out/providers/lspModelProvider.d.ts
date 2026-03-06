import type { CancellationToken } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { SysMLModelParams, SysMLModelResult } from "./sysmlModelTypes";
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
    getModel(uri: string, scopes?: SysMLModelParams["scope"], token?: CancellationToken): Promise<SysMLModelResult>;
    getServerStats(): Promise<SysMLServerStats | undefined>;
    clearCache(): Promise<SysMLClearCacheResult | undefined>;
}
//# sourceMappingURL=lspModelProvider.d.ts.map