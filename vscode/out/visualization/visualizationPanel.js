"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VisualizationPanel = exports.RESTORE_STATE_KEY = void 0;
const vscode = __importStar(require("vscode"));
const messageHandlers_1 = require("./messageHandlers");
const updateFlow_1 = require("./updateFlow");
const htmlBuilder_1 = require("./htmlBuilder");
exports.RESTORE_STATE_KEY = 'sysmlVisualizerRestoreState';
async function createCombinedDocumentProxy(fileUris) {
    const openDocs = [];
    let combinedContent = '';
    for (const fileUri of fileUris) {
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            openDocs.push(doc);
            const fileName = fileUri.fsPath.split(/[/\\]/).pop() ?? '';
            combinedContent += `// === ${fileName} ===\n`;
            combinedContent += doc.getText();
            combinedContent += '\n\n';
        }
        catch {
            // skip
        }
    }
    if (openDocs.length === 0) {
        throw new Error('No documents could be opened');
    }
    const firstDoc = openDocs[0];
    return {
        getText: () => combinedContent,
        uri: firstDoc.uri,
        languageId: 'sysml',
        version: firstDoc.version,
        lineCount: combinedContent.split('\n').length,
        lineAt: (line) => firstDoc.lineAt(Math.min(line, firstDoc.lineCount - 1)),
        offsetAt: (position) => firstDoc.offsetAt(position),
        positionAt: (offset) => firstDoc.positionAt(offset),
        getWordRangeAtPosition: (position) => firstDoc.getWordRangeAtPosition(position),
        validateRange: (range) => firstDoc.validateRange(range),
        validatePosition: (position) => firstDoc.validatePosition(position),
        fileName: firstDoc.fileName,
        isUntitled: false,
        isDirty: false,
        isClosed: false,
        eol: firstDoc.eol,
        save: () => Promise.resolve(false),
    };
}
class VisualizationPanel {
    constructor(panel, extensionUri, _document, _lspModelProvider, fileUris, _context, initialCurrentView) {
        this._document = _document;
        this._lspModelProvider = _lspModelProvider;
        this._context = _context;
        this._disposables = [];
        this._currentView = 'general-view'; // Store current view state - SysML v2 general-view
        this._isNavigating = false; // Flag to prevent view reset during navigation
        this._lastContentHash = ''; // Cache content hash to skip unchanged updates
        this._needsUpdateWhenVisible = false; // Deferred update when panel is hidden
        this._fileUris = []; // All source file URIs (for folder-level visualization)
        this._extensionVersion = '';
        this._fileUris = fileUris ?? [];
        if (initialCurrentView) {
            this._currentView = initialCurrentView;
        }
        this._extensionVersion = vscode.extensions.getExtension('Elan8.sysml-language-server')?.packageJSON?.version ?? '0.0.0';
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._lastViewColumn = panel.viewColumn;
        // When the panel becomes visible again or is moved (e.g. dragged to
        // a floating window), force a re-render so the visualizer recovers.
        this._panel.onDidChangeViewState(() => {
            const columnChanged = this._panel.viewColumn !== this._lastViewColumn;
            this._lastViewColumn = this._panel.viewColumn;
            if (this._panel.visible) {
                if (this._needsUpdateWhenVisible || columnChanged) {
                    this._needsUpdateWhenVisible = false;
                    // Reset content hash so the update is not skipped
                    this._lastContentHash = '';
                    this.updateVisualization(true);
                }
            }
        }, null, this._disposables);
        this._panel.webview.html = (0, htmlBuilder_1.getWebviewHtml)(this._panel.webview, extensionUri, this._extensionVersion);
        this._updateFlow = (0, updateFlow_1.createUpdateVisualizationFlow)({
            panel: this._panel,
            document: this._document,
            fileUris: this._fileUris,
            lspModelProvider: this._lspModelProvider,
            getCurrentView: () => this._currentView,
            getPendingPackageName: () => this._pendingPackageName,
            getIsNavigating: () => this._isNavigating,
            getNeedsUpdateWhenVisible: () => this._needsUpdateWhenVisible,
            getLastContentHash: () => this._lastContentHash,
            setLastContentHash: (h) => { this._lastContentHash = h; },
            setNeedsUpdateWhenVisible: (v) => { this._needsUpdateWhenVisible = v; },
            clearPendingPackageName: () => { this._pendingPackageName = undefined; },
        });
        setTimeout(() => {
            this._panel.webview.postMessage({ command: 'requestCurrentView' });
        }, 100);
        const dispatch = (0, messageHandlers_1.createMessageDispatcher)({
            panel: this._panel,
            document: this._document,
            lspModelProvider: this._lspModelProvider,
            fileUris: this._fileUris,
            updateVisualization: (force) => this.updateVisualization(force),
            setNavigating: (v) => { this._isNavigating = v; },
            setCurrentView: (v) => {
                this._currentView = v;
                this.persistRestoreState();
            },
            setLastContentHash: (h) => { this._lastContentHash = h; },
        });
        this._panel.webview.onDidReceiveMessage(dispatch, null, this._disposables);
        this.updateVisualization();
        this.persistRestoreState();
    }
    persistRestoreState() {
        if (!this._context)
            return;
        const state = {
            documentUri: this._document.uri.toString(),
            fileUris: this._fileUris.map(u => u.toString()),
            currentView: this._currentView,
            title: this._panel.title !== 'SysML Model Visualizer' ? this._panel.title : undefined,
        };
        this._context.workspaceState.update(exports.RESTORE_STATE_KEY, state);
    }
    static createOrShow(context, document, customTitle, lspModelProvider, fileUris) {
        const extensionUri = context.extensionUri;
        // Determine the best column layout for side-by-side viewing
        const activeColumn = vscode.window.activeTextEditor?.viewColumn;
        let visualizerColumn;
        if (activeColumn === vscode.ViewColumn.One) {
            visualizerColumn = vscode.ViewColumn.Two;
        }
        else if (activeColumn === vscode.ViewColumn.Two) {
            visualizerColumn = vscode.ViewColumn.Three;
        }
        else {
            // Default: put visualizer on the right
            visualizerColumn = vscode.ViewColumn.Beside;
        }
        const title = customTitle || 'SysML Model Visualizer';
        if (VisualizationPanel.currentPanel) {
            // If panel exists, update title and reveal it
            VisualizationPanel.currentPanel._panel.title = title;
            VisualizationPanel.currentPanel._panel.reveal(visualizerColumn);
            if (lspModelProvider) {
                VisualizationPanel.currentPanel._lspModelProvider = lspModelProvider;
            }
            // Track whether file URIs changed (folder→folder or file→folder)
            let fileUrisChanged = false;
            if (fileUris) {
                const oldSet = new Set(VisualizationPanel.currentPanel._fileUris.map(u => u.toString()));
                const newSet = new Set(fileUris.map(u => u.toString()));
                fileUrisChanged = oldSet.size !== newSet.size
                    || [...newSet].some(u => !oldSet.has(u));
                VisualizationPanel.currentPanel._fileUris = fileUris;
            }
            // Update if the document changed OR the set of file URIs changed
            if (VisualizationPanel.currentPanel._document !== document || fileUrisChanged) {
                VisualizationPanel.currentPanel._document = document;
                VisualizationPanel.currentPanel._lastContentHash = ''; // force re-parse
                VisualizationPanel.currentPanel.updateVisualization(true);
            }
            VisualizationPanel.currentPanel.persistRestoreState();
            return;
        }
        if (!lspModelProvider) {
            return; // Cannot create panel without an LSP model provider
        }
        const panel = vscode.window.createWebviewPanel('sysmlVisualizer', title, visualizerColumn, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media')
            ]
        });
        VisualizationPanel.currentPanel = new VisualizationPanel(panel, extensionUri, document, lspModelProvider, fileUris, context);
    }
    /** Restore a webview panel from persisted state (e.g. after VS Code restart). */
    static async restore(panel, context, lspModelProvider, savedState) {
        const extensionUri = context.extensionUri;
        let document;
        let fileUris;
        if (savedState.fileUris.length > 1) {
            fileUris = savedState.fileUris.map((u) => vscode.Uri.parse(u));
            document = await createCombinedDocumentProxy(fileUris);
        }
        else {
            document = await vscode.workspace.openTextDocument(vscode.Uri.parse(savedState.documentUri));
            fileUris = savedState.fileUris.length === 1
                ? [vscode.Uri.parse(savedState.fileUris[0])]
                : [];
        }
        if (savedState.title) {
            panel.title = savedState.title;
        }
        VisualizationPanel.currentPanel = new VisualizationPanel(panel, extensionUri, document, lspModelProvider, fileUris, context, savedState.currentView);
    }
    exportVisualization(format, scale = 2) {
        this._panel.webview.postMessage({ command: 'export', format: format.toLowerCase(), scale });
    }
    updateVisualization(forceUpdate = false) {
        return this._updateFlow.update(forceUpdate);
    }
    getDocument() {
        return this._document;
    }
    /** Exposes webview for tests (e.g. postMessage exportDiagramForTest). */
    getWebview() {
        return this._panel.webview;
    }
    /** Update the LspModelProvider. */
    setLspModelProvider(provider) {
        this._lspModelProvider = provider;
    }
    changeView(viewId) {
        this._panel.webview.postMessage({
            command: 'changeView',
            view: viewId
        });
        this._currentView = viewId;
    }
    selectPackage(packageName) {
        // Store as pending so the next data message carries it to the webview
        this._pendingPackageName = packageName;
        this._currentView = 'general-view';
        // Also post directly in case the webview already has data
        this._panel.webview.postMessage({
            command: 'selectPackage',
            packageName: packageName
        });
    }
    notifyFileChanged(uri) {
        // Always force — the LSP server parses asynchronously, so the
        // model data may have changed even when the document text hasn't
        // (e.g. after a sysml/status 'end' notification).
        const uriStr = uri.toString();
        const docUri = this._document.uri.toString();
        const isTracked = docUri === uriStr
            || this._fileUris.some(u => u.toString() === uriStr);
        if (isTracked) {
            // Debounce: coalesce multiple notifications from
            // onDidChangeTextDocument, onDidSaveTextDocument, and the
            // file-system watcher into a single visualizer refresh.
            if (this._fileChangeDebounceTimer) {
                clearTimeout(this._fileChangeDebounceTimer);
            }
            this._fileChangeDebounceTimer = setTimeout(() => {
                this._fileChangeDebounceTimer = undefined;
                this.updateVisualization(true);
            }, 400);
        }
    }
    /** Force a visualizer refresh (e.g. after cache clear). */
    refresh() {
        this.updateVisualization(true);
    }
    dispose() {
        VisualizationPanel.currentPanel = undefined;
        this._context?.workspaceState.update(exports.RESTORE_STATE_KEY, undefined);
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
exports.VisualizationPanel = VisualizationPanel;
//# sourceMappingURL=visualizationPanel.js.map