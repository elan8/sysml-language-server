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
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const node_1 = require("vscode-languageclient/node");
const lspModelProvider_1 = require("./providers/lspModelProvider");
const modelExplorerProvider_1 = require("./explorer/modelExplorerProvider");
const logger_1 = require("./logger");
const visualizationPanel_1 = require("./visualization/visualizationPanel");
const constants_1 = require("./visualization/webview/constants");
const htmlBuilder_1 = require("./visualization/htmlBuilder");
let client;
let statusItem;
let modelExplorerProvider;
let lspModelProviderForStatus;
function getBundledServerCommand(extensionPath) {
    const platform = process.platform;
    const arch = process.arch;
    const binaryName = platform === "win32" ? "sysml-language-server.exe" : "sysml-language-server";
    const bundledPath = path.join(extensionPath, "server", `${platform}-${arch}`, binaryName);
    if (fs.existsSync(bundledPath)) {
        return bundledPath;
    }
    return "sysml-language-server";
}
function isSysmlDoc(doc) {
    if (!doc)
        return false;
    return doc.languageId === "sysml" || doc.languageId === "kerml";
}
function ensureStatusItem(context) {
    if (!statusItem) {
        statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusItem.name = "SysML Diagnostics";
        statusItem.command = "workbench.actions.view.problems";
        context.subscriptions.push(statusItem);
    }
    return statusItem;
}
function updateStatusBar(context) {
    const cfg = vscode.workspace.getConfiguration("sysml-language-server");
    const enabled = cfg.get("statusBar.enabled", true);
    if (!enabled) {
        statusItem?.hide();
        return;
    }
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (!doc || !isSysmlDoc(doc)) {
        statusItem?.hide();
        return;
    }
    const item = ensureStatusItem(context);
    const diags = vscode.languages.getDiagnostics(doc.uri);
    const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
    const icon = errors > 0 ? "$(error)" : warnings > 0 ? "$(warning)" : "$(check)";
    item.text = `${icon} SysML: ${errors}E ${warnings}W`;
    const baseTooltip = `${errors} error(s), ${warnings} warning(s)\nClick to open Problems panel.`;
    item.tooltip = baseTooltip;
    item.show();
    // Append server health to tooltip (async, best-effort)
    const provider = lspModelProviderForStatus;
    if (provider) {
        provider.getServerStats().then((stats) => {
            if (!stats || !statusItem)
                return;
            const uptimeStr = stats.uptime >= 60
                ? `${Math.floor(stats.uptime / 60)}m ${stats.uptime % 60}s`
                : `${stats.uptime}s`;
            const caches = stats.caches;
            item.tooltip = `${baseTooltip}\n\n── LSP Server ──\nUptime: ${uptimeStr}\nCaches: ${caches.documents} docs, ${caches.symbolTables} symbols`;
        }).catch(() => { });
    }
}
function activate(context) {
    (0, logger_1.log)("Extension activating");
    const config = vscode.workspace.getConfiguration("sysml-language-server");
    const serverPath = config.get("serverPath") ?? "sysml-language-server";
    const libraryPathsRaw = config.get("libraryPaths") ?? [];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const libraryPaths = libraryPathsRaw.map((p) => path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p));
    let serverCommand;
    if (serverPath === "sysml-language-server") {
        serverCommand = getBundledServerCommand(context.extensionPath);
    }
    else if (path.isAbsolute(serverPath)) {
        serverCommand = serverPath;
    }
    else {
        serverCommand = path.resolve(workspaceRoot, serverPath);
    }
    // On Windows, if the path doesn't exist but path.exe does, use that (e.g. target/release/sysml-language-server)
    if (process.platform === "win32" &&
        !fs.existsSync(serverCommand) &&
        !serverCommand.endsWith(".exe")) {
        const withExe = `${serverCommand}.exe`;
        if (fs.existsSync(withExe)) {
            serverCommand = withExe;
        }
    }
    (0, logger_1.log)("Server command:", serverCommand, "libraryPaths:", libraryPaths);
    const serverOptions = {
        command: serverCommand,
        args: [],
        transport: node_1.TransportKind.stdio,
    };
    const clientOptions = {
        documentSelector: [
            { language: "sysml" },
            { language: "kerml" },
        ],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{sysml,kerml}"),
        },
        initializationOptions: {
            libraryPaths,
        },
    };
    client = new node_1.LanguageClient("sysmlLanguageServer", "SysML Language Server", serverOptions, clientOptions);
    const clientReadyPromise = client.start()
        .then(() => {
        (0, logger_1.log)("Language client ready, refreshing Model Explorer");
        modelExplorerProvider?.refresh();
    })
        .catch(() => {
        // Intentionally swallow; tests already handle missing server gracefully.
    });
    (0, logger_1.log)("Language client started");
    // Model Explorer (phase 3). getModel awaits whenReady so the server has received didOpen.
    const lspModelProvider = new lspModelProvider_1.LspModelProvider(client, clientReadyPromise);
    lspModelProviderForStatus = lspModelProvider;
    modelExplorerProvider = new modelExplorerProvider_1.ModelExplorerProvider(lspModelProvider);
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer("sysmlVisualizer", {
        async deserializeWebviewPanel(panel, _state) {
            const saved = context.workspaceState.get(visualizationPanel_1.RESTORE_STATE_KEY);
            const extVersion = vscode.extensions.getExtension("Elan8.sysml-language-server")
                ?.packageJSON?.version ?? "0.0.0";
            if (!saved?.documentUri) {
                panel.webview.html = (0, htmlBuilder_1.getWebviewHtml)(panel.webview, context.extensionUri, extVersion);
                return;
            }
            try {
                await visualizationPanel_1.VisualizationPanel.restore(panel, context, lspModelProvider, saved);
            }
            catch (err) {
                (0, logger_1.logError)("Failed to restore visualization panel", err);
                panel.webview.html = (0, htmlBuilder_1.getWebviewHtml)(panel.webview, context.extensionUri, extVersion);
            }
        },
    }));
    const treeView = vscode.window.createTreeView("sysmlModelExplorer", {
        treeDataProvider: modelExplorerProvider,
    });
    modelExplorerProvider.setTreeView(treeView);
    context.subscriptions.push(treeView);
    context.subscriptions.push(vscode.commands.registerCommand("sysml.refreshModelTree", async () => {
        if (modelExplorerProvider?.isWorkspaceMode()) {
            await loadWorkspaceSysMLFiles(modelExplorerProvider);
        }
        else {
            modelExplorerProvider?.refresh();
        }
    }));
    async function loadWorkspaceSysMLFiles(provider) {
        const workspaceFile = vscode.workspace.workspaceFile;
        if (!workspaceFile) {
            (0, logger_1.log)("loadWorkspaceSysMLFiles: no workspace file");
            return;
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        const fileUris = [];
        for (const folder of folders) {
            const sysml = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.sysml"), null, 500);
            const kerml = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.kerml"), null, 500);
            fileUris.push(...sysml, ...kerml);
        }
        (0, logger_1.log)("loadWorkspaceSysMLFiles: found", fileUris.length, "files");
        if (fileUris.length > 0) {
            await provider.loadWorkspaceModel(fileUris);
            (0, logger_1.log)("loadWorkspaceSysMLFiles: loaded model for", fileUris.length, "files");
            vscode.commands.executeCommand("setContext", "sysml.hasWorkspace", true);
            vscode.commands.executeCommand("setContext", "sysml.workspaceViewMode", provider.getWorkspaceViewMode());
            vscode.commands.executeCommand("setContext", "sysml.modelLoaded", true);
        }
    }
    context.subscriptions.push(vscode.commands.registerCommand("sysml.switchToByFile", () => {
        modelExplorerProvider?.setWorkspaceViewMode("byFile");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.switchToSemanticModel", () => {
        modelExplorerProvider?.setWorkspaceViewMode("bySemantic");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.toggleWorkspaceViewMode", () => {
        modelExplorerProvider?.toggleWorkspaceViewMode();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.openLocation", async (item) => {
        (0, logger_1.log)("openLocation called", "item:", !!item, "elementUri:", !!item?.elementUri, "resourceUri:", !!item?.resourceUri);
        if (!item)
            return;
        const uri = item.elementUri ?? item.resourceUri;
        if (!uri) {
            (0, logger_1.logError)("openLocation: element has no URI", item);
            vscode.window.showErrorMessage("Cannot open location: element has no URI.");
            return;
        }
        const dtoRange = item.element?.range;
        if (!dtoRange)
            return;
        const range = new vscode.Range(new vscode.Position(dtoRange.start.line, dtoRange.start.character), new vscode.Position(dtoRange.end.line, dtoRange.end.character));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
            preserveFocus: false,
            preview: true,
        });
        editor.selection = new vscode.Selection(range.start, range.start);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }));
    // Commands (quick wins)
    context.subscriptions.push(vscode.commands.registerCommand("sysml.formatDocument", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!isSysmlDoc(editor?.document)) {
            vscode.window.showWarningMessage("No SysML/KerML document is active.");
            return;
        }
        await vscode.commands.executeCommand("editor.action.formatDocument");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.validateModel", async () => {
        const editor = vscode.window.activeTextEditor;
        const doc = editor?.document;
        if (!doc || !isSysmlDoc(doc)) {
            vscode.window.showWarningMessage("No SysML/KerML document is active.");
            return;
        }
        const diags = vscode.languages.getDiagnostics(doc.uri);
        const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
        const warnings = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
        vscode.window.showInformationMessage(`Validation: ${errors} error(s), ${warnings} warning(s).`);
        await vscode.commands.executeCommand("workbench.actions.view.problems");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.restartServer", async () => {
        if (!client) {
            vscode.window.showErrorMessage("SysML language server is not running.");
            return;
        }
        try {
            await client.stop();
            client.start();
            vscode.window.showInformationMessage("SysML language server restarted.");
        }
        catch (e) {
            (0, logger_1.logError)("restartServer failed", e);
            vscode.window.showErrorMessage(`Failed to restart server: ${e}`);
        }
    }));
    // Placeholder commands for later phases (so palette entries don't fail).
    context.subscriptions.push(vscode.commands.registerCommand("sysml.showModelExplorer", async () => {
        await vscode.commands.executeCommand("workbench.view.explorer");
        await vscode.commands.executeCommand("setContext", "sysml.modelLoaded", isSysmlDoc(vscode.window.activeTextEditor?.document));
        await vscode.commands.executeCommand("sysmlModelExplorer.focus");
        modelExplorerProvider?.refresh();
    }));
    const visualizationViews = [
        { id: "general-view", label: "General", description: "General view (SysML v2 general-view)" },
        { id: "interconnection-view", label: "Interconnection", description: "Parts, ports, connections (SysML v2 interconnection-view)" },
        // Disabled for next release: interconnection-view (routing), action-flow-view, state-transition-view, sequence-view
    ].filter((v) => constants_1.ENABLED_VIEWS.has(v.id));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.showVisualizer", async () => {
        if (!client) {
            vscode.window.showErrorMessage("SysML language server is not running.");
            return;
        }
        let editor = vscode.window.activeTextEditor;
        if (!editor || (editor.document.languageId !== "sysml" && editor.document.languageId !== "kerml")) {
            editor = vscode.window.visibleTextEditors.find((e) => (e.document.languageId === "sysml" || e.document.languageId === "kerml") && !e.document.isClosed);
        }
        if (!editor) {
            vscode.window.showWarningMessage("No SysML/KerML document is open. Open a .sysml or .kerml file first.");
            return;
        }
        visualizationPanel_1.VisualizationPanel.createOrShow(context, editor.document, undefined, lspModelProvider);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.visualizeFolder", async (uri, selectedUris) => {
        if (!client) {
            vscode.window.showErrorMessage("SysML language server is not running.");
            return;
        }
        try {
            let targetUris = [];
            if (selectedUris && selectedUris.length > 0) {
                targetUris = selectedUris;
            }
            else if (uri) {
                targetUris = [uri];
            }
            else {
                const editor = vscode.window.activeTextEditor;
                if (editor)
                    targetUris = [editor.document.uri];
            }
            if (targetUris.length === 0) {
                vscode.window.showErrorMessage("No folder or file selected for SysML visualization");
                return;
            }
            const allSysmlFiles = [];
            const folderNames = [];
            for (const targetUri of targetUris) {
                const stat = await vscode.workspace.fs.stat(targetUri);
                if (stat.type === vscode.FileType.Directory) {
                    const folderName = targetUri.fsPath.split(/[/\\]/).pop() ?? "";
                    folderNames.push(folderName);
                    const sysml = await vscode.workspace.findFiles(new vscode.RelativePattern(targetUri, "**/*.sysml"), "**/node_modules/**");
                    const kerml = await vscode.workspace.findFiles(new vscode.RelativePattern(targetUri, "**/*.kerml"), "**/node_modules/**");
                    allSysmlFiles.push(...sysml, ...kerml);
                }
                else if (targetUri.fsPath.endsWith(".sysml") || targetUri.fsPath.endsWith(".kerml")) {
                    allSysmlFiles.push(targetUri);
                }
            }
            const uniqueFiles = [...new Map(allSysmlFiles.map((f) => [f.fsPath, f])).values()];
            if (uniqueFiles.length === 0) {
                vscode.window.showInformationMessage("No SysML/KerML files found in the selected folders/files");
                return;
            }
            const openDocs = [];
            let combinedContent = "";
            const fileNames = [];
            for (const fileUri of uniqueFiles) {
                try {
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    openDocs.push(doc);
                    const fileName = fileUri.fsPath.split(/[/\\]/).pop() ?? "";
                    fileNames.push(fileName);
                    combinedContent += `// === ${fileName} ===\n`;
                    combinedContent += doc.getText();
                    combinedContent += "\n\n";
                }
                catch {
                    (0, logger_1.log)("Failed to open SysML file", fileUri.fsPath);
                }
            }
            if (openDocs.length === 0) {
                vscode.window.showErrorMessage("Failed to read any SysML files");
                return;
            }
            const firstDoc = openDocs[0];
            const combinedDocumentProxy = {
                getText: () => combinedContent,
                uri: firstDoc.uri,
                languageId: "sysml",
                version: firstDoc.version,
                lineCount: combinedContent.split("\n").length,
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
            let title;
            if (folderNames.length > 0) {
                title = `SysML Visualization - ${fileNames.length} files from ${folderNames.length} folder(s)`;
            }
            else {
                title = `SysML Visualization - ${fileNames.length} file(s)`;
            }
            visualizationPanel_1.VisualizationPanel.createOrShow(context, combinedDocumentProxy, title, lspModelProvider, uniqueFiles);
            if (modelExplorerProvider) {
                await modelExplorerProvider.loadWorkspaceModel(uniqueFiles);
            }
        }
        catch (error) {
            (0, logger_1.logError)("sysml.visualizeFolder failed", error);
            vscode.window.showErrorMessage(`Failed to visualize SysML: ${error}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.showOutput", () => {
        (0, logger_1.showChannel)();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.clearCache", async () => {
        if (!client) {
            vscode.window.showErrorMessage("SysML language server is not running.");
            return;
        }
        const result = await lspModelProvider.clearCache();
        if (result) {
            const total = result.documents + result.symbolTables + result.semanticTokens;
            vscode.window.showInformationMessage(`SysML: Cleared ${total} cache entries (${result.documents} docs, ${result.symbolTables} symbols)`);
            modelExplorerProvider?.refresh();
            // Refresh visualizer if open
            visualizationPanel_1.VisualizationPanel.currentPanel?.refresh();
        }
        else {
            vscode.window.showWarningMessage("SysML: Could not clear cache (server may not be ready).");
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.visualizePackage", async (item) => {
        if (!item || !client) {
            vscode.window.showErrorMessage("No package selected or server not running.");
            return;
        }
        if (item.element.type !== "package") {
            vscode.window.showInformationMessage("Visualize package is available for package elements.");
            return;
        }
        const packageName = item.element.name;
        const fileUri = item.elementUri;
        const isWorkspace = modelExplorerProvider?.isWorkspaceMode() ?? false;
        const workspaceUris = isWorkspace ? modelExplorerProvider?.getWorkspaceFileUris() : undefined;
        const document = await vscode.workspace.openTextDocument(fileUri);
        if (isWorkspace && workspaceUris && workspaceUris.length > 1) {
            const openDocs = [];
            let combinedContent = "";
            const fileNames = [];
            for (const uri of workspaceUris) {
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    openDocs.push(doc);
                    const fileName = uri.fsPath.split(/[/\\]/).pop() ?? "";
                    fileNames.push(fileName);
                    combinedContent += `// === ${fileName} ===\n`;
                    combinedContent += doc.getText();
                    combinedContent += "\n\n";
                }
                catch {
                    /* skip */
                }
            }
            if (openDocs.length > 0) {
                const firstDoc = openDocs[0];
                const combinedDocumentProxy = {
                    getText: () => combinedContent,
                    uri: firstDoc.uri,
                    languageId: "sysml",
                    version: firstDoc.version,
                    lineCount: combinedContent.split("\n").length,
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
                const title = `SysML Visualization - ${fileNames.length} file(s)`;
                visualizationPanel_1.VisualizationPanel.createOrShow(context, combinedDocumentProxy, title, lspModelProvider, workspaceUris);
                setTimeout(() => {
                    visualizationPanel_1.VisualizationPanel.currentPanel?.selectPackage(packageName);
                }, 500);
                return;
            }
        }
        visualizationPanel_1.VisualizationPanel.createOrShow(context, document, undefined, lspModelProvider);
        setTimeout(() => {
            visualizationPanel_1.VisualizationPanel.currentPanel?.selectPackage(packageName);
        }, 500);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.changeVisualizerView", async (viewId) => {
        if (!visualizationPanel_1.VisualizationPanel.currentPanel) {
            vscode.window.showWarningMessage("No visualization panel is currently open");
            return;
        }
        let selectedViewId = viewId;
        if (!selectedViewId) {
            const selected = await vscode.window.showQuickPick(visualizationViews.map((v) => ({
                label: v.label,
                description: v.description,
                viewId: v.id,
            })), { placeHolder: "Select visualization view" });
            selectedViewId = selected?.viewId;
        }
        if (selectedViewId) {
            const view = constants_1.ENABLED_VIEWS.has(selectedViewId) ? selectedViewId : 'general-view';
            visualizationPanel_1.VisualizationPanel.currentPanel.changeView(view);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.visualizeFolderWithView", async (uri, selectedUris) => {
        const selected = await vscode.window.showQuickPick(visualizationViews.map((v) => ({
            label: v.label,
            description: v.description,
            viewId: v.id,
        })), { placeHolder: "Select visualization view" });
        if (selected) {
            await vscode.commands.executeCommand("sysml.visualizeFolder", uri, selectedUris);
            if (visualizationPanel_1.VisualizationPanel.currentPanel) {
                await vscode.commands.executeCommand("sysml.changeVisualizerView", selected.viewId);
            }
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.exportVisualization", async () => {
        if (!visualizationPanel_1.VisualizationPanel.currentPanel) {
            vscode.window.showWarningMessage("No visualization panel is currently open");
            return;
        }
        const config = vscode.workspace.getConfiguration("sysml-language-server");
        const defaultScale = config.get("visualization.exportScale", 2);
        const selected = await vscode.window.showQuickPick([
            { label: "PNG", format: "png" },
            { label: "SVG", format: "svg" },
        ], { placeHolder: "Select export format" });
        if (selected) {
            visualizationPanel_1.VisualizationPanel.currentPanel.exportVisualization(selected.format, defaultScale);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.refreshVisualization", async () => {
        if (!visualizationPanel_1.VisualizationPanel.currentPanel) {
            vscode.window.showWarningMessage("No visualization panel is currently open");
            return;
        }
        const doc = visualizationPanel_1.VisualizationPanel.currentPanel.getDocument();
        visualizationPanel_1.VisualizationPanel.currentPanel.dispose();
        visualizationPanel_1.VisualizationPanel.createOrShow(context, doc, undefined, lspModelProvider);
    }));
    // Status bar + context for contributed view
    const refreshContext = () => {
        const active = vscode.window.activeTextEditor?.document;
        const loaded = isSysmlDoc(active);
        vscode.commands.executeCommand("setContext", "sysml.modelLoaded", loaded);
        updateStatusBar(context);
        // Refresh Model Explorer when switching to a SysML doc so the tree shows the correct model
        if (loaded) {
            modelExplorerProvider?.refresh();
        }
    };
    refreshContext();
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => refreshContext()));
    // When a SysML document is opened, refresh so we load it (did_open will be processed by then)
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.languageId === "sysml" || doc.languageId === "kerml") {
            modelExplorerProvider?.refresh();
        }
    }));
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => updateStatusBar(context)));
    // Notify visualizer when SysML files change so it can refresh
    const sysmlFileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{sysml,kerml}");
    sysmlFileWatcher.onDidChange((uri) => {
        visualizationPanel_1.VisualizationPanel.currentPanel?.notifyFileChanged(uri);
    });
    sysmlFileWatcher.onDidCreate((uri) => {
        visualizationPanel_1.VisualizationPanel.currentPanel?.notifyFileChanged(uri);
    });
    sysmlFileWatcher.onDidDelete((uri) => {
        visualizationPanel_1.VisualizationPanel.currentPanel?.notifyFileChanged(uri);
    });
    context.subscriptions.push(sysmlFileWatcher);
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId === "sysml" || doc.languageId === "kerml") {
            visualizationPanel_1.VisualizationPanel.currentPanel?.notifyFileChanged(doc.uri);
        }
    }));
    // Workspace mode: when .code-workspace is open, load all SysML/KerML files after delay
    const workspaceFile = vscode.workspace.workspaceFile;
    (0, logger_1.log)("Activation complete. Workspace file:", !!workspaceFile);
    vscode.commands.executeCommand("setContext", "sysml.hasWorkspace", !!workspaceFile);
    if (workspaceFile && modelExplorerProvider) {
        const provider = modelExplorerProvider;
        setTimeout(() => {
            loadWorkspaceSysMLFiles(provider).catch(() => { });
        }, 3000);
    }
}
function deactivate() {
    return client?.stop();
}
//# sourceMappingURL=extension.js.map