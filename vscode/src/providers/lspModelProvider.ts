import type { CancellationToken } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { SysMLModelParams, SysMLModelResult } from "./sysmlModelTypes";

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
}

