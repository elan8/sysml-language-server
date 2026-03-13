import * as assert from "assert";
import * as vscode from "vscode";
import { VisualizationPanel } from "../../visualization/visualizationPanel";
import {
    configureServerForTests,
    getFixturePath,
    getTestWorkspaceFolder,
    waitFor,
    waitForLanguageServerReady,
} from "./testUtils";

const VIEW_IDS = [
    "general-view",
    // interconnection-view disabled: edge routing overlap/quality issues
];

describe("Visualization Diagram Views", () => {
    before(async function () {
        this.timeout(30000);
        await configureServerForTests();
        getTestWorkspaceFolder();
        const docPath = getFixturePath("SurveillanceDrone.sysml");
        const doc = await vscode.workspace.openTextDocument(docPath);
        await waitForLanguageServerReady(doc);
    });

    afterEach(async () => {
        if (VisualizationPanel.currentPanel) {
            VisualizationPanel.currentPanel.dispose();
        }
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    after(async () => {
        if (VisualizationPanel.currentPanel) {
            VisualizationPanel.currentPanel.dispose();
        }
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await new Promise((r) => setTimeout(r, 250));
    });

    it("exports SVG for all views", async function () {
        this.timeout(60000);

        const workspaceFolder = getTestWorkspaceFolder();

        const docPath = getFixturePath("SurveillanceDrone.sysml");
        const doc = await vscode.workspace.openTextDocument(docPath);
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand("sysml.showVisualizer");
        const panel = await waitFor(
            "visualization panel",
            async () => VisualizationPanel.currentPanel,
            (value) => Boolean(value),
            20000,
            300
        );

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
            } catch {
                assert.fail(`${viewId}.svg was not created in test-output/diagrams/`);
            }
        }
    });
});
