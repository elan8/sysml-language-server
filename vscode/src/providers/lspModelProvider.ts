import type { CancellationToken } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
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
    const params: SysMLModelParams = {
      textDocument: { uri },
      scope: scopes,
    };
    return this.client.sendRequest<SysMLModelResult>("sysml/model", params, token);
  }

  async getServerStats(): Promise<SysMLServerStats | undefined> {
    try {
      return await this.client.sendRequest<SysMLServerStats>("sysml/serverStats");
    } catch {
      return undefined;
    }
  }

  async clearCache(): Promise<SysMLClearCacheResult | undefined> {
    try {
      return await this.client.sendRequest<SysMLClearCacheResult>("sysml/clearCache");
    } catch {
      return undefined;
    }
  }
}

