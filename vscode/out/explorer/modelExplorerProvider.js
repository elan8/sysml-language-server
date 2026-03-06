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
exports.ModelExplorerProvider = exports.ModelTreeItem = void 0;
const vscode = __importStar(require("vscode"));
class ModelTreeItem extends vscode.TreeItem {
    constructor(element, uri) {
        super(element.name || "(anonymous)", element.children?.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        this.element = element;
        this.uri = uri;
        this.contextValue =
            element.type === "package" ? "sysmlPackage" : "sysmlElement";
        this.description = element.type;
        this.tooltip = `${element.type}: ${element.name}`;
        this.command = {
            command: "sysml.openLocation",
            title: "Open Location",
            arguments: [this],
        };
    }
}
exports.ModelTreeItem = ModelTreeItem;
class ModelExplorerProvider {
    constructor(modelProvider) {
        this.modelProvider = modelProvider;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    async getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        const active = vscode.window.activeTextEditor?.document;
        if (!active || (active.languageId !== "sysml" && active.languageId !== "kerml")) {
            this.lastUri = undefined;
            this.lastElements = undefined;
            return [];
        }
        const uri = active.uri;
        if (!element) {
            // Root
            if (!this.lastUri || this.lastUri.toString() !== uri.toString()) {
                this.lastUri = uri;
                const res = await this.modelProvider.getModel(uri.toString(), ["elements", "stats"]);
                this.lastElements = res.elements ?? [];
            }
            return (this.lastElements ?? []).map((e) => new ModelTreeItem(e, uri));
        }
        // Children
        return (element.element.children ?? []).map((c) => new ModelTreeItem(c, uri));
    }
    getLastUri() {
        return this.lastUri;
    }
}
exports.ModelExplorerProvider = ModelExplorerProvider;
//# sourceMappingURL=modelExplorerProvider.js.map