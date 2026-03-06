/**
 * Webview entry point. Listens for messages from the extension host and dispatches
 * to prepareData + renderers. D3, Cytoscape, and ELK are loaded as scripts before
 * this bundle and are available as globals.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { prepareDataForView } from './prepareData';
import { quickHash } from './shared';
import { renderPlaceholderView } from './renderers/placeholder';

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };

(function () {
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };

    let currentData: unknown = null;
    let currentView = 'elk';
    let lastDataHash = '';

    window.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data as { command?: string; view?: string; data?: unknown; format?: string; scale?: number };
        switch (msg.command) {
            case 'update':
                currentData = msg;
                currentView = (msg as any).currentView ?? currentView;
                renderStub();
                break;
            case 'export':
                // Stub: will be implemented in export module
                vscode.postMessage({ command: 'export', format: msg.format ?? 'png', data: null });
                break;
            default:
                break;
        }
    });

    function renderStub(): void {
        const container = document.getElementById('visualization');
        if (!container) return;
        const prepared = currentData ? prepareDataForView(currentData, currentView) : null;
        const newHash = prepared ? quickHash({ data: prepared, view: currentView }) : '';
        if (newHash !== lastDataHash) {
            lastDataHash = newHash;
        }
        const width = container.clientWidth || 400;
        const height = container.clientHeight || 300;
        renderPlaceholderView(width, height, prepared, 'Loading diagram...');
    }

    // Notify host that webview is ready
    vscode.postMessage({ command: 'webviewReady' });
})();
