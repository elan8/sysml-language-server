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
exports.LspModelProvider = void 0;
exports.toVscodeRange = toVscodeRange;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../logger");
/** Convert GraphNodeDTO to SysMLElementDTO for findElement compatibility. */
function graphNodeToElementDTO(node, graph) {
    const children = (graph.nodes || []).filter((n) => n.parentId === node.id);
    const childDTOs = children.map((c) => graphNodeToElementDTO(c, graph));
    const edgeType = (e) => e.type || e.rel_type || '';
    const relationships = (graph.edges || [])
        .filter((e) => e.source === node.id && edgeType(e).toLowerCase() !== 'contains')
        .map((e) => ({ source: e.source, target: e.target, type: edgeType(e), name: e.name }));
    return {
        type: node.type,
        name: node.name,
        range: node.range,
        children: childDTOs,
        attributes: node.attributes || {},
        relationships,
    };
}
/** Convert LSP PositionDTO to vscode.Position. */
function toVscodePosition(p) {
    return new vscode.Position(p.line, p.character);
}
/** Convert LSP RangeDTO to vscode.Range. */
function toVscodeRange(r) {
    return new vscode.Range(toVscodePosition(r.start), toVscodePosition(r.end));
}
class LspModelProvider {
    constructor(client, 
    /** Resolves when the LSP client is ready. Prevents getModel before didOpen is processed. */
    whenReady = Promise.resolve()) {
        this.client = client;
        this.whenReady = whenReady;
    }
    async getModel(uri, scopes, token) {
        const trimmed = (uri || "").trim();
        if (!trimmed) {
            (0, logger_1.log)("getModel: empty URI, returning empty model");
            return {
                version: 0,
                graph: { nodes: [], edges: [] },
            };
        }
        (0, logger_1.log)("getModel:", trimmed.slice(-60), "scopes:", scopes);
        await this.whenReady;
        const params = {
            textDocument: { uri: trimmed },
            scope: scopes,
        };
        const doRequest = () => this.client.sendRequest("sysml/model", params, token);
        try {
            let result = await doRequest();
            const nodeCount = result.graph?.nodes?.length ?? 0;
            const edgeCount = result.graph?.edges?.length ?? 0;
            // Retry once if empty: server may not have processed didOpen yet
            if (nodeCount === 0 && edgeCount === 0 && scopes?.includes("graph")) {
                (0, logger_1.log)("getModel: 0 nodes/edges, retrying after 300ms (didOpen may not be processed yet)");
                await new Promise((r) => setTimeout(r, 300));
                result = await doRequest();
            }
            (0, logger_1.log)("getModel result:", result.graph?.nodes?.length ?? 0, "nodes,", result.graph?.edges?.length ?? 0, "edges");
            return result;
        }
        catch (e) {
            (0, logger_1.logError)("getModel failed", e);
            throw e;
        }
    }
    async getServerStats() {
        try {
            return await this.client.sendRequest("sysml/serverStats");
        }
        catch (e) {
            (0, logger_1.log)("getServerStats failed", e);
            return undefined;
        }
    }
    async clearCache() {
        try {
            return await this.client.sendRequest("sysml/clearCache");
        }
        catch (e) {
            (0, logger_1.log)("clearCache failed", e);
            return undefined;
        }
    }
    /**
     * Find an element by name in the model. Searches graph.nodes and optionally
     * scopes by parentContext (qualified name or name of parent).
     */
    async findElement(uri, elementName, parentContext, token) {
        const result = await this.getModel(uri, ["graph"], token);
        if (!result.graph?.nodes?.length) {
            return undefined;
        }
        const nodes = result.graph.nodes;
        const byName = new Map();
        for (const n of nodes) {
            const key = (n.name || "").toLowerCase();
            if (!byName.has(key))
                byName.set(key, []);
            byName.get(key).push(n);
        }
        const candidates = byName.get(elementName.toLowerCase()) ?? [];
        if (parentContext) {
            const parentKey = parentContext.toLowerCase();
            const parentIds = new Set(nodes.filter((n) => (n.name || "").toLowerCase() === parentKey || (n.id || "").toLowerCase() === parentKey).map((n) => n.id));
            const scoped = candidates.filter((c) => c.parentId && parentIds.has(c.parentId));
            if (scoped.length > 0) {
                return graphNodeToElementDTO(scoped[0], result.graph);
            }
        }
        if (candidates.length > 0) {
            return graphNodeToElementDTO(candidates[0], result.graph);
        }
        return undefined;
    }
}
exports.LspModelProvider = LspModelProvider;
//# sourceMappingURL=lspModelProvider.js.map