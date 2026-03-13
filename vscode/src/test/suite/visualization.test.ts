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
    "interconnection-view",
];

describe("Visualization Diagram Views", () => {
    before(async function () {
        this.timeout(30000);
        await vscode.workspace
            .getConfiguration("sysml-language-server")
            .update("visualization.enableExperimentalViews", true, vscode.ConfigurationTarget.Workspace);
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
        await vscode.workspace
            .getConfiguration("sysml-language-server")
            .update("visualization.enableExperimentalViews", undefined, vscode.ConfigurationTarget.Workspace);
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
                const bytes = await vscode.workspace.fs.readFile(uri);
                const svgText = Buffer.from(bytes).toString("utf8");
                assert.ok(svgText.includes("<svg"), `${viewId}.svg should contain svg markup`);
                if (viewId === "general-view") {
                    assert.ok(
                        svgText.includes("SurveillanceQuadrotorDrone"),
                        "general-view export should include the main drone node"
                    );
                }
                if (viewId === "interconnection-view") {
                    assert.ok(
                        svgText.includes("ibd-part"),
                        "interconnection-view export should include IBD part nodes"
                    );
                    assert.ok(
                        svgText.includes("propulsion"),
                        "interconnection-view export should include known internal parts from the fixture"
                    );
                }
            } catch {
                assert.fail(`${viewId}.svg was not created in test-output/diagrams/`);
            }
        }
    });
});
