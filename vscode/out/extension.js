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
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
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
function activate(context) {
    const config = vscode_1.workspace.getConfiguration("sysml-language-server");
    const serverPath = config.get("serverPath") ?? "sysml-language-server";
    let serverCommand;
    if (serverPath === "sysml-language-server") {
        serverCommand = getBundledServerCommand(context.extensionPath);
    }
    else if (path.isAbsolute(serverPath)) {
        serverCommand = serverPath;
    }
    else {
        serverCommand = path.resolve(vscode_1.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", serverPath);
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
            fileEvents: vscode_1.workspace.createFileSystemWatcher("**/*.{sysml,kerml}"),
        },
    };
    client = new node_1.LanguageClient("sysmlLanguageServer", "SysML Language Server", serverOptions, clientOptions);
    client.start();
}
function deactivate() {
    return client?.stop();
}
//# sourceMappingURL=extension.js.map