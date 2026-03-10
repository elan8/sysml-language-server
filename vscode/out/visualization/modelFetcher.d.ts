import * as vscode from 'vscode';
import type { LspModelProvider } from '../providers/lspModelProvider';
import type { SysMLGraphDTO, IbdDataDTO } from '../providers/sysmlModelTypes';
export interface FetchModelParams {
    documentUri: string;
    fileUris: vscode.Uri[];
    lspModelProvider: LspModelProvider;
    currentView: string;
    pendingPackageName?: string;
}
export interface UpdateMessage {
    command: 'update';
    graph?: SysMLGraphDTO;
    ibd?: IbdDataDTO;
    sequenceDiagrams: unknown[];
    activityDiagrams: unknown[];
    currentView: string;
    pendingPackageName?: string;
}
/**
 * Hash content for change detection. Used to skip re-parsing when document
 * content has not changed.
 */
export declare function hashContent(content: string): string;
/**
 * Merge graphs from multiple files. Nodes with same id (qualified name) are merged;
 * packages merge attributes and children; edges are deduplicated.
 */
export declare function mergeGraphs(graphs: SysMLGraphDTO[]): SysMLGraphDTO;
/**
 * Fetch model data from the LSP provider and convert it to the webview update message format.
 */
export declare function fetchModelData(params: FetchModelParams): Promise<UpdateMessage | null>;
//# sourceMappingURL=modelFetcher.d.ts.map