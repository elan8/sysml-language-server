"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LspModelProvider = void 0;
const logger_1 = require("../logger");
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
}
exports.LspModelProvider = LspModelProvider;
//# sourceMappingURL=lspModelProvider.js.map