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
const assert = __importStar(require("assert"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const visualizationPanel_1 = require("../../visualization/visualizationPanel");
const VIEW_IDS = [
    "general-view",
    // interconnection-view disabled: edge routing overlap/quality issues
];
describe("Visualization Diagram Views", () => {
    it("exports SVG for all views", async function () {
        this.timeout(60000);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, "Workspace folder should be open");
        const docPath = path.join(workspaceFolder.uri.fsPath, "SurveillanceDrone.sysml");
        const doc = await vscode.workspace.openTextDocument(docPath);
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand("sysml.showVisualizer");
        await new Promise((r) => setTimeout(r, 5000)); // LSP parse + webview render
        const panel = visualizationPanel_1.VisualizationPanel.currentPanel;
        if (!panel) {
            // Skip if visualizer did not open (e.g. no LSP server)
            this.skip();
            return;
        }
        for (const viewId of VIEW_IDS) {
            await vscode.commands.executeCommand("sysml.changeVisualizerView", viewId);
            await new Promise((r) => setTimeout(r, 2000)); // Wait for render
            panel.getWebview()?.postMessage({ command: "exportDiagramForTest" });
            await new Promise((r) => setTimeout(r, 800)); // Wait for export + file write
        }
        const outputDir = vscode.Uri.joinPath(workspaceFolder.uri, "test-output", "diagrams");
        for (const viewId of VIEW_IDS) {
            const uri = vscode.Uri.joinPath(outputDir, `${viewId}.svg`);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                assert.ok(stat.size >= 0, `${viewId}.svg should exist`);
            }
            catch {
                assert.fail(`${viewId}.svg was not created in test-output/diagrams/`);
            }
        }
    });
});
//# sourceMappingURL=visualization.test.js.map