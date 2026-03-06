"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUpdateVisualizationFlow = createUpdateVisualizationFlow;
const modelFetcher_1 = require("./modelFetcher");
function createUpdateVisualizationFlow(deps) {
    const { panel, document, fileUris, lspModelProvider, getCurrentView, getPendingPackageName, getIsNavigating, getNeedsUpdateWhenVisible, getLastContentHash, setLastContentHash, setNeedsUpdateWhenVisible, clearPendingPackageName, } = deps;
    async function doUpdateVisualization() {
        try {
            const msg = await (0, modelFetcher_1.fetchModelData)({
                documentUri: document.uri.toString(),
                fileUris,
                lspModelProvider,
                currentView: getCurrentView(),
                pendingPackageName: getPendingPackageName(),
            });
            clearPendingPackageName();
            if (msg) {
                panel.webview.postMessage(msg);
            }
        }
        catch {
            panel.webview.postMessage({ command: 'hideLoading' });
        }
    }
    async function update(forceUpdate = false) {
        if (getIsNavigating()) {
            return;
        }
        if (!panel.visible) {
            setNeedsUpdateWhenVisible(true);
            return;
        }
        const content = document.getText();
        const contentHash = (0, modelFetcher_1.hashContent)(content);
        if (!forceUpdate && contentHash === getLastContentHash()) {
            return;
        }
        setLastContentHash(contentHash);
        panel.webview.postMessage({ command: 'showLoading', message: 'Parsing SysML model...' });
        await new Promise(resolve => setTimeout(resolve, 0));
        await doUpdateVisualization();
    }
    return { update };
}
//# sourceMappingURL=updateFlow.js.map