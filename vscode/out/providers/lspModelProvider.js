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
/** Convert LSP PositionDTO to vscode.Position. */
function toVscodePosition(p) {
    return new vscode.Position(p.line, p.character);
}
/** Convert LSP RangeDTO to vscode.Range. */
function toVscodeRange(r) {
    return new vscode.Range(toVscodePosition(r.start), toVscodePosition(r.end));
}
class LspModelProvider {
    constructor(client) {
        this.client = client;
    }
    async getModel(uri, scopes, token) {
        const trimmed = (uri || "").trim();
        if (!trimmed) {
            (0, logger_1.log)("getModel: empty URI, returning empty model");
            return {
                version: 0,
                elements: [],
                relationships: [],
            };
        }
        (0, logger_1.log)("getModel:", trimmed.slice(-60), "scopes:", scopes);
        const params = {
            textDocument: { uri: trimmed },
            scope: scopes,
        };
        try {
            const result = await this.client.sendRequest("sysml/model", params, token);
            (0, logger_1.log)("getModel result:", result.elements?.length ?? 0, "elements,", result.relationships?.length ?? 0, "relationships");
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
     * Find an element by name in the model. Performs a depth-first search
     * over elements returned by getModel.
     */
    async findElement(uri, elementName, parentContext, token) {
        const result = await this.getModel(uri, ["elements"], token);
        if (!result.elements) {
            return undefined;
        }
        if (parentContext) {
            const parent = this.findRecursive(parentContext, result.elements);
            if (parent?.children?.length) {
                const found = this.findRecursive(elementName, parent.children);
                if (found)
                    return found;
            }
        }
        return this.findRecursive(elementName, result.elements);
    }
    findRecursive(name, elements) {
        for (const el of elements) {
            if (el.name === name)
                return el;
            if (el.children?.length) {
                const found = this.findRecursive(name, el.children);
                if (found)
                    return found;
            }
        }
        return undefined;
    }
}
exports.LspModelProvider = LspModelProvider;
//# sourceMappingURL=lspModelProvider.js.map