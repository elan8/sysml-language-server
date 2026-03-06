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
const visualizationPanel_1 = require("./visualization/visualizationPanel");
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
    client.start();
    // Avoid unhandled promise rejections when the server binary isn't available
    // (common in dev/test environments).
    const maybeOnReady = client.onReady;
    if (typeof maybeOnReady === "function") {
        maybeOnReady().catch(() => {
            // Intentionally swallow; tests already handle missing server gracefully.
        });
    }
    // Model Explorer (phase 3)
    const lspModelProvider = new lspModelProvider_1.LspModelProvider(client);
    lspModelProviderForStatus = lspModelProvider;
    modelExplorerProvider = new modelExplorerProvider_1.ModelExplorerProvider(lspModelProvider);
    const treeView = vscode.window.createTreeView("sysmlModelExplorer", {
        treeDataProvider: modelExplorerProvider,
    });
    context.subscriptions.push(treeView);
    context.subscriptions.push(vscode.commands.registerCommand("sysml.refreshModelTree", () => {
        modelExplorerProvider?.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sysml.openLocation", async (item) => {
        const dtoRange = item.element.range;
        const range = new vscode.Range(new vscode.Position(dtoRange.start.line, dtoRange.start.character), new vscode.Position(dtoRange.end.line, dtoRange.end.character));
        const doc = await vscode.workspace.openTextDocument(item.uri);
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
    context.subscriptions.push(vscode.commands.registerCommand("sysml.showVisualizer", async () => {
        if (!client) {
            vscode.window.showErrorMessage("SysML language server is not running.");
            return;
        }
        visualizationPanel_1.VisualizationPanel.createOrShow(context.extensionUri, lspModelProvider);
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
        visualizationPanel_1.VisualizationPanel.createOrShow(context.extensionUri, lspModelProvider, item.element.name);
    }));
    // Status bar + context for contributed view
    const refreshContext = () => {
        const active = vscode.window.activeTextEditor?.document;
        const loaded = isSysmlDoc(active);
        vscode.commands.executeCommand("setContext", "sysml.modelLoaded", loaded);
        updateStatusBar(context);
    };
    refreshContext();
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => refreshContext()));
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => updateStatusBar(context)));
}
function deactivate() {
    return client?.stop();
}
//# sourceMappingURL=extension.js.map