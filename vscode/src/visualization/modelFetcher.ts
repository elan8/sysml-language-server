import * as vscode from 'vscode';
import type { LspModelProvider } from '../providers/lspModelProvider';
import type {
    SysMLGraphDTO,
    GraphNodeDTO,
    GraphEdgeDTO,
} from '../providers/sysmlModelTypes';

export interface FetchModelParams {
    documentUri: string;
    fileUris: vscode.Uri[];
    lspModelProvider: LspModelProvider;
    currentView: string;
    pendingPackageName?: string;
}

export interface UpdateMessage {
    command: 'update';
    graph?: SysMLGraphDTO;
    sequenceDiagrams: unknown[];
    activityDiagrams: unknown[];
    currentView: string;
    pendingPackageName?: string;
}

/**
 * Hash content for change detection. Used to skip re-parsing when document
 * content has not changed.
 */
export function hashContent(content: string): string {
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
export function mergeGraphs(graphs: SysMLGraphDTO[]): SysMLGraphDTO {
    const nodeMap = new Map<string, GraphNodeDTO>();
    const edgeKeys = new Set<string>();
    const edges: GraphEdgeDTO[] = [];

    for (const g of graphs) {
        for (const node of g.nodes ?? []) {
            const existing = nodeMap.get(node.id);
            if (existing && node.type === 'package') {
                existing.attributes = { ...(existing.attributes ?? {}), ...(node.attributes ?? {}) };
            } else if (!existing) {
                nodeMap.set(node.id, { ...node, attributes: { ...(node.attributes ?? {}) } });
            }
        }
        for (const edge of g.edges ?? []) {
            const key = `${edge.type}::${edge.source}::${edge.target}`;
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
export async function fetchModelData(params: FetchModelParams): Promise<UpdateMessage | null> {
    const {
        documentUri,
        fileUris,
        lspModelProvider,
        currentView,
        pendingPackageName,
    } = params;

    const urisToQuery = fileUris.length > 0
        ? fileUris.map(u => u.toString())
        : [documentUri];

    const scopes: ('graph' | 'sequenceDiagrams' | 'activityDiagrams')[] =
        ['graph', 'sequenceDiagrams', 'activityDiagrams'];

    const results = await Promise.all(
        urisToQuery.map(uri => lspModelProvider.getModel(uri, scopes)),
    );

    const allGraphs: SysMLGraphDTO[] = [];
    const allSequenceDiagrams: unknown[] = [];
    const allActivityDiagrams: unknown[] = [];

    for (const result of results) {
        if (result.graph?.nodes?.length || result.graph?.edges?.length) {
            allGraphs.push(result.graph);
        }
        if (result.sequenceDiagrams) allSequenceDiagrams.push(...result.sequenceDiagrams);
        if (result.activityDiagrams) allActivityDiagrams.push(...result.activityDiagrams);
    }

    const mergedGraph = mergeGraphs(allGraphs);

    const msg: UpdateMessage = {
        command: 'update',
        graph: mergedGraph,
        sequenceDiagrams: allSequenceDiagrams,
        activityDiagrams: allActivityDiagrams,
        currentView,
    };
    if (pendingPackageName) {
        msg.pendingPackageName = pendingPackageName;
    }
    return msg;
}
