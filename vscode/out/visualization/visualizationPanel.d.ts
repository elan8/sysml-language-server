import * as vscode from "vscode";
import type { LspModelProvider } from "../providers/lspModelProvider";
export type DiagramView = "tree" | "package" | "ibd" | "graph" | "activity" | "state" | "sequence" | "hierarchy";
export declare class VisualizationPanel {
    private readonly modelProvider;
    static currentPanel: VisualizationPanel | undefined;
    private readonly panel;
    private disposables;
    private constructor();
    static createOrShow(extensionUri: vscode.Uri, modelProvider: LspModelProvider, focusPackageName?: string, workspaceFileUris?: vscode.Uri[]): VisualizationPanel;
    focusPackage?: string;
    currentView: DiagramView;
    workspaceFileUris: vscode.Uri[];
    dispose(): void;
    refresh(): Promise<void>;
    private refreshFromWorkspaceUris;
    private mergeNamespaceElements;
    private mergeTwo;
    private cloneElement;
    private countElements;
    private renderTreeHtml;
    private onMessage;
    private renderHtml;
}
//# sourceMappingURL=visualizationPanel.d.ts.map