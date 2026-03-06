import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { LspModelProvider } from "./providers/lspModelProvider";
import { ModelExplorerProvider, ModelTreeItem } from "./explorer/modelExplorerProvider";
import { VisualizationPanel } from "./visualization/visualizationPanel";

let client: LanguageClient | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let modelExplorerProvider: ModelExplorerProvider | undefined;

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

function isSysmlDoc(doc: vscode.TextDocument | undefined): boolean {
  if (!doc) return false;
  return doc.languageId === "sysml" || doc.languageId === "kerml";
}

function ensureStatusItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusItem.name = "SysML Diagnostics";
    statusItem.command = "workbench.actions.view.problems";
    context.subscriptions.push(statusItem);
  }
  return statusItem;
}

function updateStatusBar(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("sysml-language-server");
  const enabled = cfg.get<boolean>("statusBar.enabled", true);
  if (!enabled) {
    statusItem?.hide();
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc || !isSysmlDoc(doc)) {
    statusItem?.hide();
    return;
  }

  const item = ensureStatusItem(context);
  const diags = vscode.languages.getDiagnostics(doc.uri);
  const errors = diags.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Error
  ).length;
  const warnings = diags.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Warning
  ).length;
  const icon = errors > 0 ? "$(error)" : warnings > 0 ? "$(warning)" : "$(check)";
  item.text = `${icon} SysML: ${errors}E ${warnings}W`;
  item.tooltip = `${errors} error(s), ${warnings} warning(s)\nClick to open Problems panel.`;
  item.show();
}

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("sysml-language-server");
  const serverPath = config.get<string>("serverPath") ?? "sysml-language-server";
  const libraryPathsRaw = config.get<string[]>("libraryPaths") ?? [];
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
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
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{sysml,kerml}"),
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
  // Avoid unhandled promise rejections when the server binary isn't available
  // (common in dev/test environments).
  const maybeOnReady = (client as unknown as { onReady?: () => Promise<unknown> }).onReady;
  if (typeof maybeOnReady === "function") {
    maybeOnReady().catch(() => {
      // Intentionally swallow; tests already handle missing server gracefully.
    });
  }

  // Model Explorer (phase 3)
  const lspModelProvider = new LspModelProvider(client);
  modelExplorerProvider = new ModelExplorerProvider(lspModelProvider);
  const treeView = vscode.window.createTreeView("sysmlModelExplorer", {
    treeDataProvider: modelExplorerProvider,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.refreshModelTree", () => {
      modelExplorerProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.openLocation", async (item: ModelTreeItem) => {
      const dtoRange = item.element.range;
      const range = new vscode.Range(
        new vscode.Position(dtoRange.start.line, dtoRange.start.character),
        new vscode.Position(dtoRange.end.line, dtoRange.end.character)
      );
      const doc = await vscode.workspace.openTextDocument(item.uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: false,
        preview: true,
      });
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    })
  );

  // Commands (quick wins)
  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.formatDocument", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!isSysmlDoc(editor?.document)) {
        vscode.window.showWarningMessage("No SysML/KerML document is active.");
        return;
      }
      await vscode.commands.executeCommand("editor.action.formatDocument");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.validateModel", async () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      if (!doc || !isSysmlDoc(doc)) {
        vscode.window.showWarningMessage("No SysML/KerML document is active.");
        return;
      }
      const diags = vscode.languages.getDiagnostics(doc.uri);
      const errors = diags.filter(
        (d) => d.severity === vscode.DiagnosticSeverity.Error
      ).length;
      const warnings = diags.filter(
        (d) => d.severity === vscode.DiagnosticSeverity.Warning
      ).length;
      vscode.window.showInformationMessage(
        `Validation: ${errors} error(s), ${warnings} warning(s).`
      );
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.restartServer", async () => {
      if (!client) {
        vscode.window.showErrorMessage("SysML language server is not running.");
        return;
      }
      try {
        await client.stop();
        client.start();
        vscode.window.showInformationMessage("SysML language server restarted.");
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to restart server: ${e}`);
      }
    })
  );

  // Placeholder commands for later phases (so palette entries don't fail).
  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.showModelExplorer", async () => {
      await vscode.commands.executeCommand("workbench.view.explorer");
      await vscode.commands.executeCommand(
        "setContext",
        "sysml.modelLoaded",
        isSysmlDoc(vscode.window.activeTextEditor?.document)
      );
      await vscode.commands.executeCommand("sysmlModelExplorer.focus");
      modelExplorerProvider?.refresh();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.showVisualizer", async () => {
      if (!client) {
        vscode.window.showErrorMessage("SysML language server is not running.");
        return;
      }
      // Reuse the same LSP model provider as the explorer.
      const provider = new LspModelProvider(client);
      VisualizationPanel.createOrShow(context.extensionUri, provider);
    })
  );

  // Status bar + context for contributed view
  const refreshContext = () => {
    const active = vscode.window.activeTextEditor?.document;
    const loaded = isSysmlDoc(active);
    vscode.commands.executeCommand("setContext", "sysml.modelLoaded", loaded);
    updateStatusBar(context);
  };

  refreshContext();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshContext())
  );
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => updateStatusBar(context))
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
