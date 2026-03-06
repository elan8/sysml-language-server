import * as path from 'path';
import * as vscode from 'vscode';
import { LspModelProvider } from '../providers/lspModelProvider';
import { createMessageHandlers } from './messageHandlers';
import { fetchModelData, hashContent } from './modelFetcher';
import { getWebviewHtml } from './htmlBuilder';

export class VisualizationPanel {
    public static currentPanel: VisualizationPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _currentView: string = 'elk'; // Store current view state - default to General View
    private _isNavigating: boolean = false; // Flag to prevent view reset during navigation
    private _lastUpdateTime: number = 0; // Prevent rapid successive updates
    private _fileChangeDebounceTimer: ReturnType<typeof setTimeout> | undefined; // Debounce file change notifications
    private _lastContentHash: string = ''; // Cache content hash to skip unchanged updates
    private _pendingUpdate: ReturnType<typeof setTimeout> | undefined; // Coalesce rapid updates
    private _needsUpdateWhenVisible: boolean = false; // Deferred update when panel is hidden
    private _lastViewColumn: vscode.ViewColumn | undefined; // Track view column to detect panel moves
    private _fileUris: vscode.Uri[] = []; // All source file URIs (for folder-level visualization)
    private _extensionVersion: string = '';
    private _pendingPackageName: string | undefined; // Package to select when data arrives

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,

        private _document: vscode.TextDocument,

        private _lspModelProvider: LspModelProvider,
        fileUris?: vscode.Uri[],
    ) {
        this._fileUris = fileUris ?? [];
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

        this._panel.webview.html = getWebviewHtml(this._panel.webview, extensionUri, this._extensionVersion);

        // Request current view state from webview after initialization
        setTimeout(() => {
            this._panel.webview.postMessage({ command: 'requestCurrentView' });
        }, 100);

        const handlers = createMessageHandlers({
            panel: this._panel,
            document: this._document,
            lspModelProvider: this._lspModelProvider,
            fileUris: this._fileUris,
            updateVisualization: (force) => this.updateVisualization(force),
            setNavigating: (v) => { this._isNavigating = v; },
        });

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'webviewLog':
                        handlers.logWebviewMessage(message.level, message.args);
                        break;
                    case 'jumpToElement':
                        handlers.jumpToElement(message.elementName, message.skipCentering, message.parentContext);
                        break;
                    case 'renameElement':
                        handlers.renameElement(message.oldName, message.newName);
                        break;
                    case 'export':
                        handlers.handleExport(message.format, message.data);
                        break;
                    case 'executeCommand':
                        if (message.args && message.args.length > 0) {
                            const cmd = message.args[0];
                            const allowedCommands: string[] = [];
                            if (!allowedCommands.includes(cmd)) {
                                // eslint-disable-next-line no-console
                                console.warn(`[SysML Visualizer] Blocked disallowed command: ${cmd}`);
                                break;
                            }
                            if (cmd === 'sysml.showModelDashboard') {
                                // Pass a file URI so the dashboard can load data
                                // even when no text editor is active (webview is focused).
                                const dashboardUri = this._fileUris.length > 0
                                    ? this._fileUris[0]
                                    : this._document.uri;
                                setTimeout(() => {
                                    vscode.commands.executeCommand(cmd, dashboardUri);
                                }, 100);
                            } else {
                                const cmdArgs = message.args.slice(1);
                                setTimeout(() => {
                                    vscode.commands.executeCommand(cmd, ...cmdArgs);
                                }, 100);
                            }
                        }
                        break;
                    case 'viewChanged':
                        // Store the current view state when it changes
                        this._currentView = message.view;
                        break;
                    case 'openExternal':
                        if (message.url) {
                            vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                    case 'currentViewResponse':
                        // Update our stored view state with the current webview state
                        this._currentView = message.view;
                        break;
                    case 'webviewReady':
                        // Webview (re)initialized — push current model data
                        this._lastContentHash = '';
                        this.updateVisualization(true);
                        break;
                }
            },
            null,
            this._disposables
        );

        this.updateVisualization();
    }

    public static createOrShow(extensionUri: vscode.Uri, document: vscode.TextDocument, customTitle?: string, lspModelProvider?: LspModelProvider, fileUris?: vscode.Uri[]): void {
        // Determine the best column layout for side-by-side viewing
        const activeColumn = vscode.window.activeTextEditor?.viewColumn;
        let visualizerColumn: vscode.ViewColumn;

        if (activeColumn === vscode.ViewColumn.One) {
            visualizerColumn = vscode.ViewColumn.Two;
        } else if (activeColumn === vscode.ViewColumn.Two) {
            visualizerColumn = vscode.ViewColumn.Three;
        } else {
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
            return;
        }

        if (!lspModelProvider) {
            return;  // Cannot create panel without an LSP model provider
        }

        const panel = vscode.window.createWebviewPanel(
            'sysmlVisualizer',
            title,
            visualizerColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media')
                ]
            }
        );

        VisualizationPanel.currentPanel = new VisualizationPanel(panel, extensionUri, document, lspModelProvider, fileUris);
    }

    public exportVisualization(format: string, scale: number = 2) {
        this._panel.webview.postMessage({ command: 'export', format: format.toLowerCase(), scale });
    }

    private async updateVisualization(forceUpdate: boolean = false) {
        // Skip update if we're currently navigating to prevent view reset
        if (this._isNavigating) {
            return;
        }

        // Defer work when the panel is not visible (e.g. user switched tabs)
        if (!this._panel.visible) {
            this._needsUpdateWhenVisible = true;
            return;
        }

        // Check content hash first - skip expensive parsing if content unchanged
        const content = this._document.getText();
        const contentHash = hashContent(content);

        if (!forceUpdate && contentHash === this._lastContentHash) {
            // Content unchanged, skip update entirely
            return;
        }
        this._lastContentHash = contentHash;

        // Tell the webview to show loading indicator immediately
        this._panel.webview.postMessage({ command: 'showLoading', message: 'Parsing SysML model...' });

        // Yield to the event loop so the webview can render the loading state
        // before the synchronous ANTLR parse blocks the extension host
        await new Promise(resolve => setTimeout(resolve, 0));

        await this._doUpdateVisualization();
    }

    private async _doUpdateVisualization() {
        try {
            const msg = await fetchModelData({
                documentUri: this._document.uri.toString(),
                fileUris: this._fileUris,
                lspModelProvider: this._lspModelProvider,
                currentView: this._currentView,
                pendingPackageName: this._pendingPackageName,
            });
            if (this._pendingPackageName) {
                this._pendingPackageName = undefined;
            }
            if (msg) {
                this._panel.webview.postMessage(msg);
            }
        } catch {
            this._panel.webview.postMessage({ command: 'hideLoading' });
        }
    }

    public getDocument(): vscode.TextDocument {
        return this._document;
    }

    /** Update the LspModelProvider. */
    public setLspModelProvider(provider: LspModelProvider): void {
        this._lspModelProvider = provider;
    }

    public changeView(viewId: string): void {
        this._panel.webview.postMessage({
            command: 'changeView',
            view: viewId
        });
        this._currentView = viewId;
    }

    public selectPackage(packageName: string): void {
        // Store as pending so the next data message carries it to the webview
        this._pendingPackageName = packageName;
        this._currentView = 'elk';
        // Also post directly in case the webview already has data
        this._panel.webview.postMessage({
            command: 'selectPackage',
            packageName: packageName
        });
    }

    public notifyFileChanged(uri: vscode.Uri) {
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
    public refresh(): void {
        this.updateVisualization(true);
    }

    public dispose() {
        VisualizationPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
