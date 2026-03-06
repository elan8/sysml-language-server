import * as vscode from 'vscode';
import type { LspModelProvider } from '../providers/lspModelProvider';
import { fetchModelData, hashContent } from './modelFetcher';

export interface UpdateFlowDeps {
    panel: vscode.WebviewPanel;
    document: vscode.TextDocument;
    fileUris: vscode.Uri[];
    lspModelProvider: LspModelProvider;
    getCurrentView: () => string;
    getPendingPackageName: () => string | undefined;
    getIsNavigating: () => boolean;
    getNeedsUpdateWhenVisible: () => boolean;
    getLastContentHash: () => string;
    setLastContentHash: (hash: string) => void;
    setNeedsUpdateWhenVisible: (value: boolean) => void;
    clearPendingPackageName: () => void;
}

export function createUpdateVisualizationFlow(deps: UpdateFlowDeps): { update: (force: boolean) => Promise<void> } {
    const {
        panel,
        document,
        fileUris,
        lspModelProvider,
        getCurrentView,
        getPendingPackageName,
        getIsNavigating,
        getNeedsUpdateWhenVisible,
        getLastContentHash,
        setLastContentHash,
        setNeedsUpdateWhenVisible,
        clearPendingPackageName,
    } = deps;

    async function doUpdateVisualization(): Promise<void> {
        try {
            const msg = await fetchModelData({
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
        } catch {
            panel.webview.postMessage({ command: 'hideLoading' });
        }
    }

    async function update(forceUpdate: boolean = false): Promise<void> {
        if (getIsNavigating()) {
            return;
        }

        if (!panel.visible) {
            setNeedsUpdateWhenVisible(true);
            return;
        }

        const content = document.getText();
        const contentHash = hashContent(content);

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
