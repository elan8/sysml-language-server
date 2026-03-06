"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LspModelProvider = void 0;
class LspModelProvider {
    constructor(client) {
        this.client = client;
    }
    async getModel(uri, scopes, token) {
        const params = {
            textDocument: { uri },
            scope: scopes,
        };
        return this.client.sendRequest("sysml/model", params, token);
    }
    async getServerStats() {
        try {
            return await this.client.sendRequest("sysml/serverStats");
        }
        catch {
            return undefined;
        }
    }
    async clearCache() {
        try {
            return await this.client.sendRequest("sysml/clearCache");
        }
        catch {
            return undefined;
        }
    }
}
exports.LspModelProvider = LspModelProvider;
//# sourceMappingURL=lspModelProvider.js.map