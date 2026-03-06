import * as vscode from "vscode";
import type { LspModelProvider } from "../providers/lspModelProvider";
import type { SysMLElementDTO, RangeDTO } from "../providers/sysmlModelTypes";
/** Helper to convert RangeDTO to vscode.Range for openLocation. */
export declare function toVscodeRange(dto: RangeDTO): vscode.Range;
export declare class FileTreeItem extends vscode.TreeItem {
    readonly fileUri: vscode.Uri;
    readonly itemType: "file-node";
    constructor(fileUri: vscode.Uri, childCount: number);
}
export declare class ModelTreeItem extends vscode.TreeItem {
    readonly element: SysMLElementDTO;
    readonly itemType: "sysml-element";
    readonly elementUri: vscode.Uri;
    constructor(element: SysMLElementDTO, uri: vscode.Uri);
}
type ExplorerTreeItem = FileTreeItem | ModelTreeItem;
export declare class ModelExplorerProvider implements vscode.TreeDataProvider<ExplorerTreeItem> {
    private readonly modelProvider;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<void | ExplorerTreeItem | undefined>;
    private lastUri;
    private lastElements;
    private workspaceMode;
    private workspaceFileData;
    private workspaceFileUris;
    private _workspaceViewMode;
    private treeView?;
    private uriToRootItems;
    constructor(modelProvider: LspModelProvider);
    setTreeView(treeView: vscode.TreeView<ExplorerTreeItem>): void;
    isWorkspaceMode(): boolean;
    getWorkspaceFileUris(): vscode.Uri[];
    getWorkspaceViewMode(): "byFile" | "bySemantic";
    setWorkspaceViewMode(mode: "byFile" | "bySemantic"): void;
    toggleWorkspaceViewMode(): void;
    revealActiveDocument(docUri: vscode.Uri): Promise<void>;
    clear(): void;
    loadWorkspaceModel(fileUris: vscode.Uri[], token?: vscode.CancellationToken): Promise<void>;
    loadDocument(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void>;
    refresh(): void;
    getAllElements(): SysMLElementDTO[];
    getLastUri(): vscode.Uri | undefined;
    getTreeItem(element: ExplorerTreeItem): vscode.TreeItem;
    getChildren(element?: ExplorerTreeItem): Promise<ExplorerTreeItem[]>;
    private mergeNamespaceElements;
    private buildSemanticUriMapping;
    private mergeElements;
    private readonly namespaceTypes;
    private mergeTwo;
    private cloneElement;
}
export {};
//# sourceMappingURL=modelExplorerProvider.d.ts.map