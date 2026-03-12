/**
 * Graph builders for General View. Converts LSP graph data to D3 node/edge elements.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { graphToElementTree } from '../prepareData';
import { isMetadataElement, buildEnhancedElementLabel, slugify } from './helpers';
import { formatSysMLStereotype, getTypeColor } from './shared';
import { GENERAL_VIEW_CATEGORIES } from './constants';

export interface GeneralViewGraphContext {
    expandedGeneralCategories: Set<string>;
    webviewLog?: (level: 'info' | 'warn' | 'error', ...args: any[]) => void;
}

function getCategoryForType(typeLower: string): string {
    for (const cat of GENERAL_VIEW_CATEGORIES) {
        if (cat.keywords.some((kw) => typeLower.includes(kw))) {
            return cat.id;
        }
    }
    return 'other';
}

/**
 * Build synthetic tree edges for General View: root PartDef → parts → typing → PartDef → nested parts.
 */
export function buildSyntheticTreeEdgesForGeneralView(nodes: any[], edges: any[]): { edges: any[]; rootId: string | null } {
    const getType = (e: any) => (e.type || e.rel_type || '').toLowerCase();
    const containsList = edges.filter((e: any) => getType(e) === 'contains');
    const typingList = edges.filter((e: any) => getType(e) === 'typing');
    const nodeById = new Map<string, any>();
    nodes.forEach((n: any) => {
        if (n && n.id) nodeById.set(n.id, n);
    });
    const nodeType = (n: any) => ((n?.type || n?.element_type || '') as string).toLowerCase();
    const isPartDef = (n: any) => n && nodeType(n).includes('part def');
    const isPartUsage = (n: any) => n && (nodeType(n) === 'part' || nodeType(n).includes('part usage'));
    const containsChildren = new Map<string, string[]>();
    const typingTarget = new Map<string, string>();
    containsList.forEach((e: any) => {
        if (!containsChildren.has(e.source)) containsChildren.set(e.source, []);
        containsChildren.get(e.source)!.push(e.target);
    });
    typingList.forEach((e: any) => {
        const src = nodeById.get(e.source);
        if (src && isPartUsage(src)) typingTarget.set(e.source, e.target);
    });
    const partDefsWithParts = [...containsChildren.entries()].filter(([pid, kids]) => {
        const p = nodeById.get(pid);
        return p && isPartDef(p) && kids.some((k) => isPartUsage(nodeById.get(k)));
    });
    const partDefIds = new Set(partDefsWithParts.map(([p]) => p));
    const containedByPackageOrRoot = new Set<string>();
    containsList.forEach((e: any) => {
        if (e.target && nodeById.get(e.source) && !isPartDef(nodeById.get(e.source))) {
            containedByPackageOrRoot.add(e.target);
        }
    });
    const hasNoParent = (id: string) => !containsList.some((e: any) => e.target === id);
    let candidateRoots = partDefsWithParts
        .filter(([pid]) => containedByPackageOrRoot.has(pid) || hasNoParent(pid))
        .map(([pid]) => pid);
    if (candidateRoots.length === 0) {
        const typingTargetPartDefs = new Set(
            typingList.map((e: any) => e.target).filter((tid: string) => nodeById.get(tid) && isPartDef(nodeById.get(tid)))
        );
        candidateRoots = [...typingTargetPartDefs];
    }
    if (candidateRoots.length === 0 && partDefIds.size) {
        candidateRoots = [...partDefIds];
    }
    const pickRoot = () => {
        const byName = candidateRoots.find(
            (id) =>
                (nodeById.get(id)?.name || '').includes('SurveillanceQuadrotorDrone') ||
                (nodeById.get(id)?.name || '').includes('Drone')
        );
        if (byName) return byName;
        const byPartCount = [...candidateRoots].sort(
            (a, b) => (containsChildren.get(b)?.length || 0) - (containsChildren.get(a)?.length || 0)
        );
        return byPartCount[0];
    };
    const rootId = candidateRoots.length ? pickRoot() : partDefIds.size ? [...partDefIds][0] : null;
    const out: any[] = [];
    const seen = new Set<string>();
    function visitPartDef(partDefId: string) {
        if (seen.has(partDefId)) return;
        seen.add(partDefId);
        const kids = containsChildren.get(partDefId) || [];
        kids.forEach((childId) => {
            const c = nodeById.get(childId);
            if (!c || !isPartUsage(c)) return;
            out.push({ source: partDefId, target: childId, type: 'hierarchy' });
            const defId = typingTarget.get(childId);
            if (defId && nodeById.get(defId)) {
                out.push({ source: childId, target: defId, type: 'typing' });
                visitPartDef(defId);
            }
        });
    }
    candidateRoots.forEach((pid) => visitPartDef(pid));
    if (candidateRoots.length === 0 && partDefIds.size) {
        [...partDefIds].forEach((pid) => visitPartDef(pid));
    }
    typingList.forEach((e: any) => {
        const src = nodeById.get(e.source);
        const tgt = nodeById.get(e.target);
        if (
            src &&
            tgt &&
            isPartUsage(src) &&
            isPartDef(tgt) &&
            !out.some((x) => x.source === e.source && x.target === e.target && x.type === 'typing')
        ) {
            out.push({ source: e.source, target: e.target, type: 'typing' });
        }
    });
    console.log(
        '[GV] buildSyntheticTreeEdges',
        'containsList',
        containsList.length,
        'candidateRoots',
        candidateRoots.length,
        'syntheticEdges',
        out.length
    );
    return { edges: out, rootId };
}

