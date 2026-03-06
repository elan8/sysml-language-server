"use strict";
/**
 * Webview entry point. Listens for messages from the extension host and dispatches
 * to prepareData + renderers. D3, Cytoscape, and ELK are loaded as scripts before
 * this bundle and are available as globals.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
(function () {
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => { } };
    let currentData = null;
    let currentView = 'elk';
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'update':
                currentData = msg.data ?? null;
                currentView = msg.view ?? currentView;
                // Stub: will call prepareDataForView + renderer in phase 1.2
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
    function renderStub() {
        const container = document.getElementById('diagram-container');
        if (container) {
            container.innerHTML = '<p style="padding:1em;color:var(--vscode-descriptionForeground)">Loading...</p>';
        }
    }
    // Notify host that webview is ready
    vscode.postMessage({ command: 'webviewReady' });
})();
//# sourceMappingURL=index.js.map