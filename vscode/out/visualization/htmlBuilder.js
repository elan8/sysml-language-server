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
exports.getWebviewHtml = getWebviewHtml;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const styles_1 = require("./styles");
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
function getWebviewHtml(webview, extensionUri, extensionVersion) {
    const templatePath = path.join(extensionUri.fsPath, 'media', 'webview', 'visualizer.html');
    let html = fs.readFileSync(templatePath, 'utf8');
    const nonce = getNonce();
    const vars = {
        NONCE: nonce,
        CSP_SOURCE: webview.cspSource,
        D3_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'd3.min.js')).toString(),
        ELK_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'elk.bundled.js')).toString(),
        ELK_WORKER_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'elkWorker.js')).toString(),
        CYTOSCAPE_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'cytoscape.min.js')).toString(),
        CYTOSCAPE_ELK_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'cytoscape-elk.js')).toString(),
        CYTOSCAPE_SVG_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'cytoscape-svg.js')).toString(),
        VISUALIZER_JS_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'visualizer.js')).toString(),
        STYLES: (0, styles_1.getVisualizerStyles)(),
        EXTENSION_VERSION: extensionVersion ?? '0.0.0',
    };
    for (const [key, value] of Object.entries(vars)) {
        html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return html;
}
//# sourceMappingURL=htmlBuilder.js.map