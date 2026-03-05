import * as fs from "fs";
import * as path from "path";
import type { ExtensionContext } from "vscode";
import { workspace } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function getBundledServerCommand(extensionPath: string): string {
  const platform = process.platform;
  const arch = process.arch;
  const binaryName =
    platform === "win32" ? "sysml-language-server.exe" : "sysml-language-server";
  const bundledPath = path.join(
    extensionPath,
    "server",
    `${platform}-${arch}`,
    binaryName
  );
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }
  return "sysml-language-server";
}

export function activate(context: ExtensionContext): void {
  const config = workspace.getConfiguration("sysml-language-server");
  const serverPath = config.get<string>("serverPath") ?? "sysml-language-server";
  const libraryPathsRaw = config.get<string[]>("libraryPaths") ?? [];
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const libraryPaths = libraryPathsRaw.map((p) =>
    path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p)
  );

  let serverCommand: string;
  if (serverPath === "sysml-language-server") {
    serverCommand = getBundledServerCommand(context.extensionPath);
  } else if (path.isAbsolute(serverPath)) {
    serverCommand = serverPath;
  } else {
    serverCommand = path.resolve(workspaceRoot, serverPath);
  }

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
    initializationOptions: {
      libraryPaths,
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
