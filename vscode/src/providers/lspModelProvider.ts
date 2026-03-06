import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { log, logError } from "../logger";
import type {
  PositionDTO,
  SysMLElementDTO,
  SysMLModelParams,
  SysMLModelResult,
} from "./sysmlModelTypes";

/** Convert LSP PositionDTO to vscode.Position. */
function toVscodePosition(p: PositionDTO): vscode.Position {
  return new vscode.Position(p.line, p.character);
}

/** Convert LSP RangeDTO to vscode.Range. */
export function toVscodeRange(r: { start: PositionDTO; end: PositionDTO }): vscode.Range {
  return new vscode.Range(toVscodePosition(r.start), toVscodePosition(r.end));
}

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
    token?: vscode.CancellationToken
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

  /**
   * Find an element by name in the model. Performs a depth-first search
   * over elements returned by getModel.
   */
  async findElement(
    uri: string,
    elementName: string,
    parentContext?: string,
    token?: vscode.CancellationToken
  ): Promise<SysMLElementDTO | undefined> {
    const result = await this.getModel(uri, ["elements"], token);
    if (!result.elements) {
      return undefined;
    }
    if (parentContext) {
      const parent = this.findRecursive(parentContext, result.elements);
      if (parent?.children?.length) {
        const found = this.findRecursive(elementName, parent.children);
        if (found) return found;
      }
    }
    return this.findRecursive(elementName, result.elements);
  }

  private findRecursive(name: string, elements: SysMLElementDTO[]): SysMLElementDTO | undefined {
    for (const el of elements) {
      if (el.name === name) return el;
      if (el.children?.length) {
        const found = this.findRecursive(name, el.children);
        if (found) return found;
      }
    }
    return undefined;
  }
}

