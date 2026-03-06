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
exports.ModelExplorerProvider = exports.ModelTreeItem = exports.FileTreeItem = void 0;
exports.toVscodeRange = toVscodeRange;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../logger");
/** Helper to convert RangeDTO to vscode.Range for openLocation. */
function toVscodeRange(dto) {
    return new vscode.Range(new vscode.Position(dto.start.line, dto.start.character), new vscode.Position(dto.end.line, dto.end.character));
}
class FileTreeItem extends vscode.TreeItem {
    constructor(fileUri, childCount) {
        const fileName = fileUri.fsPath.split(/[/\\]/).pop() ?? fileUri.toString();
        super(fileName, vscode.TreeItemCollapsibleState.Collapsed);
        this.fileUri = fileUri;
        this.itemType = "file-node";
        this.tooltip = `${fileUri.fsPath} (${childCount} element(s))`;
        this.description = `${childCount} element(s)`;
        this.iconPath = new vscode.ThemeIcon("file");
        this.contextValue = "sysmlFile";
        this.resourceUri = fileUri;
        this.command = {
            command: "vscode.open",
            title: "Open File",
            arguments: [fileUri],
        };
    }
}
exports.FileTreeItem = FileTreeItem;
class ModelTreeItem extends vscode.TreeItem {
    constructor(element, uri) {
        const hasChildren = (element.children?.length ?? 0) > 0 ||
            (element.relationships?.length ?? 0) > 0 ||
            (element.attributes && Object.keys(element.attributes).length > 0);
        super(element.name || "(anonymous)", hasChildren
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        this.element = element;
        this.itemType = "sysml-element";
        this.elementUri = uri;
        this.resourceUri = uri;
        this.contextValue =
            element.type === "package" ? "sysmlPackage" : "sysmlElement";
        // Build label: name : Type [mult] when attributes available
        const partType = element.attributes?.partType;
        const portType = element.attributes?.portType;
        const typeName = partType ?? portType;
        const multiplicity = element.attributes?.multiplicity;
        let labelText = element.name || "(anonymous)";
        if (typeName)
            labelText += ` : ${typeName}`;
        if (multiplicity)
            labelText += ` [${multiplicity}]`;
        this.label = labelText;
        this.description = element.type;
        const tooltipParts = [`${element.type}: ${element.name || "(anonymous)"}`];
        if (typeName)
            tooltipParts.push(`Type: ${typeName}`);
        if (multiplicity)
            tooltipParts.push(`Multiplicity: [${multiplicity}]`);
        if (element.children?.length)
            tooltipParts.push(`Children: ${element.children.length}`);
        if (element.relationships?.length)
            tooltipParts.push(`Relationships: ${element.relationships.length}`);
        this.tooltip = tooltipParts.join("\n");
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
        this.workspaceMode = false;
        this.workspaceFileData = new Map();
        this.workspaceFileUris = [];
        this._workspaceViewMode = "bySemantic";
        this.uriToRootItems = new Map();
        this.namespaceTypes = new Set(["package"]);
    }
    setTreeView(treeView) {
        this.treeView = treeView;
    }
    isWorkspaceMode() {
        return this.workspaceMode;
    }
    getWorkspaceFileUris() {
        return this.workspaceFileUris;
    }
    getWorkspaceViewMode() {
        return this._workspaceViewMode;
    }
    setWorkspaceViewMode(mode) {
        (0, logger_1.log)("setWorkspaceViewMode:", mode);
        this._workspaceViewMode = mode;
        vscode.commands.executeCommand("setContext", "sysml.workspaceViewMode", this._workspaceViewMode);
        this._onDidChangeTreeData.fire();
    }
    toggleWorkspaceViewMode() {
        (0, logger_1.log)("toggleWorkspaceViewMode:", this._workspaceViewMode, "->", this._workspaceViewMode === "byFile" ? "bySemantic" : "byFile");
        this._workspaceViewMode =
            this._workspaceViewMode === "byFile" ? "bySemantic" : "byFile";
        vscode.commands.executeCommand("setContext", "sysml.workspaceViewMode", this._workspaceViewMode);
        this._onDidChangeTreeData.fire();
    }
    async revealActiveDocument(docUri) {
        if (!this.treeView)
            return;
        const items = this.uriToRootItems.get(docUri.toString());
        if (!items?.length)
            return;
        const seen = new Set();
        for (const item of items) {
            if (seen.has(item))
                continue;
            seen.add(item);
            try {
                await this.treeView.reveal(item, {
                    select: true,
                    focus: false,
                    expand: true,
                });
            }
            catch {
                // Ignore
            }
        }
    }
    clear() {
        this.lastUri = undefined;
        this.lastElements = undefined;
        this.workspaceMode = false;
        this.workspaceFileData.clear();
        this.workspaceFileUris = [];
        this.uriToRootItems.clear();
        this._onDidChangeTreeData.fire();
    }
    async loadWorkspaceModel(fileUris, token) {
        (0, logger_1.log)("loadWorkspaceModel:", fileUris.length, "files");
        this.workspaceMode = true;
        this.workspaceFileUris = fileUris;
        this.lastUri = undefined;
        this.lastElements = undefined;
        this.workspaceFileData.clear();
        this.uriToRootItems.clear();
        try {
            for (const uri of fileUris) {
                if (token?.isCancellationRequested)
                    break;
                try {
                    const result = await this.modelProvider.getModel(uri.toString(), ["elements", "relationships", "stats"], token);
                    if (result.elements?.length) {
                        (0, logger_1.log)("loadWorkspaceModel: loaded", uri.toString().slice(-50), "->", result.elements.length, "elements");
                        this.workspaceFileData.set(uri.toString(), {
                            uri,
                            elements: result.elements,
                        });
                    }
                }
                catch (e) {
                    (0, logger_1.log)("loadWorkspaceModel: skip file (failed):", uri.toString().slice(-50), e);
                }
            }
        }
        finally {
            (0, logger_1.log)("loadWorkspaceModel: done,", this.workspaceFileData.size, "files loaded");
            this._onDidChangeTreeData.fire();
        }
    }
    async loadDocument(document, token) {
        (0, logger_1.log)("loadDocument:", document.uri.toString().slice(-50));
        this.workspaceMode = false;
        this.workspaceFileData.clear();
        this.workspaceFileUris = [];
        this.lastUri = document.uri;
        try {
            const result = await this.modelProvider.getModel(document.uri.toString(), ["elements", "relationships", "stats"], token);
            this.lastElements = result.elements ?? [];
            (0, logger_1.log)("loadDocument: done,", this.lastElements.length, "elements");
        }
        finally {
            this._onDidChangeTreeData.fire();
        }
    }
    refresh() {
        (0, logger_1.log)("refresh: workspaceMode=", this.workspaceMode, "fileCount=", this.workspaceFileUris.length);
        if (this.workspaceMode && this.workspaceFileUris.length > 0) {
            this.loadWorkspaceModel(this.workspaceFileUris);
        }
        else if (this.lastUri) {
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.lastUri.toString());
            if (doc && (doc.languageId === "sysml" || doc.languageId === "kerml")) {
                this.loadDocument(doc);
            }
            else {
                this._onDidChangeTreeData.fire();
            }
        }
        else {
            const active = vscode.window.activeTextEditor?.document;
            if (active && (active.languageId === "sysml" || active.languageId === "kerml")) {
                this.loadDocument(active);
            }
            else {
                this._onDidChangeTreeData.fire();
            }
        }
    }
    getAllElements() {
        if (this.workspaceMode) {
            return Array.from(this.workspaceFileData.values()).flatMap((d) => d.elements);
        }
        return this.lastElements ?? [];
    }
    getLastUri() {
        return this.lastUri;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (!element) {
            if (this.workspaceMode && this.workspaceFileData.size > 0) {
                if (this._workspaceViewMode === "byFile") {
                    const items = Array.from(this.workspaceFileData.entries()).map(([, data]) => new FileTreeItem(data.uri, data.elements.length));
                    this.uriToRootItems.clear();
                    for (const item of items) {
                        this.uriToRootItems.set(item.fileUri.toString(), [item]);
                    }
                    return items;
                }
                const entries = Array.from(this.workspaceFileData.entries());
                const items = this.mergeNamespaceElements(entries);
                this.buildSemanticUriMapping(items);
                return items;
            }
            if (!this.lastUri && !this.workspaceMode) {
                const active = vscode.window.activeTextEditor?.document;
                if (active &&
                    (active.languageId === "sysml" || active.languageId === "kerml")) {
                    const result = await this.modelProvider.getModel(active.uri.toString(), ["elements", "stats"]);
                    this.lastUri = active.uri;
                    this.lastElements = result.elements ?? [];
                }
                else {
                    return [];
                }
            }
            if (this.lastUri && this.lastElements) {
                const merged = this.mergeElements(this.lastElements);
                const items = merged.map((e) => new ModelTreeItem(e, this.lastUri));
                this.uriToRootItems.clear();
                this.uriToRootItems.set(this.lastUri.toString(), items);
                return items;
            }
            return [];
        }
        if (element.itemType === "file-node") {
            const data = this.workspaceFileData.get(element.fileUri.toString());
            if (!data)
                return [];
            return data.elements.map((e) => new ModelTreeItem(e, data.uri));
        }
        const children = [];
        const el = element.element;
        const childElements = el.children ?? [];
        for (const c of childElements) {
            children.push(new ModelTreeItem(c, element.elementUri));
        }
        return children;
    }
    mergeNamespaceElements(entries) {
        const pairs = [];
        for (const [, data] of entries) {
            for (const el of data.elements) {
                pairs.push({ el, uri: data.uri });
            }
        }
        const mergedMap = new Map();
        const result = [];
        for (const { el, uri } of pairs) {
            const key = `${el.type}::${el.name || "(anonymous)"}`;
            if (this.namespaceTypes.has(el.type) && mergedMap.has(key)) {
                const existing = mergedMap.get(key);
                existing.merged = this.mergeTwo(existing.merged, el);
            }
            else if (this.namespaceTypes.has(el.type)) {
                const clone = this.cloneElement(el);
                mergedMap.set(key, { merged: clone, uri });
                result.push(new ModelTreeItem(clone, uri));
            }
            else {
                result.push(new ModelTreeItem(el, uri));
            }
        }
        return result;
    }
    buildSemanticUriMapping(rootItems) {
        this.uriToRootItems.clear();
        for (const [uriStr, data] of this.workspaceFileData) {
            const matching = [];
            for (const el of data.elements) {
                const key = `${el.type}::${el.name || "(anonymous)"}`;
                const match = rootItems.find((item) => `${item.element.type}::${item.element.name || "(anonymous)"}` === key);
                if (match && !matching.includes(match)) {
                    matching.push(match);
                }
            }
            if (matching.length > 0) {
                this.uriToRootItems.set(uriStr, matching);
            }
        }
    }
    mergeElements(elements) {
        const mergedMap = new Map();
        const result = [];
        for (const el of elements) {
            const key = `${el.type}::${el.name || "(anonymous)"}`;
            if (this.namespaceTypes.has(el.type) && mergedMap.has(key)) {
                const existing = mergedMap.get(key);
                const merged = this.mergeTwo(existing, el);
                const idx = result.indexOf(existing);
                if (idx !== -1)
                    result[idx] = merged;
                mergedMap.set(key, merged);
            }
            else if (this.namespaceTypes.has(el.type)) {
                const clone = this.cloneElement(el);
                mergedMap.set(key, clone);
                result.push(clone);
            }
            else {
                result.push(el);
            }
        }
        return result;
    }
    mergeTwo(a, b) {
        const childMap = new Map();
        for (const c of a.children ?? []) {
            const ck = `${c.type}::${c.name || "(anonymous)"}`;
            childMap.set(ck, c);
        }
        for (const child of b.children ?? []) {
            const ck = `${child.type}::${child.name || "(anonymous)"}`;
            const existing = childMap.get(ck);
            if (existing && this.namespaceTypes.has(child.type)) {
                childMap.set(ck, this.mergeTwo(existing, child));
            }
            else if (!existing) {
                childMap.set(ck, child);
            }
        }
        const children = Array.from(childMap.values());
        const attrs = { ...(a.attributes ?? {}), ...(b.attributes ?? {}) };
        const relKeys = new Set((a.relationships ?? []).map((r) => `${r.type}::${r.source}::${r.target}`));
        const relationships = [...(a.relationships ?? [])];
        for (const rel of b.relationships ?? []) {
            const rk = `${rel.type}::${rel.source}::${rel.target}`;
            if (!relKeys.has(rk)) {
                relationships.push(rel);
                relKeys.add(rk);
            }
        }
        return {
            ...a,
            children,
            attributes: attrs,
            relationships,
        };
    }
    cloneElement(el) {
        return {
            type: el.type,
            name: el.name,
            range: el.range,
            children: (el.children ?? []).map((c) => this.cloneElement(c)),
            attributes: el.attributes ? { ...el.attributes } : {},
            relationships: [...(el.relationships ?? [])],
            errors: el.errors ? [...el.errors] : undefined,
        };
    }
}
exports.ModelExplorerProvider = ModelExplorerProvider;
//# sourceMappingURL=modelExplorerProvider.js.map