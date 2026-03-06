import * as vscode from 'vscode';
import { LspModelProvider } from '../providers/lspModelProvider';
export interface MessageHandlerContext {
    panel: vscode.WebviewPanel;
    document: vscode.TextDocument;
    lspModelProvider: LspModelProvider;
    fileUris: vscode.Uri[];
    updateVisualization: (force: boolean) => void;
    setNavigating: (value: boolean) => void;
    setCurrentView: (view: string) => void;
    setLastContentHash: (hash: string) => void;
}
type WebviewMessage = {
    command: string;
    [key: string]: any;
};
export declare function createMessageDispatcher(ctx: MessageHandlerContext): (msg: WebviewMessage) => void;
export declare function createMessageHandlers(context: MessageHandlerContext): {
    logWebviewMessage: (level: string, args: any[]) => void;
    jumpToElement: (elementName: string, skipCentering?: boolean, parentContext?: string) => Promise<void>;
    renameElement: (oldName: string, newName: string) => Promise<void>;
    handleExport: (format: string, data: string) => Promise<void>;
};
export {};
//# sourceMappingURL=messageHandlers.d.ts.map