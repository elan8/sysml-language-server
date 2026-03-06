import * as vscode from "vscode";
import type { LspModelProvider } from "../providers/lspModelProvider";
export declare class VisualizationPanel {
    private readonly modelProvider;
    static currentPanel: VisualizationPanel | undefined;
    private readonly panel;
    private disposables;
    private constructor();
    static createOrShow(extensionUri: vscode.Uri, modelProvider: LspModelProvider, focusPackageName?: string): VisualizationPanel;
    focusPackage?: string;
    dispose(): void;
    refresh(): Promise<void>;
    private renderTreeHtml;
    private onMessage;
    private renderHtml;
}
//# sourceMappingURL=visualizationPanel.d.ts.map