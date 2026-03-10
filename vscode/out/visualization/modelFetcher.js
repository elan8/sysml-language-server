"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashContent = hashContent;
exports.mergeGraphs = mergeGraphs;
exports.fetchModelData = fetchModelData;
/**
 * Hash content for change detection. Used to skip re-parsing when document
 * content has not changed.
 */
function hashContent(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
}
/**
 * Merge graphs from multiple files. Nodes with same id (qualified name) are merged;
 * packages merge attributes and children; edges are deduplicated.
 */
function mergeGraphs(graphs) {
    const nodeMap = new Map();
    const edgeKeys = new Set();
    const edges = [];
    for (const g of graphs) {
        for (const node of g.nodes ?? []) {
            const existing = nodeMap.get(node.id);
            if (existing && node.type === 'package') {
                existing.attributes = { ...(existing.attributes ?? {}), ...(node.attributes ?? {}) };
            }
            else if (!existing) {
                nodeMap.set(node.id, { ...node, attributes: { ...(node.attributes ?? {}) } });
            }
        }
        for (const edge of g.edges ?? []) {
            const edgeType = edge.type || edge.rel_type || '';
            const key = `${edgeType}::${edge.source}::${edge.target}`;
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edges.push(edge);
            }
        }
    }
    return {
        nodes: Array.from(nodeMap.values()),
        edges,
    };
}
/**
 * Fetch model data from the LSP provider and convert it to the webview update message format.
 */
async function fetchModelData(params) {
    const { documentUri, fileUris, lspModelProvider, currentView, pendingPackageName, } = params;
    const urisToQuery = fileUris.length > 0
        ? fileUris.map(u => u.toString())
        : [documentUri];
    const scopes = ['graph', 'sequenceDiagrams', 'activityDiagrams'];
    const results = await Promise.all(urisToQuery.map(uri => lspModelProvider.getModel(uri, scopes)));
    const allGraphs = [];
    const allSequenceDiagrams = [];
    const allActivityDiagrams = [];
    for (const result of results) {
        if (result.graph?.nodes?.length || result.graph?.edges?.length) {
            allGraphs.push(result.graph);
        }
        if (result.sequenceDiagrams)
            allSequenceDiagrams.push(...result.sequenceDiagrams);
        if (result.activityDiagrams)
            allActivityDiagrams.push(...result.activityDiagrams);
    }
    const mergedGraph = mergeGraphs(allGraphs);
    const primaryResult = results.find(r => r.graph?.nodes?.length || r.graph?.edges?.length) ?? results[0];
    const ibd = primaryResult?.ibd;
    const msg = {
        command: 'update',
        graph: mergedGraph,
        ibd,
        sequenceDiagrams: allSequenceDiagrams,
        activityDiagrams: allActivityDiagrams,
        currentView,
    };
    if (pendingPackageName) {
        msg.pendingPackageName = pendingPackageName;
    }
    return msg;
}
//# sourceMappingURL=modelFetcher.js.map