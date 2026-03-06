import * as vscode from "vscode";
import type { LspModelProvider } from "../providers/lspModelProvider";
import type { SysMLElementDTO } from "../providers/sysmlModelTypes";
export declare class ModelTreeItem extends vscode.TreeItem {
    readonly element: SysMLElementDTO;
    readonly uri: vscode.Uri;
    constructor(element: SysMLElementDTO, uri: vscode.Uri);
}
export declare class ModelExplorerProvider implements vscode.TreeDataProvider<ModelTreeItem> {
    private readonly modelProvider;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<void | ModelTreeItem | undefined>;
    private lastUri;
    private lastElements;
    constructor(modelProvider: LspModelProvider);
    refresh(): void;
    getTreeItem(element: ModelTreeItem): Promise<vscode.TreeItem>;
    getChildren(element?: ModelTreeItem): Promise<ModelTreeItem[]>;
    getLastUri(): vscode.Uri | undefined;
}
//# sourceMappingURL=modelExplorerProvider.d.ts.map