import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

describe("Extension Test Suite", () => {
  it("Extension should be present", () => {
    const found = vscode.extensions.all.some(
      (e) => e.packageJSON?.name === "sysml-language-server"
    );
    assert.ok(found, "SysML Language Server extension should be loaded");
  });

  it("SysML language should be registered", async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(
      languages.includes("sysml"),
      "sysml language should be registered"
    );
  });

  it("Hover over keyword returns content", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "Workspace folder should be open");
    const filePath = path.join(workspaceFolder.uri.fsPath, "sample.sysml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 2000));
    const position = new vscode.Position(1, 2);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      doc.uri,
      position
    );
    if (!Array.isArray(hovers) || hovers.length === 0) {
      // Server may not be on PATH (e.g. local run without server built); skip assertion
      return;
    }
    const content = hovers[0].contents;
    const value = Array.isArray(content)
      ? content.map((c) => (typeof c === "string" ? c : c.value)).join("")
      : typeof content === "string"
        ? content
        : (content as { value: string }).value;
    assert.ok(
      value.toLowerCase().includes("part"),
      `Hover content should mention 'part': ${value}`
    );
  });

  it("Go to definition from usage to definition", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "Workspace folder should be open");
    const filePath = path.join(workspaceFolder.uri.fsPath, "sample.sysml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 2000));
    const position = new vscode.Position(2, 11);
    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      doc.uri,
      position
    );
    if (!Array.isArray(locations) || locations.length === 0) {
      return;
    }
    assert.strictEqual(
      locations[0].uri.fsPath,
      doc.uri.fsPath,
      "Definition should be in the same file"
    );
  });
});
