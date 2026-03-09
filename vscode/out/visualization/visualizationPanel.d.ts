import * as vscode from 'vscode';
import { LspModelProvider } from '../providers/lspModelProvider';
export declare const RESTORE_STATE_KEY = "sysmlVisualizerRestoreState";
export interface VisualizerRestoreState {
    documentUri: string;
    fileUris: string[];
    currentView: string;
    title?: string;
}
export declare class VisualizationPanel {
    private _document;
    private _lspModelProvider;
    private _context?;
    static currentPanel: VisualizationPanel | undefined;
    private readonly _panel;
    private _disposables;
    private _currentView;
    private _isNavigating;
    private _fileChangeDebounceTimer;
    private _lastContentHash;
    private _needsUpdateWhenVisible;
    private _lastViewColumn;
    private _fileUris;
    private _extensionVersion;
    private _pendingPackageName;
    private _updateFlow;
    private constructor();
    private persistRestoreState;
    static createOrShow(context: vscode.ExtensionContext, document: vscode.TextDocument, customTitle?: string, lspModelProvider?: LspModelProvider, fileUris?: vscode.Uri[]): void;
    /** Restore a webview panel from persisted state (e.g. after VS Code restart). */
    static restore(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, lspModelProvider: LspModelProvider, savedState: VisualizerRestoreState): Promise<void>;
    exportVisualization(format: string, scale?: number): void;
    private updateVisualization;
    getDocument(): vscode.TextDocument;
    /** Exposes webview for tests (e.g. postMessage exportDiagramForTest). */
    getWebview(): vscode.Webview;
    /** Update the LspModelProvider. */
    setLspModelProvider(provider: LspModelProvider): void;
    changeView(viewId: string): void;
    selectPackage(packageName: string): void;
    notifyFileChanged(uri: vscode.Uri): void;
    /** Force a visualizer refresh (e.g. after cache clear). */
    refresh(): void;
    dispose(): void;
}
//# sourceMappingURL=visualizationPanel.d.ts.map