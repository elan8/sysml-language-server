import * as vscode from "vscode";
import type { LspModelProvider } from "../providers/lspModelProvider";
import type { SysMLElementDTO } from "../providers/sysmlModelTypes";

export class ModelTreeItem extends vscode.TreeItem {
  constructor(
    public readonly element: SysMLElementDTO,
    public readonly uri: vscode.Uri
  ) {
    super(
      element.name || "(anonymous)",
      element.children?.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.contextValue = "sysmlElement";
    this.description = element.type;
    this.tooltip = `${element.type}: ${element.name}`;
    this.command = {
      command: "sysml.openLocation",
      title: "Open Location",
      arguments: [this],
    };
  }
}

export class ModelExplorerProvider
  implements vscode.TreeDataProvider<ModelTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ModelTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private lastUri: vscode.Uri | undefined;
  private lastElements: SysMLElementDTO[] | undefined;

  constructor(private readonly modelProvider: LspModelProvider) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getTreeItem(element: ModelTreeItem): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: ModelTreeItem): Promise<ModelTreeItem[]> {
    const active = vscode.window.activeTextEditor?.document;
    if (!active || (active.languageId !== "sysml" && active.languageId !== "kerml")) {
      this.lastUri = undefined;
      this.lastElements = undefined;
      return [];
    }

    const uri = active.uri;

    if (!element) {
      // Root
      if (!this.lastUri || this.lastUri.toString() !== uri.toString()) {
        this.lastUri = uri;
        const res = await this.modelProvider.getModel(uri.toString(), ["elements", "stats"]);
        this.lastElements = res.elements ?? [];
      }
      return (this.lastElements ?? []).map((e) => new ModelTreeItem(e, uri));
    }

    // Children
    return (element.element.children ?? []).map((c) => new ModelTreeItem(c, uri));
  }

  getLastUri(): vscode.Uri | undefined {
    return this.lastUri;
  }
}

