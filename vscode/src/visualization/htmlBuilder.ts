import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getVisualizerStyles } from './styles';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, extensionVersion?: string): string {
    const templatePath = path.join(extensionUri.fsPath, 'media', 'webview', 'visualizer.html');
    let html = fs.readFileSync(templatePath, 'utf8');

    const nonce = getNonce();
    const vars: Record<string, string> = {
        NONCE: nonce,
        CSP_SOURCE: webview.cspSource,
        D3_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'd3.min.js')).toString(),
        ELK_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'elk.bundled.js')).toString(),
        ELK_WORKER_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'elkWorker.js')).toString(),
        CYTOSCAPE_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'cytoscape.min.js')).toString(),
        CYTOSCAPE_ELK_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'cytoscape-elk.js')).toString(),
        CYTOSCAPE_SVG_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vendor', 'cytoscape-svg.js')).toString(),
        VISUALIZER_JS_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'visualizer.js')).toString(),
        CODICONS_CSS_URI: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')).toString(),
        STYLES: getVisualizerStyles(),
        EXTENSION_VERSION: extensionVersion ?? '0.0.0',
    };

    for (const [key, value] of Object.entries(vars)) {
        html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }

    return html;
}
