import type { CancellationToken } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { log, logError } from "../logger";
import type { SysMLModelParams, SysMLModelResult } from "./sysmlModelTypes";

export interface SysMLServerStats {
  uptime: number;
  memory: { rss: number };
  caches: { documents: number; symbolTables: number; semanticTokens: number };
}

export interface SysMLClearCacheResult {
  documents: number;
  symbolTables: number;
  semanticTokens: number;
}

export class LspModelProvider {
  constructor(private readonly client: LanguageClient) {}

  async getModel(
    uri: string,
    scopes?: SysMLModelParams["scope"],
    token?: CancellationToken
  ): Promise<SysMLModelResult> {
    const trimmed = (uri || "").trim();
    if (!trimmed) {
      log("getModel: empty URI, returning empty model");
      return {
        version: 0,
        elements: [],
        relationships: [],
      };
    }
    log("getModel:", trimmed.slice(-60), "scopes:", scopes);
    const params: SysMLModelParams = {
      textDocument: { uri: trimmed },
      scope: scopes,
    };
    try {
      const result = await this.client.sendRequest<SysMLModelResult>("sysml/model", params, token);
      log("getModel result:", result.elements?.length ?? 0, "elements,", result.relationships?.length ?? 0, "relationships");
      return result;
    } catch (e) {
      logError("getModel failed", e);
      throw e;
    }
  }

  async getServerStats(): Promise<SysMLServerStats | undefined> {
    try {
      return await this.client.sendRequest<SysMLServerStats>("sysml/serverStats");
    } catch (e) {
      log("getServerStats failed", e);
      return undefined;
    }
  }

  async clearCache(): Promise<SysMLClearCacheResult | undefined> {
    try {
      return await this.client.sendRequest<SysMLClearCacheResult>("sysml/clearCache");
    } catch (e) {
      log("clearCache failed", e);
      return undefined;
    }
  }
}

