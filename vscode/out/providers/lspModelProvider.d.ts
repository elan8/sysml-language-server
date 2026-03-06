import type { CancellationToken } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { SysMLModelParams, SysMLModelResult } from "./sysmlModelTypes";
export declare class LspModelProvider {
    private readonly client;
    constructor(client: LanguageClient);
    getModel(uri: string, scopes?: SysMLModelParams["scope"], token?: CancellationToken): Promise<SysMLModelResult>;
}
//# sourceMappingURL=lspModelProvider.d.ts.map