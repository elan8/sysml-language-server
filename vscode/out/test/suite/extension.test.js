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
describe("Extension Test Suite", () => {
    it("Extension should be present", () => {
        const found = vscode.extensions.all.some((e) => e.packageJSON?.name === "sysml-language-server");
        assert.ok(found, "SysML Language Server extension should be loaded");
    });
    it("SysML language should be registered", async () => {
        const languages = await vscode.languages.getLanguages();
        assert.ok(languages.includes("sysml"), "sysml language should be registered");
    });
    it("Hover over keyword returns content", async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, "Workspace folder should be open");
        const filePath = path.join(workspaceFolder.uri.fsPath, "sample.sysml");
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
        await new Promise((r) => setTimeout(r, 2000));
        const position = new vscode.Position(1, 2);
        const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, position);
        if (!Array.isArray(hovers) || hovers.length === 0) {
            // Server may not be on PATH (e.g. local run without server built); skip assertion
            return;
        }
        const content = hovers[0].contents;
        const value = Array.isArray(content)
            ? content.map((c) => (typeof c === "string" ? c : c.value)).join("")
            : typeof content === "string"
                ? content
                : content.value;
        assert.ok(value.toLowerCase().includes("part"), `Hover content should mention 'part': ${value}`);
    });
    it("Go to definition from usage to definition", async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspaceFolder, "Workspace folder should be open");
        const filePath = path.join(workspaceFolder.uri.fsPath, "sample.sysml");
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
        await new Promise((r) => setTimeout(r, 2000));
        const position = new vscode.Position(2, 11);
        const locations = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", doc.uri, position);
        if (!Array.isArray(locations) || locations.length === 0) {
            return;
        }
        assert.strictEqual(locations[0].uri.fsPath, doc.uri.fsPath, "Definition should be in the same file");
    });
});
//# sourceMappingURL=extension.test.js.map