import * as vscode from 'vscode';
import type { LspModelProvider } from '../providers/lspModelProvider';
import type { SysMLElementDTO } from '../providers/sysmlModelTypes';
export interface FetchModelParams {
    documentUri: string;
    fileUris: vscode.Uri[];
    lspModelProvider: LspModelProvider;
    currentView: string;
    pendingPackageName?: string;
}
export interface UpdateMessage {
    command: 'update';
    elements: unknown[];
    relationships: unknown[];
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
 * Convert LSP DTO elements into the JSON shape the webview expects.
 */
export declare function convertDTOElementsToJSON(elements: SysMLElementDTO[], parentName?: string): unknown[];
/**
 * Merge same-named package DTOs so that packages declared across
 * multiple files appear as a single node with combined children.
 */
export declare function mergeElementDTOs(elements: SysMLElementDTO[]): SysMLElementDTO[];
/**
 * Fetch model data from the LSP provider and convert it to the webview update message format.
 */
export declare function fetchModelData(params: FetchModelParams): Promise<UpdateMessage | null>;
//# sourceMappingURL=modelFetcher.d.ts.map