/**
 * Convert graph (nodes + edges) to D3 node/edge data for General View.
 */
export function graphToGeneralViewElements(
    graph: any,
    ctx: GeneralViewGraphContext
): { elements: any[]; typeStats: Record<string, number> } {
    if (!graph || (!graph.nodes?.length && !graph.edges?.length)) {
        return { elements: [], typeStats: {} };
    }
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const cyElements: any[] = [];
    const typeStats: Record<string, number> = {};
    const idToCyId = new Map<string, string>();
    const elementTree = graphToElementTree(graph);
    const idToElement = new Map<string, any>();
    function indexByKey(els: any[]) {
        if (!els || !Array.isArray(els)) return;
        els.forEach((el: any) => {
            if (el && el.id) idToElement.set(el.id, el);
            if (el && el.children) indexByKey(el.children);
        });
    }
    indexByKey(elementTree);
    const { edges: syntheticEdges } = buildSyntheticTreeEdgesForGeneralView(nodes, edges);
    const nodeType = (n: any) => ((n?.type || n?.element_type || '') as string).toLowerCase();
    const isPartDef = (n: any) => n && nodeType(n).includes('part def');
    const isPartUsage = (n: any) => n && (nodeType(n) === 'part' || nodeType(n).includes('part usage'));
    const isPartOrPartDef = (n: any) => isPartDef(n) || isPartUsage(n);
    const nodeById = new Map<string, any>();
    nodes.forEach((n: any) => {
        if (n && n.id) nodeById.set(n.id, n);
    });
    const rawContainsTypingSpecializes = edges.filter((e: any) => {
        const t = (e.type || e.rel_type || '').toLowerCase();
        return t === 'contains' || t === 'typing' || t === 'specializes';
    });
    const getEdgeType = (e: any) => ((e.type || e.rel_type || '') as string).toLowerCase();
    const rawPartEdges = rawContainsTypingSpecializes
        .filter((e: any) => {
            const src = nodeById.get(e.source);
            const tgt = nodeById.get(e.target);
            return src && tgt && isPartOrPartDef(src) && isPartOrPartDef(tgt);
        })
        .map((e: any) => {
            const t = getEdgeType(e);
            const type =
                t === 'contains' ? 'hierarchy' : t === 'typing' ? 'typing' : t === 'specializes' ? 'specializes' : 'hierarchy';
            return { source: e.source, target: e.target, type };
        });
    const syntheticNodeCount = new Set(syntheticEdges.flatMap((e: any) => [e.source, e.target])).size;
    const useSyntheticTree = syntheticEdges.length > 0 && syntheticNodeCount >= 5;
    const specializesEdges = rawPartEdges.filter((e: any) => e.type === 'specializes');
    const edgesToUse = useSyntheticTree ? [...syntheticEdges, ...specializesEdges] : rawPartEdges;
    const edgeEndpointIds = new Set<string>();
    edgesToUse.forEach((e: any) => {
        edgeEndpointIds.add(e.source);
        edgeEndpointIds.add(e.target);
    });
    const filteredNodes = nodes.filter((node: any) => {
        if (!node || isMetadataElement(node.type)) return false;
        if (!isPartOrPartDef(node)) return false;
        const typeLower = (node.type || '').toLowerCase().trim();
        const category = getCategoryForType(typeLower);
        const matchesCategory =
            (category === 'partDefs' || category === 'parts') && ctx.expandedGeneralCategories.has(category);
        const isEdgeEndpoint = edgeEndpointIds.has(node.id);
        return matchesCategory || isEdgeEndpoint;
    });
    const categoryOrder = new Map(GENERAL_VIEW_CATEGORIES.map((c, i) => [c.id, i]));
    filteredNodes.sort((a: any, b: any) => {
        const catA = getCategoryForType((a.type || '').toLowerCase());
        const catB = getCategoryForType((b.type || '').toLowerCase());
        const orderA = categoryOrder.get(catA) ?? 999;
        const orderB = categoryOrder.get(catB) ?? 999;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
    filteredNodes.forEach((node: any, index: number) => {
        const cyId = 'gv-' + slugify(node.id) + '-' + index;
        idToCyId.set(node.id, cyId);
        const category = getCategoryForType((node.type || '').toLowerCase());
        typeStats[category] = (typeStats[category] || 0) + 1;
        const elementWithChildren = idToElement.get(node.id);
        const baseLabel = elementWithChildren
            ? buildEnhancedElementLabel(elementWithChildren)
            : (() => {
                  const stereotype = formatSysMLStereotype(node.type);
                  const displayName = node.name || 'Unnamed';
                  return stereotype ? stereotype + ' ' + displayName : displayName;
              })();
        const typeLower = (node.type || '').toLowerCase();
        const isDefinition = typeLower.includes('def') || typeLower.includes('definition');
        const color = getTypeColor(node.type);
        const cat = GENERAL_VIEW_CATEGORIES.find((c) => c.id === category);
        const borderColor = (cat && cat.color) || color;
        const attrs = node.attributes || {};
        const metadata = {
            documentation: typeof attrs.documentation !== 'undefined' ? attrs.documentation : null,
            properties: attrs
        };
        cyElements.push({
            group: 'nodes',
            data: {
                id: cyId,
                label: baseLabel,
                baseLabel: baseLabel,
                type: 'element',
                sysmlType: node.type || node.element_type,
                elementName: node.name,
                elementQualifiedName: node.id,
                color: borderColor,
                isDefinition,
                category,
                metadata,
                element: elementWithChildren || null
            }
        });
    });
    const validNodeIds = new Set(cyElements.filter((el: any) => el.group === 'nodes').map((el: any) => el.data.id));
    const hierarchyEdgeIds = new Set<string>();
    const typingEdgeIds = new Set<string>();
    const specializesEdgeIds = new Set<string>();
    const resolveCyId = (backendId: string) => idToCyId.get(backendId) || null;
    let edgesResolved = 0;
    edgesToUse.forEach((edge: any) => {
        const sourceCyId = resolveCyId(edge.source);
        const targetCyId = resolveCyId(edge.target);
        if (
            !sourceCyId ||
            !targetCyId ||
            sourceCyId === targetCyId ||
            !validNodeIds.has(sourceCyId) ||
            !validNodeIds.has(targetCyId)
        )
            return;
        edgesResolved++;
        const edgeType = edge.type || 'hierarchy';
        if (edgeType === 'hierarchy') {
            const edgeId = 'hier-' + sourceCyId + '-' + targetCyId;
            if (!hierarchyEdgeIds.has(edgeId)) {
                hierarchyEdgeIds.add(edgeId);
                cyElements.push({
                    group: 'edges',
                    data: { id: edgeId, source: sourceCyId, target: targetCyId, type: 'hierarchy', label: '' }
                });
            }
        } else if (edgeType === 'typing') {
            const edgeId = 'rel-typing-' + sourceCyId + '-' + targetCyId;
            if (!typingEdgeIds.has(edgeId)) {
                typingEdgeIds.add(edgeId);
                cyElements.push({
                    group: 'edges',
                    data: {
                        id: edgeId,
                        source: sourceCyId,
                        target: targetCyId,
                        type: 'relationship',
                        relType: 'typing',
                        label:
                            ': ' +
                            (nodes.find((n: any) => n && n.id === edge.target)?.name ||
                                edge.target.split(/[.::]+/).pop() ||
                                edge.target)
                    }
                });
            }
        } else if (edgeType === 'specializes') {
            const edgeId = 'rel-specializes-' + sourceCyId + '-' + targetCyId;
            if (!specializesEdgeIds.has(edgeId)) {
                specializesEdgeIds.add(edgeId);
                cyElements.push({
                    group: 'edges',
                    data: {
                        id: edgeId,
                        source: sourceCyId,
                        target: targetCyId,
                        type: 'relationship',
                        relType: 'specializes',
                        label:
                            ':> ' +
                            (nodes.find((n: any) => n && n.id === edge.target)?.name ||
                                edge.target.split(/[.::]+/).pop() ||
                                edge.target)
                    }
                });
            }
        }
    });
    console.log(
        '[GV] graphToGeneralViewElements',
        'syntheticEdges',
        syntheticEdges.length,
        'filteredNodes',
        filteredNodes.length,
        'edgesToUse',
        edgesToUse.length,
        'edgesResolved',
        edgesResolved
    );
    return { elements: cyElements, typeStats };
}

/**
 * Build General View graph from LSP data. Requires graph; returns empty when graph is missing.
 */
export function buildGeneralViewGraph(
    dataOrElements: any,
    _relationships: any[],
    ctx: GeneralViewGraphContext
): { elements: any[]; typeStats: Record<string, number> } {
    const graph = dataOrElements?.graph;
    if (!graph || (!graph.nodes?.length && !graph.edges?.length)) {
        if (!graph && ctx.webviewLog) {
            ctx.webviewLog('info', '[GV] No graph in data; General View requires graph from LSP');
        }
        return { elements: [], typeStats: {} };
    }
    const containsCount = (graph.edges || []).filter(
        (e: any) => (e.type || e.rel_type || '').toLowerCase() === 'contains'
    ).length;
    console.log('[GV] graph', graph.nodes?.length, 'nodes', graph.edges?.length, 'edges', containsCount, 'contains');
    return graphToGeneralViewElements(graph, ctx);
}
