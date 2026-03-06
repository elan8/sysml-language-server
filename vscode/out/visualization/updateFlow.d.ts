import * as vscode from 'vscode';
import type { LspModelProvider } from '../providers/lspModelProvider';
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
export declare function createUpdateVisualizationFlow(deps: UpdateFlowDeps): {
    update: (force: boolean) => Promise<void>;
};
//# sourceMappingURL=updateFlow.d.ts.map