import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  configureServerForTests,
  waitFor,
  waitForLanguageServerReady,
} from "./testUtils";

describe("Extension Test Suite", () => {
  before(async function () {
    this.timeout(30000);
    await configureServerForTests();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "Workspace folder should be open");
    const filePath = path.join(workspaceFolder.uri.fsPath, "sample.sysml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    await waitForLanguageServerReady(doc);
  });

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
    const position = new vscode.Position(1, 2);
    const hovers = await waitFor(
      "hover provider response",
      () =>
        vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider",
          doc.uri,
          position
        ),
      (value) => Array.isArray(value) && value.length > 0
    );
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
    const position = new vscode.Position(2, 11);
    const locations = await waitFor(
      "definition provider response",
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          doc.uri,
          position
        ),
      (value) => Array.isArray(value) && value.length > 0
    );
    assert.strictEqual(
      locations[0].uri.fsPath,
      doc.uri.fsPath,
      "Definition should be in the same file"
    );
  });

  it("Server stays usable after invalid intermediate edits", async function () {
    this.timeout(20000);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "Workspace folder should be open");
    const filePath = path.join(workspaceFolder.uri.fsPath, "sample.sysml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    const invalidEditApplied = await editor.edit((editBuilder) => {
      editBuilder.delete(new vscode.Range(1, 12, 1, 13));
    });
    assert.ok(invalidEditApplied, "Expected invalid intermediate edit to apply");

    const diagnostics = await waitFor(
      "diagnostics after invalid edit",
      async () => vscode.languages.getDiagnostics(doc.uri),
      (value) => Array.isArray(value) && value.length > 0
    );
    assert.ok(diagnostics.length > 0, "Expected diagnostics after invalid intermediate edit");

    const hoverPosition = new vscode.Position(1, 2);
    const hovers = await waitFor(
      "hover after invalid edit",
      () =>
        vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider",
          doc.uri,
          hoverPosition
        ),
      (value) => Array.isArray(value) && value.length > 0
    );
    assert.ok(hovers.length > 0, "Server should still answer hover requests after invalid edits");

    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  it("Server recovers after manual restart", async function () {
    this.timeout(20000);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "Workspace folder should be open");
    const filePath = path.join(workspaceFolder.uri.fsPath, "sample.sysml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    await vscode.commands.executeCommand("sysml.restartServer");

    const hovers = await waitFor(
      "hover after manual restart",
      () =>
        vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider",
          doc.uri,
          new vscode.Position(1, 2)
        ),
      (value) => Array.isArray(value) && value.length > 0
    );
    assert.ok(hovers.length > 0, "Server should recover after manual restart");
  });
});
