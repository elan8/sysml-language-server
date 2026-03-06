import * as vscode from 'vscode';
import { LspModelProvider } from '../providers/lspModelProvider';
export declare class VisualizationPanel {
    private _document;
    private _lspModelProvider;
    static currentPanel: VisualizationPanel | undefined;
    private readonly _panel;
    private _disposables;
    private _currentView;
    private _isNavigating;
    private _lastUpdateTime;
    private _fileChangeDebounceTimer;
    private _lastContentHash;
    private _pendingUpdate;
    private _needsUpdateWhenVisible;
    private _lastViewColumn;
    private _fileUris;
    private _extensionVersion;
    private _pendingPackageName;
    private constructor();
    static createOrShow(extensionUri: vscode.Uri, document: vscode.TextDocument, customTitle?: string, lspModelProvider?: LspModelProvider, fileUris?: vscode.Uri[]): void;
    exportVisualization(format: string, scale?: number): void;
    private hashContent;
    private updateVisualization;
    private _doUpdateVisualization;
    /**
     * Convert LSP DTO elements into the JSON shape the webview expects.
     * DTOs already use Record attributes (no Map → Record conversion needed)
     * and have no circular parentElement references.
     *
     * `typing` is derived from the DTO's `attributes` (partType / portType)
     * or from a `typing` relationship — matching the ANTLR parser's
     * `(element as any).typing` property that the webview views rely on.
     */
    private convertDTOElementsToJSON;
    /**
     * Merge same-named package DTOs so that packages declared across
     * multiple files appear as a single node with combined children.
     */
    private static mergeElementDTOs;
    private logWebviewMessage;
    private jumpToElement;
    private findElementRecursive;
    /**
     * Find an element within a specific parent context.
     * This is used when the same element name exists in multiple places (e.g., transmitStatus in different action defs).
     */
    private findElementInParent;
    private renameElement;
    private escapeRegex;
    private handleExport;
    getDocument(): vscode.TextDocument;
    /** Update the LspModelProvider. */
    setLspModelProvider(provider: LspModelProvider): void;
    changeView(viewId: string): void;
    selectPackage(packageName: string): void;
    notifyFileChanged(uri: vscode.Uri): void;
    /** Force a visualizer refresh (e.g. after cache clear). */
    refresh(): void;
    dispose(): void;
    private _getHtmlForWebview;
}
//# sourceMappingURL=visualizationPanel.d.ts.map