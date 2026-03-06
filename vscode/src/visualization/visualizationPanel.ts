import * as vscode from "vscode";
import type { LspModelProvider } from "../providers/lspModelProvider";
import type { SysMLElementDTO } from "../providers/sysmlModelTypes";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class VisualizationPanel {
  static currentPanel: VisualizationPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly modelProvider: LspModelProvider
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      null,
      this.disposables
    );
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    modelProvider: LspModelProvider,
    focusPackageName?: string
  ): VisualizationPanel {
    if (VisualizationPanel.currentPanel) {
      VisualizationPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      VisualizationPanel.currentPanel.focusPackage = focusPackageName;
      VisualizationPanel.currentPanel.refresh();
      return VisualizationPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "sysmlVisualizer",
      "SysML Visualizer",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    VisualizationPanel.currentPanel = new VisualizationPanel(panel, modelProvider);
    VisualizationPanel.currentPanel.focusPackage = focusPackageName;
    VisualizationPanel.currentPanel.panel.webview.html =
      VisualizationPanel.currentPanel.renderHtml(extensionUri);
    VisualizationPanel.currentPanel.refresh();
    return VisualizationPanel.currentPanel;
  }

  focusPackage?: string;

  dispose(): void {
    VisualizationPanel.currentPanel = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  async refresh(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || (doc.languageId !== "sysml" && doc.languageId !== "kerml")) {
      this.panel.webview.postMessage({
        command: "setTree",
        title: "No active SysML/KerML document.",
        html: "",
        focusPackage: undefined,
      });
      return;
    }

    let elements: SysMLElementDTO[] = [];
    try {
      const res = await this.modelProvider.getModel(doc.uri.toString(), ["elements", "stats"]);
      elements = res.elements ?? [];
      const total = res.stats?.totalElements ?? elements.length;
      const focusPackage = this.focusPackage;
      this.panel.webview.postMessage({
        command: "setTree",
        title: `${doc.fileName.split(/[\\/]/).pop()} · ${total} element(s)`,
        html: this.renderTreeHtml(elements),
        focusPackage,
      });
    } catch (e) {
      this.panel.webview.postMessage({
        command: "setTree",
        title: "Failed to load model",
        html: `<div class="err">${escapeHtml(String(e))}</div>`,
        focusPackage: undefined,
      });
    }
  }

  private renderTreeHtml(elements: SysMLElementDTO[]): string {
    const renderNode = (el: SysMLElementDTO): string => {
      const name = el.name || "(anonymous)";
      const label = escapeHtml(name);
      const type = escapeHtml(el.type || "symbol");
      const payload = escapeHtml(JSON.stringify(el.range));
      const nameAttr = name.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      const children = (el.children ?? []).map(renderNode).join("");
      if (children) {
        return `
          <li data-name="${nameAttr}">
            <details open>
              <summary>
                <button class="jump" data-range="${payload}" title="Jump to source">⤴</button>
                <span class="name">${label}</span>
                <span class="type">${type}</span>
              </summary>
              <ul>${children}</ul>
            </details>
          </li>
        `;
      }
      return `
        <li data-name="${nameAttr}">
          <div class="leaf">
            <button class="jump" data-range="${payload}" title="Jump to source">⤴</button>
            <span class="name">${label}</span>
            <span class="type">${type}</span>
          </div>
        </li>
      `;
    };

    return `<ul class="tree">${elements.map(renderNode).join("")}</ul>`;
  }

  private async onMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.command !== "string") return;

    if (msg.command === "refresh") {
      await this.refresh();
      return;
    }

    if (msg.command === "jump" && msg.range) {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
      const r = msg.range as {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      const range = new vscode.Range(
        new vscode.Position(r.start.line, r.start.character),
        new vscode.Position(r.end.line, r.end.character)
      );
      const editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: false,
        preview: true,
      });
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  }

  private renderHtml(extensionUri: vscode.Uri): string {
    const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const csp = [
      "default-src 'none'",
      "img-src https: data:",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // extensionUri is currently unused (reserved for future assets)
    void extensionUri;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SysML Visualizer</title>
    <style>
      :root {
        --muted: color-mix(in srgb, var(--vscode-foreground) 65%, transparent);
        --border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
        --bg: var(--vscode-editor-background);
      }
      body {
        padding: 12px 14px;
        color: var(--vscode-foreground);
        background: var(--bg);
        font-family: var(--vscode-font-family);
        font-size: 13px;
      }
      header {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      h1 {
        font-size: 13px;
        margin: 0;
        font-weight: 600;
      }
      button {
        font-family: inherit;
        font-size: 12px;
      }
      .tree {
        list-style: none;
        padding-left: 0;
        margin: 0;
      }
      .tree ul {
        list-style: none;
        padding-left: 16px;
        margin: 4px 0 0 0;
      }
      summary {
        cursor: pointer;
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 2px 0;
      }
      summary::-webkit-details-marker { display: none; }
      details {
        border-left: 1px solid var(--border);
        padding-left: 10px;
        margin: 3px 0;
      }
      .leaf {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 2px 0;
      }
      .jump {
        border: 1px solid var(--border);
        background: transparent;
        color: var(--vscode-foreground);
        border-radius: 4px;
        padding: 1px 6px;
        cursor: pointer;
      }
      .jump:hover {
        background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      }
      .name { font-weight: 500; }
      .type {
        color: var(--muted);
        font-size: 12px;
      }
      .err {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 6px;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <header>
      <h1 id="title">Loading…</h1>
      <button id="refresh">Refresh</button>
    </header>
    <div id="root"></div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const root = document.getElementById('root');
      const title = document.getElementById('title');
      document.getElementById('refresh').addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.command !== 'setTree') return;
        title.textContent = msg.title || 'SysML Visualizer';
        root.innerHTML = msg.html || '';
        root.querySelectorAll('button.jump').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              const range = JSON.parse(btn.getAttribute('data-range'));
              vscode.postMessage({ command: 'jump', range });
            } catch {}
          });
        });
        if (msg.focusPackage) {
          const found = Array.from(root.querySelectorAll('li[data-name]')).find(
            (li) => li.getAttribute('data-name') === msg.focusPackage
          );
          if (found) found.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    </script>
  </body>
</html>`;
  }
}

