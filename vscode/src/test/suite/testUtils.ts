import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export function getTestWorkspaceFolder(): vscode.WorkspaceFolder {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Workspace folder should be open");
  return workspaceFolder;
}

export function getFixtureUri(relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(getTestWorkspaceFolder().uri, relativePath);
}

export function getFixturePath(relativePath: string): string {
  return getFixtureUri(relativePath).fsPath;
}

export async function waitFor<T>(
  label: string,
  producer: () => PromiseLike<T | undefined>,
  isReady: (value: T | undefined) => boolean,
  timeoutMs = 15000,
  intervalMs = 250
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await producer();
    if (isReady(lastValue)) {
      return lastValue as T;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  assert.fail(
    `${label} did not become ready within ${timeoutMs}ms. Last value: ${JSON.stringify(lastValue)}`
  );
}

export async function configureServerForTests(): Promise<void> {
  const extension = vscode.extensions.all.find(
    (e) => e.packageJSON?.name === "sysml-language-server"
  );
  assert.ok(extension, "SysML Language Server extension should be installed");

  const binaryName =
    process.platform === "win32"
      ? "sysml-language-server.exe"
      : "sysml-language-server";
  const serverPath = path.resolve(
    extension.extensionPath,
    "..",
    "target",
    "debug",
    binaryName
  );
  assert.ok(
    fs.existsSync(serverPath),
    `Expected built server binary for tests at ${serverPath}. Run cargo build first.`
  );

  await vscode.workspace
    .getConfiguration("sysml-language-server")
    .update("serverPath", serverPath, vscode.ConfigurationTarget.Workspace);
  await extension.activate();
}

export async function waitForLanguageServerReady(
  doc: vscode.TextDocument,
  timeoutMs = 20000
): Promise<void> {
  await vscode.window.showTextDocument(doc);
  await waitFor(
    "language server ready",
    () =>
      vscode.commands.executeCommand<
        vscode.DocumentSymbol[] | vscode.SymbolInformation[]
      >(
        "vscode.executeDocumentSymbolProvider",
        doc.uri,
      ),
    (value) => Array.isArray(value) && value.length > 0,
    timeoutMs,
    300
  );
}
