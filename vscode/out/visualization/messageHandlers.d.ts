import * as vscode from 'vscode';
import { LspModelProvider } from '../providers/lspModelProvider';
export interface MessageHandlerContext {
    panel: vscode.WebviewPanel;
    document: vscode.TextDocument;
    lspModelProvider: LspModelProvider;
    fileUris: vscode.Uri[];
    updateVisualization: (force: boolean) => void;
    setNavigating: (value: boolean) => void;
}
export declare function createMessageHandlers(context: MessageHandlerContext): {
    logWebviewMessage: (level: string, args: any[]) => void;
    jumpToElement: (elementName: string, skipCentering?: boolean, parentContext?: string) => Promise<void>;
    renameElement: (oldName: string, newName: string) => Promise<void>;
    handleExport: (format: string, data: string) => Promise<void>;
};
//# sourceMappingURL=messageHandlers.d.ts.map