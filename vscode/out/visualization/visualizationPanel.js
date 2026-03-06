"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VisualizationPanel = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../logger");
const VIEW_OPTIONS = [
    { value: "tree", label: "Tree" },
    { value: "package", label: "Package" },
    { value: "ibd", label: "IBD" },
    { value: "graph", label: "Graph" },
];
function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
class VisualizationPanel {
    constructor(panel, modelProvider) {
        this.modelProvider = modelProvider;
        this.disposables = [];
        this.currentView = "tree";
        this.workspaceFileUris = [];
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    }
    static createOrShow(extensionUri, modelProvider, focusPackageName, workspaceFileUris) {
        (0, logger_1.log)("VisualizationPanel.createOrShow", "focusPackage:", focusPackageName, "files:", workspaceFileUris?.length ?? 0);
        if (VisualizationPanel.currentPanel) {
            VisualizationPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
            VisualizationPanel.currentPanel.focusPackage = focusPackageName;
            VisualizationPanel.currentPanel.workspaceFileUris = workspaceFileUris ?? [];
            VisualizationPanel.currentPanel.refresh();
            return VisualizationPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel("sysmlVisualizer", "SysML Visualizer", vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        VisualizationPanel.currentPanel = new VisualizationPanel(panel, modelProvider);
        VisualizationPanel.currentPanel.focusPackage = focusPackageName;
        VisualizationPanel.currentPanel.workspaceFileUris = workspaceFileUris ?? [];
        VisualizationPanel.currentPanel.panel.webview.html =
            VisualizationPanel.currentPanel.renderHtml(extensionUri);
        VisualizationPanel.currentPanel.refresh();
        return VisualizationPanel.currentPanel;
    }
    dispose() {
        VisualizationPanel.currentPanel = undefined;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
    async refresh() {
        (0, logger_1.log)("VisualizationPanel.refresh", "workspaceFiles:", this.workspaceFileUris.length);
        if (this.workspaceFileUris.length > 0) {
            await this.refreshFromWorkspaceUris();
            return;
        }
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || (doc.languageId !== "sysml" && doc.languageId !== "kerml")) {
            (0, logger_1.log)("VisualizationPanel.refresh: no active SysML/KerML doc");
            this.panel.webview.postMessage({
                command: "setModel",
                title: "No active SysML/KerML document.",
                view: "tree",
                elements: [],
                relationships: [],
                html: "",
                focusPackage: undefined,
            });
            return;
        }
        let elements = [];
        let relationships = [];
        try {
            const res = await this.modelProvider.getModel(doc.uri.toString(), [
                "elements",
                "relationships",
                "stats",
            ]);
            elements = res.elements ?? [];
            relationships = res.relationships ?? [];
            const total = res.stats?.totalElements ?? elements.length;
            const focusPackage = this.focusPackage;
            const view = this.currentView ?? "tree";
            this.panel.webview.postMessage({
                command: "setModel",
                title: `${doc.fileName.split(/[\\/]/).pop()} · ${total} element(s)`,
                view,
                elements,
                relationships,
                html: this.renderTreeHtml(elements),
                focusPackage,
            });
            (0, logger_1.log)("VisualizationPanel.refresh: sent model", elements.length, "elements,", relationships.length, "relationships");
        }
        catch (e) {
            (0, logger_1.logError)("VisualizationPanel.refresh failed", e);
            this.panel.webview.postMessage({
                command: "setModel",
                title: "Failed to load model",
                view: "tree",
                elements: [],
                relationships: [],
                html: `<div class="err">${escapeHtml(String(e))}</div>`,
                focusPackage: undefined,
            });
        }
    }
    async refreshFromWorkspaceUris() {
        const uris = this.workspaceFileUris;
        (0, logger_1.log)("VisualizationPanel.refreshFromWorkspaceUris:", uris.length, "files");
        const allElements = [];
        const allRelationships = [];
        const relKeys = new Set();
        try {
            const results = await Promise.all(uris.map((uri) => this.modelProvider.getModel(uri.toString(), [
                "elements",
                "relationships",
                "stats",
            ])));
            for (const res of results) {
                for (const el of res.elements ?? []) {
                    allElements.push(el);
                }
                for (const rel of res.relationships ?? []) {
                    const key = `${rel.type}::${rel.source}::${rel.target}`;
                    if (!relKeys.has(key)) {
                        relKeys.add(key);
                        allRelationships.push(rel);
                    }
                }
            }
            const merged = this.mergeNamespaceElements(allElements);
            const total = this.countElements(merged);
            const view = this.currentView ?? "tree";
            const focusPackage = this.focusPackage;
            const title = uris.length === 1
                ? `${uris[0].path.split(/[\\/]/).pop()} · ${total} element(s)`
                : `Folder (${uris.length} files) · ${total} element(s)`;
            this.panel.webview.postMessage({
                command: "setModel",
                title,
                view,
                elements: merged,
                relationships: allRelationships,
                html: this.renderTreeHtml(merged),
                focusPackage,
            });
            (0, logger_1.log)("VisualizationPanel.refreshFromWorkspaceUris: sent", merged.length, "merged elements");
        }
        catch (e) {
            (0, logger_1.logError)("VisualizationPanel.refreshFromWorkspaceUris failed", e);
            this.panel.webview.postMessage({
                command: "setModel",
                title: "Failed to load folder model",
                view: "tree",
                elements: [],
                relationships: [],
                html: `<div class="err">${escapeHtml(String(e))}</div>`,
                focusPackage: undefined,
            });
        }
    }
    mergeNamespaceElements(elements) {
        const namespaceTypes = new Set(["package"]);
        const mergedMap = new Map();
        const result = [];
        for (const el of elements) {
            const key = `${el.type}::${el.name || "(anonymous)"}`;
            if (namespaceTypes.has(el.type) && mergedMap.has(key)) {
                const existing = mergedMap.get(key);
                mergedMap.set(key, this.mergeTwo(existing, el));
                const idx = result.indexOf(existing);
                if (idx !== -1)
                    result[idx] = mergedMap.get(key);
            }
            else if (namespaceTypes.has(el.type)) {
                const clone = this.cloneElement(el);
                mergedMap.set(key, clone);
                result.push(clone);
            }
            else {
                result.push(el);
            }
        }
        return result;
    }
    mergeTwo(a, b) {
        const childMap = new Map();
        for (const c of a.children ?? []) {
            const ck = `${c.type}::${c.name || "(anonymous)"}`;
            childMap.set(ck, c);
        }
        for (const child of b.children ?? []) {
            const ck = `${child.type}::${child.name || "(anonymous)"}`;
            const existing = childMap.get(ck);
            if (existing && (existing.type === "package" || existing.type === "library")) {
                childMap.set(ck, this.mergeTwo(existing, child));
            }
            else if (!existing) {
                childMap.set(ck, child);
            }
        }
        return {
            ...a,
            children: Array.from(childMap.values()),
            attributes: { ...(a.attributes ?? {}), ...(b.attributes ?? {}) },
            relationships: [
                ...(a.relationships ?? []),
                ...(b.relationships ?? []),
            ],
        };
    }
    cloneElement(el) {
        return {
            ...el,
            children: (el.children ?? []).map((c) => this.cloneElement(c)),
        };
    }
    countElements(elements) {
        const rec = (e) => 1 + (e.children ?? []).reduce((s, c) => s + rec(c), 0);
        return elements.reduce((s, e) => s + rec(e), 0);
    }
    renderTreeHtml(elements) {
        const renderNode = (el) => {
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
    async onMessage(msg) {
        if (!msg || typeof msg.command !== "string")
            return;
        if (msg.command === "refresh") {
            await this.refresh();
            return;
        }
        if (msg.command === "setView" && msg.view) {
            (0, logger_1.log)("VisualizationPanel: setView", msg.view);
            this.currentView = msg.view;
            await this.refresh();
            return;
        }
        if (msg.command === "showMessage" && msg.text) {
            vscode.window.showInformationMessage(msg.text);
            return;
        }
        if (msg.command === "export" && msg.format && msg.data !== undefined) {
            const format = msg.format;
            (0, logger_1.log)("VisualizationPanel: export", format);
            const defaultName = `sysml-diagram-${Date.now()}.${format}`;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(""), defaultName),
                filters: format === "png"
                    ? { PNG: ["png"] }
                    : { SVG: ["svg"] },
            });
            if (uri) {
                if (format === "png") {
                    const bytes = Buffer.from(msg.data, "base64");
                    await vscode.workspace.fs.writeFile(uri, bytes);
                }
                else {
                    const bytes = Buffer.from(msg.data, "utf8");
                    await vscode.workspace.fs.writeFile(uri, bytes);
                }
                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            }
            return;
        }
        if (msg.command === "jump" && msg.range) {
            const doc = vscode.window.activeTextEditor?.document;
            if (!doc)
                return;
            const r = msg.range;
            const range = new vscode.Range(new vscode.Position(r.start.line, r.start.character), new vscode.Position(r.end.line, r.end.character));
            const editor = await vscode.window.showTextDocument(doc, {
                preserveFocus: false,
                preview: true,
            });
            editor.selection = new vscode.Selection(range.start, range.start);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
    }
    renderHtml(extensionUri) {
        const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
        const csp = [
            "default-src 'none'",
            "img-src https: data: blob:",
            "style-src 'unsafe-inline'",
            `script-src 'nonce-${nonce}' 'unsafe-inline'`,
        ].join("; ");
        const cytoscapeUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "node_modules", "cytoscape", "dist", "cytoscape.min.js"));
        const elkUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "node_modules", "elkjs", "lib", "elk.bundled.js"));
        const cytoscapeSvgUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "node_modules", "cytoscape-svg", "cytoscape-svg.js"));
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
        flex-wrap: wrap;
      }
      .view-switcher {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .export-buttons { display: flex; gap: 4px; }
      .export-buttons button { font-size: 11px; padding: 2px 6px; }
      .view-switcher select {
        font-family: inherit;
        font-size: 12px;
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--bg);
        color: var(--vscode-foreground);
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
      #cy {
        width: 100%;
        height: 400px;
        min-height: 300px;
        border: 1px solid var(--border);
        border-radius: 6px;
      }
      #root.tree-view #cy { display: none; }
      #root.diagram-view #cy { display: block; }
      #root.diagram-view .tree { display: none; }
    </style>
  </head>
  <body>
    <header>
      <h1 id="title">Loading…</h1>
      <div class="view-switcher">
        <label for="view-select">View:</label>
        <select id="view-select" title="Diagram view type">
          ${VIEW_OPTIONS.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("")}
        </select>
      </div>
      <div class="export-buttons">
        <button id="export-png" title="Export as PNG">Export PNG</button>
        <button id="export-svg" title="Export as SVG">Export SVG</button>
      </div>
      <button id="refresh">Refresh</button>
    </header>
    <div id="root">
      <div id="cy"></div>
      <ul class="tree"></ul>
    </div>

    <script src="${cytoscapeUri}" nonce="${nonce}"></script>
    <script src="${cytoscapeSvgUri}" nonce="${nonce}"></script>
    <script src="${elkUri}" nonce="${nonce}"></script>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const root = document.getElementById('root');
      const title = document.getElementById('title');
      document.getElementById('refresh').addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
      });

      const viewSelect = document.getElementById('view-select');
      viewSelect.addEventListener('change', () => {
        vscode.postMessage({ command: 'setView', view: viewSelect.value });
      });

      function doExport(format) {
        if (!cyInstance) {
          vscode.postMessage({ command: 'showMessage', text: 'Export available for diagram views (Package, IBD, Graph) only.' });
          return;
        }
        try {
          if (format === 'png') {
            const base64 = cyInstance.png({ scale: 2, full: true });
            vscode.postMessage({ command: 'export', format: 'png', data: base64 });
          } else {
            if (typeof cyInstance.svg !== 'function') {
              vscode.postMessage({ command: 'showMessage', text: 'SVG export requires cytoscape-svg. Using PNG.' });
              const base64 = cyInstance.png({ scale: 2, full: true });
              vscode.postMessage({ command: 'export', format: 'png', data: base64 });
              return;
            }
            const svgStr = cyInstance.svg({ full: true, scale: 2 });
            vscode.postMessage({ command: 'export', format: 'svg', data: svgStr });
          }
        } catch (e) {
          vscode.postMessage({ command: 'showMessage', text: 'Export failed: ' + String(e) });
        }
      }
      document.getElementById('export-png').addEventListener('click', () => doExport('png'));
      document.getElementById('export-svg').addEventListener('click', () => doExport('svg'));

      let cyInstance = null;

      function buildGraphData(elements, relationships, view) {
        const nodes = [];
        const edges = [];
        const idToRange = {};

        function addNode(el, id) {
          if (!idToRange[id]) idToRange[id] = el.range;
          const label = el.name || '(anonymous)';
          const nodeType = (el.type || 'symbol').replace(/\s/g, '_');
          nodes.push({ data: { id, label, type: nodeType } });
          (el.children || []).forEach((ch, i) => {
            const childId = id + '::' + (ch.name || 'c' + i);
            addNode(ch, childId);
            if (view === 'package') {
              edges.push({ data: { id: 'e' + id + '-' + childId, source: id, target: childId } });
            }
          });
        }
        elements.forEach((el, i) => addNode(el, el.name || 'root' + i));

        if (view === 'ibd' || view === 'graph') {
          const nodeIds = new Set(nodes.map(n => n.data.id));
          const addIfMissing = (id) => {
            if (id && !nodeIds.has(id)) {
              nodeIds.add(id);
              nodes.push({ data: { id, label: id.split(/[::.]/).pop() || id, type: 'ref' } });
            }
          };
          const seen = new Set();
          (relationships || []).filter(r => ['connection', 'bind', 'instanceOf', 'specializes', 'allocate'].includes(r.type))
            .forEach((r, i) => {
              const key = r.source + '->' + r.target;
              if (r.source && r.target && !seen.has(key)) {
                seen.add(key);
                addIfMissing(r.source);
                addIfMissing(r.target);
                edges.push({ data: { id: 'rel' + i, source: r.source, target: r.target, relType: r.type } });
              }
            });
        }

        return { nodes, edges, idToRange };
      }

      function renderDiagram(msg) {
        const view = msg.view || 'tree';
        if (view === 'tree') {
          root.classList.remove('diagram-view');
          root.classList.add('tree-view');
          root.querySelector('.tree').innerHTML = msg.html || '';
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
          if (cyInstance) { cyInstance.destroy(); cyInstance = null; }
          return;
        }

        root.classList.add('diagram-view');
        root.classList.remove('tree-view');
        const { nodes, edges, idToRange } = buildGraphData(msg.elements || [], msg.relationships || [], view);
        const container = document.getElementById('cy');
        if (cyInstance) cyInstance.destroy();

        if (typeof cytoscape === 'undefined') {
          container.innerHTML = '<div class="err">Cytoscape not loaded. Using tree view.</div>';
          return;
        }

        cyInstance = cytoscape({
          container,
          elements: [...nodes.map(n => ({ group: 'nodes', data: n.data })), ...edges.map(e => ({ group: 'edges', data: e.data }))],
          style: [
            { selector: 'node', style: { 'label': 'data(label)', 'text-valign': 'bottom', 'background-color': '#666', 'color': '#fff', 'font-size': '10px', 'text-margin-y': 2 } },
            { selector: 'edge', style: { 'width': 1, 'line-color': '#999', 'target-arrow-color': '#999', 'curve-style': 'bezier' } }
          ],
          layout: { name: view === 'package' ? 'breadthfirst' : 'cose', directed: view === 'package' }
        });

        cyInstance.on('tap', 'node', (evt) => {
          const id = evt.target.data('id');
          const range = idToRange[id];
          if (range) vscode.postMessage({ command: 'jump', range });
        });
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.command !== 'setModel') return;
        title.textContent = msg.title || 'SysML Visualizer';
        if (viewSelect.value !== msg.view) viewSelect.value = msg.view || 'tree';
        renderDiagram(msg);
      });
    </script>
  </body>
</html>`;
    }
}
exports.VisualizationPanel = VisualizationPanel;
//# sourceMappingURL=visualizationPanel.js.map