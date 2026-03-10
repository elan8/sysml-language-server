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
exports.createMessageDispatcher = createMessageDispatcher;
exports.createMessageHandlers = createMessageHandlers;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const logger_1 = require("../logger");
const lspModelProvider_1 = require("../providers/lspModelProvider");
function createMessageDispatcher(ctx) {
    const handlers = createMessageHandlers(ctx);
    const { panel, document, fileUris, setCurrentView, setLastContentHash, updateVisualization } = ctx;
    return (message) => {
        switch (message.command) {
            case 'webviewLog':
                // Also mirror to console so extension tests capture it.
                // The Output channel is not always visible in test logs.
                try {
                    // eslint-disable-next-line no-console
                    console.log('[SysML Visualizer][WebviewLog]', message.level, ...(message.args ?? []));
                }
                catch {
                    // ignore
                }
                handlers.logWebviewMessage(message.level, message.args ?? []);
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
                    const allowedCommands = [];
                    if (!allowedCommands.includes(cmd)) {
                        // eslint-disable-next-line no-console
                        console.warn(`[SysML Visualizer] Blocked disallowed command: ${cmd}`);
                        break;
                    }
                    if (cmd === 'sysml.showModelDashboard') {
                        const dashboardUri = fileUris.length > 0 ? fileUris[0] : document.uri;
                        setTimeout(() => vscode.commands.executeCommand(cmd, dashboardUri), 100);
                    }
                    else {
                        const cmdArgs = message.args.slice(1);
                        setTimeout(() => vscode.commands.executeCommand(cmd, ...cmdArgs), 100);
                    }
                }
                break;
            case 'viewChanged':
                setCurrentView(message.view ?? '');
                break;
            case 'openExternal':
                if (message.url) {
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
                break;
            case 'currentViewResponse':
                setCurrentView(message.view ?? '');
                break;
            case 'webviewReady':
                setLastContentHash('');
                updateVisualization(true);
                break;
            case 'testDiagramExported':
                handleTestDiagramExported(message.viewId, message.svgString).catch(err => 
                // eslint-disable-next-line no-console
                console.error('[SysML Visualizer] Failed to write test diagram:', err));
                break;
        }
    };
}
async function handleTestDiagramExported(viewId, svgString) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder)
        return;
    const outputDir = vscode.Uri.joinPath(workspaceFolder.uri, 'test-output', 'diagrams');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, 'test-output'));
    await vscode.workspace.fs.createDirectory(outputDir);
    const safeViewId = (viewId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileUri = vscode.Uri.joinPath(outputDir, `${safeViewId}.svg`);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(svgString, 'utf8'));
}
function createMessageHandlers(context) {
    const { panel, document, lspModelProvider, fileUris, updateVisualization, setNavigating } = context;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function logWebviewMessage(level, args) {
        try {
            const outputChannel = (0, logger_1.getOutputChannel)();
            if (!outputChannel) {
                return;
            }
            const formattedArgs = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg, null, 2);
                    }
                    catch {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ');
            const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
            outputChannel.appendLine(`[Webview ${level.toUpperCase()}] ${prefix} ${formattedArgs}`);
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error('Failed to log webview message:', error);
        }
    }
    async function jumpToElement(elementName, skipCentering = false, parentContext) {
        setNavigating(true);
        let element;
        const dto = await lspModelProvider.findElement(document.uri.toString(), elementName, parentContext);
        if (dto) {
            element = {
                type: dto.type,
                name: dto.name,
                range: (0, lspModelProvider_1.toVscodeRange)(dto.range),
                children: [],
                attributes: new Map(),
                relationships: [],
            };
        }
        if (element) {
            const visualizerColumn = panel.viewColumn || vscode.ViewColumn.Two;
            const targetColumn = visualizerColumn === vscode.ViewColumn.One
                ? vscode.ViewColumn.Two
                : vscode.ViewColumn.One;
            vscode.window.showTextDocument(document, {
                viewColumn: targetColumn,
                preserveFocus: true,
                preview: false,
            }).then(editor => {
                editor.selection = new vscode.Selection(element.range.start, element.range.end);
                editor.revealRange(element.range, vscode.TextEditorRevealType.InCenter);
                const decorationType = vscode.window.createTextEditorDecorationType({
                    backgroundColor: 'rgba(255, 215, 0, 0.4)',
                    border: '2px solid #FFD700',
                    borderRadius: '3px',
                    isWholeLine: false,
                    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
                });
                editor.setDecorations(decorationType, [element.range]);
                setTimeout(() => {
                    decorationType.dispose();
                }, 3000);
                if (!skipCentering) {
                    panel.webview.postMessage({
                        command: 'highlightElement',
                        elementName: elementName,
                        skipCentering: skipCentering,
                    });
                }
                setTimeout(() => setNavigating(false), 500);
            });
        }
        else {
            vscode.window.showInformationMessage(`Element "${elementName}" not found in the current document.`);
            setNavigating(false);
        }
    }
    function escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    async function renameElement(oldName, newName) {
        if (!newName || newName === oldName) {
            return;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) {
            vscode.window.showErrorMessage(`Invalid element name: "${newName}". Names must start with a letter or underscore and contain only alphanumeric characters and underscores.`);
            updateVisualization(true);
            return;
        }
        let element;
        const dto = await lspModelProvider.findElement(document.uri.toString(), oldName);
        if (dto) {
            element = {
                type: dto.type,
                name: dto.name,
                range: (0, lspModelProvider_1.toVscodeRange)(dto.range),
                children: [],
                attributes: new Map(),
                relationships: [],
            };
        }
        if (!element || !element.range) {
            vscode.window.showErrorMessage(`Could not find element "${oldName}" to rename.`);
            updateVisualization(true);
            return;
        }
        const text = document.getText();
        const elementStartOffset = document.offsetAt(element.range.start);
        const elementEndOffset = document.offsetAt(element.range.end);
        const elementText = text.substring(elementStartOffset, elementEndOffset);
        const namePattern = new RegExp(`\\b${escapeRegex(oldName)}\\b`);
        const nameMatch = elementText.match(namePattern);
        if (!nameMatch || nameMatch.index === undefined) {
            vscode.window.showErrorMessage(`Could not locate name "${oldName}" in the element definition.`);
            updateVisualization(true);
            return;
        }
        const nameStartOffset = elementStartOffset + nameMatch.index;
        const nameEndOffset = nameStartOffset + oldName.length;
        const nameRange = new vscode.Range(document.positionAt(nameStartOffset), document.positionAt(nameEndOffset));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, nameRange, newName);
        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            await document.save();
            vscode.window.showInformationMessage(`Renamed "${oldName}" to "${newName}"`);
        }
        else {
            vscode.window.showErrorMessage(`Failed to rename "${oldName}"`);
            updateVisualization(true);
        }
    }
    async function handleExport(format, data) {
        const filters = {
            'PNG Images': ['png'],
            'SVG Images': ['svg'],
            'JSON Files': ['json'],
        };
        let defaultFolder;
        if (document?.uri?.scheme === 'file' && document.uri.fsPath) {
            defaultFolder = vscode.Uri.file(path.dirname(document.uri.fsPath));
        }
        if (!defaultFolder && fileUris.length > 0) {
            defaultFolder = vscode.Uri.file(path.dirname(fileUris[0].fsPath));
        }
        if (!defaultFolder) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor?.document.uri.scheme === 'file') {
                defaultFolder = vscode.Uri.file(path.dirname(activeEditor.document.uri.fsPath));
            }
        }
        if (!defaultFolder && vscode.workspace.workspaceFolders?.length) {
            defaultFolder = vscode.workspace.workspaceFolders[0].uri;
        }
        const defaultUri = defaultFolder
            ? vscode.Uri.joinPath(defaultFolder, `sysml-model.${format}`)
            : vscode.Uri.file(`sysml-model.${format}`);
        const uri = await vscode.window.showSaveDialog({
            filters: filters,
            defaultUri: defaultUri,
        });
        if (uri) {
            let buffer;
            if (format === 'json') {
                if (data.startsWith('data:')) {
                    buffer = Buffer.from(data.split(',')[1], 'base64');
                }
                else {
                    buffer = Buffer.from(data, 'utf8');
                }
            }
            else {
                if (data.startsWith('data:')) {
                    buffer = Buffer.from(data.split(',')[1], 'base64');
                }
                else {
                    buffer = Buffer.from(data, 'utf8');
                }
            }
            await vscode.workspace.fs.writeFile(uri, buffer);
            vscode.window.showInformationMessage(`Visualization exported to ${uri.fsPath}`);
        }
    }
    return {
        logWebviewMessage,
        jumpToElement,
        renameElement,
        handleExport,
    };
}
//# sourceMappingURL=messageHandlers.js.map