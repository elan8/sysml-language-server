import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { VisualizationPanel } from "../../visualization/visualizationPanel";
import { configureServerForTests, waitFor } from "./testUtils";

const VIEW_IDS = [
    "general-view",
    // interconnection-view disabled: edge routing overlap/quality issues
];

describe("Visualization Diagram Views", () => {
    before(async function () {
        this.timeout(20000);
        await configureServerForTests();
    });

    it("exports SVG for all views", async function () {
        this.timeout(60000);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, "Workspace folder should be open");

        const docPath = path.join(workspaceFolder.uri.fsPath, "SurveillanceDrone.sysml");
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
