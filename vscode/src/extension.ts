import * as path from "path";
import { workspace } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(): void {
  const config = workspace.getConfiguration("sysml-language-server");
  const serverPath = config.get<string>("serverPath") ?? "sysml-language-server";

  const serverCommand =
    serverPath === "sysml-language-server"
      ? serverPath
      : path.isAbsolute(serverPath)
        ? serverPath
        : path.resolve(workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", serverPath);

  const serverOptions: ServerOptions = {
    command: serverCommand,
    args: [],
    transport: TransportKind.stdio,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: "sysml" },
      { language: "kerml" },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.{sysml,kerml}"),
    },
  };

  client = new LanguageClient(
    "sysmlLanguageServer",
    "SysML Language Server",
    serverOptions,
    clientOptions
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
