/**
 * Webview entry point. Listens for messages from the extension host and dispatches
 * to prepareData + renderers. D3, Cytoscape, and ELK are loaded as scripts before
 * this bundle and are available as globals.
 */
declare const acquireVsCodeApi: () => {
    postMessage: (msg: unknown) => void;
};
//# sourceMappingURL=index.d.ts.map