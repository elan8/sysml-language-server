/**
 * IBD/Interconnection View renderer - parts, ports, connectors.
 * Uses ELK for connection-aware layout and orthogonal edge routing when available.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RenderContext } from '../types';
import { GENERAL_VIEW_PALETTE } from '../constants';
import { postJumpToElement } from '../jumpToElement';
import { getTypeColor, isLibraryValidated } from '../shared';

declare const d3: any;
declare const ELK: any;

export async function renderIbdView(ctx: RenderContext & { elkWorkerUrl?: string }, data: any): Promise<void> {
    const { width, height, svg, g, layoutDirection, postMessage, onStartInlineEdit, renderPlaceholder, clearVisualHighlights } = ctx;

    if (!data || !data.parts || data.parts.length === 0) {
        renderPlaceholder(width, height, 'Interconnection View',
            'No parts or internal structure found to display.\\n\\nThis view shows internal block diagrams with parts, ports, and connectors.',
            data);
        return;
    }

    const parts = data.parts || [];
    const ports = data.ports || [];
    const connectors = data.connectors || [];

    const getPortsForPartRef = (part: any) => ports.filter((p: any) =>
        p && (
            p.parentId === part.name ||
            p.parentId === part.id ||
            p.parentId === part.qualifiedName
        )
    );

    // Layout configuration - adapt spacing to port density instead of a single fixed layout.
    const isHorizontal = layoutDirection === 'horizontal';
    const basePartWidth = 280;
    const maxPortsPerPart = Math.max(0, ...parts.map((part: any) => getPortsForPartRef(part).length));
    const layoutDensityBoost = Math.min(80, Math.max(0, maxPortsPerPart - 2) * 10);
    const partWidth = basePartWidth;
    const padding = 140 + Math.min(40, Math.max(0, maxPortsPerPart - 1) * 6);
    const horizontalSpacing = 160 + layoutDensityBoost;
    const verticalSpacing = 100 + Math.round(layoutDensityBoost * 0.6);

    const toDot = (qn: string) => (qn || '').replace(/::/g, '.');
    const normalizeEndpointId = (value: string | null | undefined) => toDot(value || '').trim();
    const partToElkId = (p: any) => toDot(p.qualifiedName) || p.id || p.name;
    const getPortDirection = (port: any): 'in' | 'out' | 'inout' => {
        const direction = String(port?.direction || '').toLowerCase();
        const name = String(port?.name || '').toLowerCase();
        if (direction === 'in' || (!direction && name.startsWith('in'))) return 'in';
        if (direction === 'out' || (!direction && name.startsWith('out'))) return 'out';
        return 'inout';
    };
    const getPortTypeName = (port: any): string | null => {
        const attrs = port?.attributes;
        const raw = attrs?.get ? (attrs.get('portType') || attrs.get('type')) : (attrs?.portType || attrs?.type);
        if (!raw) return null;
        const text = String(raw);
        const segments = text.split(/::|\./);
        return segments[segments.length - 1] || text;
    };
    const truncateLabel = (value: string, maxLength: number): string =>
        value.length > maxLength ? value.substring(0, maxLength - 2) + '..' : value;
    const getPortVisualColor = (direction: 'in' | 'out' | 'inout'): string => {
        if (direction === 'in') return '#0E7C7B';
        if (direction === 'out') return '#2D8A6E';
        return '#4A9B7F';
    };
    const getConnectorVisualStyle = (connector: any) => {
        const connTypeLower = String(connector?.type || '').toLowerCase();
        const connNameLower = String(connector?.name || '').toLowerCase();
        const isFlow = connTypeLower === 'flow' || connNameLower.includes('flow');
        const isInterface = connTypeLower === 'interface' || connNameLower.includes('interface');
        const isBinding = connTypeLower === 'binding' || connNameLower.includes('bind');
        const isConnection = connTypeLower === 'connection' || connNameLower.includes('connect');

        if (isFlow) {
            return {
                strokeColor: 'var(--vscode-charts-green)',
                strokeStyle: 'none',
                strokeWidth: '2.5px',
                markerStart: 'none',
                markerEnd: 'url(#ibd-flow-arrow)',
                typeIndicator: '-> ',
                isFlow: true,
            };
        }
        if (isInterface) {
            return {
                strokeColor: 'var(--vscode-charts-purple)',
                strokeStyle: '8,4',
                strokeWidth: '2px',
                markerStart: 'none',
                markerEnd: 'url(#ibd-interface-arrow)',
                typeIndicator: '<> ',
                isFlow: false,
            };
        }
        if (isBinding) {
            return {
                strokeColor: 'var(--vscode-charts-blue)',
                strokeStyle: '6,4',
                strokeWidth: '1.5px',
                markerStart: 'url(#ibd-connection-dot)',
                markerEnd: 'url(#ibd-connection-dot)',
                typeIndicator: '= ',
                isFlow: false,
            };
        }
        return {
            strokeColor: 'var(--vscode-charts-blue)',
            strokeStyle: isConnection ? 'none' : '2,2',
            strokeWidth: isConnection ? '2px' : '1.5px',
            markerStart: 'url(#ibd-connection-dot)',
            markerEnd: 'url(#ibd-connection-dot)',
            typeIndicator: isConnection ? 'o ' : '',
            isFlow: false,
        };
    };

    // Assign IDs to parts
    parts.forEach((part: any, index: number) => {
        if (!part.id) part.id = part.name || ('part-' + index);
    });

    // Helper function to calculate part height based on content
    const calculatePartHeight = (part: any) => {
        const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
        const partChildren = part.children || [];

        let contentLineCount = 0;

        partPorts.forEach((p: any) => {
            if (p && p.name) {
                contentLineCount++;
                if (p.properties) contentLineCount += Object.keys(p.properties).length;
                if (p.attributes) {
                    if (typeof p.attributes.forEach === 'function') {
                        p.attributes.forEach(() => contentLineCount++);
                    } else if (typeof p.attributes === 'object') {
                        contentLineCount += Object.keys(p.attributes).filter((k: string) => k !== 'isRedefinition').length;
                    }
                }
                if (p.children) {
                    contentLineCount += p.children.filter((c: any) => c.type === 'redefinition' && c.name).length;
                }
            }
        });

        partChildren.forEach((c: any) => {
            if (!c || !c.name || !c.type) return;
            if (c.type === 'part' || c.type === 'port') {
                contentLineCount++;
                if (c.properties) contentLineCount += Object.keys(c.properties).length;
                if (c.attributes) {
                    if (typeof c.attributes.forEach === 'function') {
                        c.attributes.forEach(() => contentLineCount++);
                    } else if (typeof c.attributes === 'object') {
                        contentLineCount += Object.keys(c.attributes).filter((k: string) => k !== 'isRedefinition').length;
                    }
                }
                if (c.children) {
                    contentLineCount += c.children.filter((gc: any) => gc.type === 'redefinition' && gc.name).length;
                }
            } else if (c.type === 'redefinition' || c.type === 'attribute' || c.type === 'property' || c.type === 'state') {
                contentLineCount++;
            }
        });

        let hasTypedBy = false;
        if (part.attributes && part.attributes.get) {
            hasTypedBy = !!(part.attributes.get('partType') || part.attributes.get('type') || part.attributes.get('typedBy'));
        }
        if (!hasTypedBy && part.partType) hasTypedBy = true;

        const lineHeight = 12;
        const headerHeight = hasTypedBy ? 50 : 38;
        const contentHeight = contentLineCount * lineHeight + 10;
        const portsHeight = partPorts.length * 16 + 10;

        return Math.max(80, headerHeight + contentHeight + portsHeight);
    };

    const calculatePartWidth = (part: any) => {
        const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
        let typedByName: string | null = null;
        if (part.attributes && part.attributes.get) {
            typedByName = part.attributes.get('partType') || part.attributes.get('type') || part.attributes.get('typedBy');
        }
        if (!typedByName && part.partType) typedByName = part.partType;

        const longestPortLabel = partPorts.reduce((max: number, port: any) => {
            const portType = getPortTypeName(port);
            const label = portType ? `${port.name} : ${portType}` : String(port.name || '');
            return Math.max(max, label.length);
        }, 0);
        const longestHeader = Math.max(
            String(part.name || '').length,
            String(typedByName || '').length
        );
        const connectednessBonus = Math.min(40, partPorts.length * 8);
        const desiredWidth = Math.max(
            basePartWidth,
            150 + longestHeader * 7 + connectednessBonus,
            130 + longestPortLabel * 6.5 + connectednessBonus
        );
        return Math.min(420, desiredWidth);
    };

    const partHeights = new Map<string, number>();
    const partWidths = new Map<string, number>();
    parts.forEach((part: any) => {
        partHeights.set(part.name, calculatePartHeight(part));
        partWidths.set(part.name, calculatePartWidth(part));
        if (part.id) partHeights.set(part.id, calculatePartHeight(part));
        if (part.id) partWidths.set(part.id, calculatePartWidth(part));
    });

    // Build part tree from containment: roots have containerId null/absent; children have containerId === parent
    // Backend sends containerId as parent's qualifiedName (dot form); match by name, id, or qualifiedName
    type PartTreeNode = { part: any; children: PartTreeNode[] };
    const getPartChildren = (p: any) => parts.filter((c: any) =>
        c.containerId === p.name || c.containerId === p.id || c.containerId === p.qualifiedName ||
        toDot(c.containerId) === toDot(p.qualifiedName)
    );
    const sortPartsForLayout = (items: any[]) => [...items].sort((a: any, b: any) => {
        const aPorts = getPortsForPartRef(a).length;
        const bPorts = getPortsForPartRef(b).length;
        if (bPorts !== aPorts) return bPorts - aPorts;
        const aWidth = partWidths.get(a.name) || partWidth;
        const bWidth = partWidths.get(b.name) || partWidth;
        if (bWidth !== aWidth) return bWidth - aWidth;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
    const buildTree = (part: any): PartTreeNode => ({
        part,
        children: sortPartsForLayout(getPartChildren(part)).map((c: any) => buildTree(c))
    });
    const roots = parts.filter((p: any) => p.containerId == null || p.containerId === undefined || p.containerId === '');
    const rootPart = roots.length > 0
        ? roots.reduce((a, b) => (getPartChildren(a).length >= getPartChildren(b).length ? a : b))
        : parts[0];
    const partTree = rootPart ? buildTree(rootPart) : null;
    const rootName = rootPart ? rootPart.name : '';

    const leafParts = parts.filter((p: any) => getPartChildren(p).length === 0);
    const leafPartIds = new Set<string>(leafParts.map((p: any) => partToElkId(p)));

    const findPartForEndpoint = (endpointPath: string): any => {
        if (!endpointPath) return null;
        const pathDot = normalizeEndpointId(endpointPath);
        let best: { part: any; len: number } | null = null;
        for (const part of parts) {
            const qn = normalizeEndpointId(part.qualifiedName || part.name);
            if (!qn) continue;
            if (pathDot === qn || pathDot.startsWith(qn + '.')) {
                if (!best || qn.length > best.len) best = { part, len: qn.length };
            }
        }
        return best?.part ?? null;
    };

    let elkLaidOut: any = null;
    const useElk = typeof ELK !== 'undefined' && ctx.elkWorkerUrl && partTree;

    if (useElk) {
        try {
            const elk = new ELK({ workerUrl: ctx.elkWorkerUrl || undefined });

            const treeToElkNode = (node: PartTreeNode): any => {
                const part = node.part;
                const id = partToElkId(part);
                const h = partHeights.get(part.name) || 80;
                const w = partWidths.get(part.name) || partWidth;
                if (node.children.length === 0) {
                    return {
                        id,
                        width: w,
                        height: h,
                        ports: [
                            { id: id + '_west', layoutOptions: { 'org.eclipse.elk.port.side': 'WEST' } },
                            { id: id + '_east', layoutOptions: { 'org.eclipse.elk.port.side': 'EAST' } }
                        ]
                    };
                }
                const childNodes = node.children.map((c) => treeToElkNode(c));
                const childWidthSum = node.children.reduce((sum: number, child: PartTreeNode) => {
                    return sum + (partWidths.get(child.part.name) || partWidth);
                }, 0);
                const minW = Math.max(w, Math.min(900, childWidthSum + node.children.length * 40));
                const minH = rootHeaderHeight + 140;
                return {
                    id,
                    width: minW,
                    height: minH,
                    children: childNodes
                };
            };

            const elkEdges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
            connectors.forEach((conn: any, idx: number) => {
                const srcPart = findPartForEndpoint(conn.sourceId || conn.source);
                const tgtPart = findPartForEndpoint(conn.targetId || conn.target);
                if (!srcPart || !tgtPart || !leafPartIds.has(partToElkId(srcPart)) || !leafPartIds.has(partToElkId(tgtPart))) return;
                elkEdges.push({
                    id: 'edge-' + idx,
                    sources: [partToElkId(srcPart) + '_east'],
                    targets: [partToElkId(tgtPart) + '_west']
                });
            });

            const elkGraph = {
                id: 'root',
                layoutOptions: {
                    'elk.algorithm': 'layered',
                    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                    'elk.direction': 'RIGHT',
                    'elk.spacing.nodeNode': '80',
                    'elk.layered.spacing.nodeNodeBetweenLayers': '120',
                    'elk.spacing.edgeNode': '60',
                    'elk.spacing.edgeEdge': '40',
                    'elk.edgeRouting': 'ORTHOGONAL',
                    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
                    'elk.separateConnectedComponents': 'true',
                    'elk.padding': '[top=60,left=60,bottom=60,right=60]',
                    'org.eclipse.elk.portConstraints': 'FIXED_SIDE',
                    'org.eclipse.elk.json.edgeCoords': 'ROOT'
                },
                children: [treeToElkNode(partTree)],
                edges: elkEdges
            };

            elkLaidOut = await elk.layout(elkGraph);
        } catch (e) {
            console.warn('[IBD] ELK layout failed, using tree layout:', e);
            elkLaidOut = null;
        }
    }

    const partPositions = new Map<string, { x: number; y: number; part: any; height: number; width?: number; isContainer?: boolean }>();
    const innerMargin = 24;
    const rootHeaderHeight = 28;

    const relativePath = (qualifiedName: string) => {
        if (!rootName || !qualifiedName) return qualifiedName;
        const prefix = rootName + '.';
        return qualifiedName.startsWith(prefix) ? qualifiedName.slice(prefix.length) : qualifiedName;
    };

    const setPos = (part: any, posData: { x: number; y: number; part: any; height: number; width?: number; isContainer?: boolean; depth?: number }) => {
        partPositions.set(part.name, posData);
        partPositions.set(part.id, posData);
        if (part.qualifiedName && part.qualifiedName !== part.name) {
            partPositions.set(part.qualifiedName, posData);
        }
        partPositions.set(partToElkId(part), posData);
        const rel = relativePath(part.qualifiedName || part.name);
        if (rel && rel !== part.name) partPositions.set(rel, posData);
    };

    const idToPart = new Map<string, any>();
    parts.forEach((p: any) => idToPart.set(partToElkId(p), p));

    const extractElkPositions = (elkNode: any, parentAbsX: number, parentAbsY: number, depth: number) => {
        const part = idToPart.get(elkNode.id);
        if (!part) return;
        const absX = parentAbsX + (elkNode.x ?? 0);
        const absY = parentAbsY + (elkNode.y ?? 0);
        const w = elkNode.width ?? (partWidths.get(part.name) || partWidth);
        const h = elkNode.height ?? (partHeights.get(part.name) || 80);
        const isContainer = elkNode.children && elkNode.children.length > 0;
        const posData = { x: absX + padding, y: absY + padding, part, height: h, width: w, isContainer, depth };
        setPos(part, posData);
        if (elkNode.children && elkNode.children.length > 0) {
            elkNode.children.forEach((ch: any) => extractElkPositions(ch, absX, absY, depth + 1));
        }
    };

    if (elkLaidOut && elkLaidOut.children && elkLaidOut.children.length > 0) {
        const rootElk = elkLaidOut.children[0];
        extractElkPositions(rootElk, 0, 0, 0);
    } else if (partTree) {
        const placeNode = (node: PartTreeNode, baseX: number, baseY: number, depth: number): { width: number; height: number } => {
            const part = node.part;
            const h = partHeights.get(part.name) || 80;
            const w = partWidths.get(part.name) || partWidth;
            if (node.children.length === 0) {
                const posData = { x: baseX, y: baseY, part, height: h, width: w, depth };
                setPos(part, posData);
                return { width: w, height: h };
            }
            const childSpacingH = horizontalSpacing;
            const childSpacingV = verticalSpacing;
            const cols = isHorizontal ? Math.ceil(Math.sqrt(node.children.length * 1.5)) : Math.max(1, Math.ceil(Math.sqrt(node.children.length)));
            let rowHeights: number[] = [];
            let maxW = 0;
            let curX = baseX + innerMargin;
            let curY = baseY + innerMargin;
            let rowMaxH = 0;
            let colIdx = 0;
            for (const child of node.children) {
                const size = placeNode(child, curX, curY, depth + 1);
                rowMaxH = Math.max(rowMaxH, size.height);
                maxW = Math.max(maxW, curX - baseX + size.width);
                colIdx++;
                if (colIdx >= cols) {
                    curY += rowMaxH + childSpacingV;
                    rowHeights.push(rowMaxH);
                    curX = baseX + innerMargin;
                    rowMaxH = 0;
                    colIdx = 0;
                } else {
                    curX += size.width + childSpacingH;
                }
            }
            if (rowMaxH > 0) rowHeights.push(rowMaxH);
            const contentW = maxW + innerMargin;
            const contentH = curY - baseY + (colIdx > 0 ? rowMaxH : 0) + innerMargin;
            const frameW = Math.max(w, contentW);
            const frameH = rootHeaderHeight + contentH;
            const posData = { x: baseX, y: baseY, part, height: frameH, width: frameW, isContainer: true, depth };
            setPos(part, posData);
            return { width: frameW, height: frameH };
        };
        placeNode(partTree, padding, padding, 0);
    } else {
        parts.forEach((part: any) => {
            const posData = {
                x: padding,
                y: padding,
                part,
                height: partHeights.get(part.name) || 80,
                width: partWidths.get(part.name) || partWidth,
                depth: 0
            };
            setPos(part, posData);
        });
    }

    type Rect = { x: number; y: number; width: number; height: number };

    /** Parse SVG path d string (M/L only) into points. */
    const parsePathToPoints = (d: string): { x: number; y: number }[] => {
        const pts: { x: number; y: number }[] = [];
        const tokens = d.replace(/[ML]/gi, ' ').replace(/,/g, ' ').trim().split(/\s+/);
        let i = 0;
        while (i + 1 < tokens.length) {
            const x = parseFloat(tokens[i]);
            const y = parseFloat(tokens[i + 1]);
            if (!Number.isNaN(x) && !Number.isNaN(y)) pts.push({ x, y });
            i += 2;
        }
        return pts;
    };

    const pointsToPathD = (pts: { x: number; y: number }[]): string => {
        if (pts.length === 0) return '';
        let s = 'M' + pts[0].x + ',' + pts[0].y;
        for (let i = 1; i < pts.length; i++) s += ' L' + pts[i].x + ',' + pts[i].y;
        return s;
    };

    const getBestLabelAnchor = (points: { x: number; y: number }[], fallbackX: number, fallbackY: number) => {
        if (points.length < 2) return { x: fallbackX, y: fallbackY };
        let bestIndex = 0;
        let bestLength = -1;
        for (let i = 0; i < points.length - 1; i++) {
            const dx = Math.abs(points[i + 1].x - points[i].x);
            const dy = Math.abs(points[i + 1].y - points[i].y);
            const length = dx + dy;
            if (length > bestLength) {
                bestLength = length;
                bestIndex = i;
            }
        }
        const a = points[bestIndex];
        const b = points[bestIndex + 1];
        const mostlyVertical = Math.abs(a.y - b.y) > Math.abs(a.x - b.x);
        return {
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2 + (mostlyVertical ? 0 : -12),
        };
    };

    const rectIntersectsHSeg = (y: number, x1: number, x2: number, r: Rect, margin: number): boolean => {
        const yMin = r.y - margin, yMax = r.y + r.height + margin;
        if (y < yMin || y > yMax) return false;
        const xMin = Math.min(x1, x2) - margin, xMax = Math.max(x1, x2) + margin;
        return !(xMax < r.x || xMin > r.x + r.width);
    };

    const rectIntersectsVSeg = (x: number, y1: number, y2: number, r: Rect, margin: number): boolean => {
        const xMin = r.x - margin, xMax = r.x + r.width + margin;
        if (x < xMin || x > xMax) return false;
        const yMin = Math.min(y1, y2) - margin, yMax = Math.max(y1, y2) + margin;
        return !(yMax < r.y || yMin > r.y + r.height);
    };

    const OBSTACLE_MARGIN = 10;
    const MAX_DETOUR_DEPTH = 4;

    /** Insert detours so no segment crosses a leaf-node obstacle. Containers are not treated as obstacles. */
    const routeAroundLeafObstacles = (
        points: { x: number; y: number }[],
        obstacles: Rect[],
        depth: number = 0
    ): { x: number; y: number }[] => {
        if (points.length < 2 || obstacles.length === 0 || depth >= MAX_DETOUR_DEPTH) return points;

        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const isHoriz = Math.abs(a.y - b.y) < 1e-6;
            const isVert = Math.abs(a.x - b.x) < 1e-6;
            if (!isHoriz && !isVert) continue;

            for (const r of obstacles) {
                const hits = isHoriz ? rectIntersectsHSeg(a.y, a.x, b.x, r, OBSTACLE_MARGIN)
                    : rectIntersectsVSeg(a.x, a.y, b.y, r, OBSTACLE_MARGIN);
                if (!hits) continue;

                if (isHoriz) {
                    const aboveY = r.y - OBSTACLE_MARGIN;
                    const belowY = r.y + r.height + OBSTACLE_MARGIN;
                    const above: { x: number; y: number }[] = [a, { x: a.x, y: aboveY }, { x: b.x, y: aboveY }, b];
                    const below: { x: number; y: number }[] = [a, { x: a.x, y: belowY }, { x: b.x, y: belowY }, b];
                    const newObs = obstacles.filter((o) => o !== r);
                    const mergedAbove = [...points.slice(0, i), ...above, ...points.slice(i + 2)];
                    const mergedBelow = [...points.slice(0, i), ...below, ...points.slice(i + 2)];
                    const resultAbove = routeAroundLeafObstacles(mergedAbove, newObs, depth + 1);
                    const resultBelow = routeAroundLeafObstacles(mergedBelow, newObs, depth + 1);
                    const lenAbove = resultAbove.reduce((sum, p, j) => {
                        if (j === 0) return 0;
                        return sum + Math.abs(resultAbove[j].x - resultAbove[j - 1].x) + Math.abs(resultAbove[j].y - resultAbove[j - 1].y);
                    }, 0);
                    const lenBelow = resultBelow.reduce((sum, p, j) => {
                        if (j === 0) return 0;
                        return sum + Math.abs(resultBelow[j].x - resultBelow[j - 1].x) + Math.abs(resultBelow[j].y - resultBelow[j - 1].y);
                    }, 0);
                    return lenAbove <= lenBelow ? resultAbove : resultBelow;
                } else {
                    const leftX = r.x - OBSTACLE_MARGIN;
                    const rightX = r.x + r.width + OBSTACLE_MARGIN;
                    const left: { x: number; y: number }[] = [a, { x: leftX, y: a.y }, { x: leftX, y: b.y }, b];
                    const right: { x: number; y: number }[] = [a, { x: rightX, y: a.y }, { x: rightX, y: b.y }, b];
                    const newObs = obstacles.filter((o) => o !== r);
                    const mergedLeft = [...points.slice(0, i), ...left, ...points.slice(i + 2)];
                    const mergedRight = [...points.slice(0, i), ...right, ...points.slice(i + 2)];
                    const resultLeft = routeAroundLeafObstacles(mergedLeft, newObs, depth + 1);
                    const resultRight = routeAroundLeafObstacles(mergedRight, newObs, depth + 1);
                    const lenLeft = resultLeft.reduce((sum, p, j) => {
                        if (j === 0) return 0;
                        return sum + Math.abs(resultLeft[j].x - resultLeft[j - 1].x) + Math.abs(resultLeft[j].y - resultLeft[j - 1].y);
                    }, 0);
                    const lenRight = resultRight.reduce((sum, p, j) => {
                        if (j === 0) return 0;
                        return sum + Math.abs(resultRight[j].x - resultRight[j - 1].x) + Math.abs(resultRight[j].y - resultRight[j - 1].y);
                    }, 0);
                    return lenLeft <= lenRight ? resultLeft : resultRight;
                }
            }
        }
        return points;
    };

    /** Build path from ELK edge sections, using port positions for endpoints. Returns null if invalid. */
    const pathFromElkSectionsWithPorts = (
        sections: Array<{ startPoint?: { x: number; y: number }; endPoint?: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }> | undefined,
        srcX: number, srcY: number, tgtX: number, tgtY: number
    ): string | null => {
        if (!sections || sections.length === 0) return null;
        const sec = sections[0];
        if (!sec?.startPoint || !sec?.endPoint) return null;
        const bp = sec.bendPoints || [];
        const px = (x: number) => x + padding;
        const parts = ['M' + srcX + ',' + srcY];
        for (const p of bp) {
            parts.push('L' + px(p.x) + ',' + px(p.y));
        }
        parts.push('L' + tgtX + ',' + tgtY);
        return parts.join(' ');
    };

    const findPartPos = (qualifiedName: string) => {
        if (!qualifiedName) return null;
        const normalized = qualifiedName.lastIndexOf('::') >= 0
            ? qualifiedName.substring(qualifiedName.lastIndexOf('::') + 2)
            : qualifiedName;

        if (partPositions.has(normalized)) {
            return partPositions.get(normalized)!;
        }
        if (partPositions.has(qualifiedName)) {
            return partPositions.get(qualifiedName)!;
        }

        const segments = normalized.split('.');

        for (let i = segments.length - 1; i >= 1; i--) {
            const partialPath = segments.slice(0, i).join('.');
            const pos = partPositions.get(partialPath);
            if (pos) return pos;
        }

        for (let i = segments.length - 1; i >= 0; i--) {
            const pos = partPositions.get(segments[i]);
            if (pos) return pos;
        }

        return null;
    };

    const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');

    defs.append('marker')
        .attr('id', 'ibd-flow-arrow')
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 10)
        .attr('refY', 0)
        .attr('markerWidth', 8)
        .attr('markerHeight', 8)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L10,0L0,4Z')
        .style('fill', 'var(--vscode-charts-blue)');

    defs.append('marker')
        .attr('id', 'ibd-interface-arrow')
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 10)
        .attr('refY', 0)
        .attr('markerWidth', 8)
        .attr('markerHeight', 8)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4L10,0L0,4Z')
        .style('fill', 'none')
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', '1.5px');

    defs.append('marker')
        .attr('id', 'ibd-connection-dot')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 5)
        .attr('refY', 5)
        .attr('markerWidth', 5)
        .attr('markerHeight', 5)
        .append('circle')
        .attr('cx', 5)
        .attr('cy', 5)
        .attr('r', 4)
        .style('fill', 'var(--vscode-charts-blue)');

    defs.append('marker')
        .attr('id', 'ibd-port-connector')
        .attr('viewBox', '0 0 8 8')
        .attr('refX', 4)
        .attr('refY', 4)
        .attr('markerWidth', 4)
        .attr('markerHeight', 4)
        .append('rect')
        .attr('x', 1)
        .attr('y', 1)
        .attr('width', 6)
        .attr('height', 6)
        .style('fill', 'var(--vscode-charts-purple)');

    let connectorGroup = g.append('g').attr('class', 'ibd-connectors');
    let usedLabelPositions: { x: number; y: number; width: number; height: number }[] = [];
    let pendingLabels: { x: number; y: number; width: number; height: number; text: string; strokeColor: string; isItemType?: boolean }[] = [];
    const findAvailableLabelPosition = (
        anchorX: number,
        anchorY: number,
        width: number,
        height: number
    ) => {
        const candidates = [
            { x: anchorX, y: anchorY },
            { x: anchorX, y: anchorY - 24 },
            { x: anchorX, y: anchorY + 24 },
            { x: anchorX - width * 0.55, y: anchorY },
            { x: anchorX + width * 0.55, y: anchorY },
            { x: anchorX - width * 0.45, y: anchorY - 22 },
            { x: anchorX + width * 0.45, y: anchorY - 22 },
            { x: anchorX - width * 0.45, y: anchorY + 22 },
            { x: anchorX + width * 0.45, y: anchorY + 22 },
        ];
        for (const candidate of candidates) {
            const hasOverlap = usedLabelPositions.some((pos) => {
                return Math.abs(pos.x - candidate.x) < (pos.width + width) / 2 + 10 &&
                    Math.abs(pos.y - candidate.y) < (pos.height + height) / 2 + 6;
            });
            if (!hasOverlap) return candidate;
        }
        return candidates[candidates.length - 1];
    };

    function drawIbdConnectors() {
        g.selectAll('.ibd-connectors').remove();
        g.selectAll('.ibd-connector-labels').remove();

        connectorGroup = g.append('g').attr('class', 'ibd-connectors');
        usedLabelPositions = [];
        pendingLabels = [];

        const nodePairConnectors = new Map<string, { connector: any; idx: number }[]>();
        const portConnections = new Map<string, { connector: any; idx: number }[]>();

        connectors.forEach((connector: any, idx: number) => {
            const srcPos = findPartPos(connector.sourceId);
            const tgtPos = findPartPos(connector.targetId);
            if (!srcPos || !tgtPos) return;

            const srcKey = srcPos.part.name;
            const tgtKey = tgtPos.part.name;
            const pairKey = srcKey < tgtKey ? srcKey + '|' + tgtKey : tgtKey + '|' + srcKey;

            if (!nodePairConnectors.has(pairKey)) {
                nodePairConnectors.set(pairKey, []);
            }
            nodePairConnectors.get(pairKey)!.push({ connector, idx });

            const srcPortName = connector.sourceId ? connector.sourceId.split('.').pop() : null;
            const tgtPortName = connector.targetId ? connector.targetId.split('.').pop() : null;
            const portKey = srcKey + '.' + (srcPortName || 'edge') + '->' + tgtKey + '.' + (tgtPortName || 'edge');

            if (!portConnections.has(portKey)) {
                portConnections.set(portKey, []);
            }
            portConnections.get(portKey)!.push({ connector, idx });
        });

        const collectElkEdges = (node: any, acc: any[]): void => {
            if (node?.edges) acc.push(...node.edges);
            (node?.children ?? []).forEach((c: any) => collectElkEdges(c, acc));
        };
        const allElkEdges: any[] = [];
        if (elkLaidOut) collectElkEdges(elkLaidOut, allElkEdges);

        /** Leaf-node rectangles as obstacles (exclude containers). Built once per connector. */
        const getLeafObstaclesExcluding = (srcPartName: string, tgtPartName: string): Rect[] => {
            const rects: Rect[] = [];
            partPositions.forEach((pos, key) => {
                if (key !== pos.part.name) return;
                if (pos.isContainer) return;
                if (pos.part.name === srcPartName || pos.part.name === tgtPartName) return;
                rects.push({
                    x: pos.x,
                    y: pos.y,
                    width: pos.width ?? partWidth,
                    height: pos.height
                });
            });
            return rects;
        };

        const connectorOffsets = new Map<number, { offset: number; groupIndex: number; groupCount: number }>();
        nodePairConnectors.forEach((group) => {
            const count = group.length;
            const step = 36;
            group.forEach((item, i) => {
                const offset = (i - (count - 1) / 2) * step;
                connectorOffsets.set(item.idx, { offset, groupIndex: i, groupCount: count });
            });
        });
        portConnections.forEach((group) => {
            const count = group.length;
            if (count <= 1) return;
            const step = 14;
            group.forEach((item, i) => {
                const current = connectorOffsets.get(item.idx) || { offset: 0, groupIndex: i, groupCount: count };
                const localOffset = (i - (count - 1) / 2) * step;
                connectorOffsets.set(item.idx, {
                    offset: current.offset + localOffset,
                    groupIndex: i,
                    groupCount: count,
                });
            });
        });

        partPositions.forEach((pos, partName) => {
            if (partName !== pos.part.name) return;
            const part = pos.part;
            const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
            const portStartY = (part.attributes && (part.attributes.get && (part.attributes.get('partType') || part.attributes.get('type')))) ? 70 : 58;

            partPorts.forEach((p: any, i: number) => {
                const portY = pos.y + portStartY + i * 28;
                usedLabelPositions.push({ x: pos.x - 50, y: portY, width: 80, height: 20 });
                usedLabelPositions.push({ x: pos.x + (pos.width ?? partWidth) + 50, y: portY, width: 80, height: 20 });
            });
        });

        const getPortsForPart = (part: any) => ports.filter((p: any) =>
            p && (
                p.parentId === part.name ||
                p.parentId === part.id ||
                p.parentId === part.qualifiedName ||
                normalizeEndpointId(p.parentId) === normalizeEndpointId(part.qualifiedName) ||
                normalizeEndpointId(p.parentId) === normalizeEndpointId(part.name)
            )
        );

        const resolvePortForEndpoint = (part: any, endpointId: string | null): any => {
            if (!part || !endpointId) return null;
            const endpoint = normalizeEndpointId(endpointId);
            const endpointLeaf = endpoint.split('.').pop() || endpoint;
            const partPorts = getPortsForPart(part);
            return partPorts.find((p: any) => {
                const portName = normalizeEndpointId(p.name);
                const portQualifiedName = normalizeEndpointId(p.qualifiedName || p.id || '');
                return endpoint === portQualifiedName
                    || endpoint.endsWith('.' + portName)
                    || endpointLeaf === portName;
            }) ?? null;
        };

        const findPortPosition = (partPos: { x: number; y: number; part: any } | null, endpointId: string | null, oppositeX?: number) => {
            if (!partPos || !endpointId) return null;

            const part = partPos.part;
            const partNodeWidth = (partPos as { width?: number }).width ?? partWidth;
            const partPorts = getPortsForPart(part);
            const port = resolvePortForEndpoint(part, endpointId);

            if (!port) return null;

            const portDirection = getPortDirection(port);
            const isInPort = portDirection === 'in';
            const isOutPort = portDirection === 'out';

            const inPorts = partPorts.filter((p: any) => p && p.name && getPortDirection(p) === 'in');
            const outPorts = partPorts.filter((p: any) => p && p.name && getPortDirection(p) === 'out');
            const inoutPorts = partPorts.filter((p: any) => p && p.name && !inPorts.includes(p) && !outPorts.includes(p));

            const portSize = 14;
            const portSpacing = 28;
            const contentStartY = part.attributes && (part.attributes.get && (part.attributes.get('partType') || part.attributes.get('type'))) ? 50 : 38;
            const portStartY = contentStartY + 20;

            let portY: number, portX: number;

            if (isInPort) {
                const idx = inPorts.findIndex((p: any) => p.name === port.name);
                portY = partPos.y + portStartY + idx * portSpacing;
                portX = partPos.x;
            } else if (isOutPort) {
                const idx = outPorts.findIndex((p: any) => p.name === port.name);
                portY = partPos.y + portStartY + idx * portSpacing;
                portX = partPos.x + partNodeWidth;
            } else {
                const idx = inoutPorts.findIndex((p: any) => p.name === port.name);
                portY = partPos.y + portStartY + inPorts.length * portSpacing + idx * portSpacing;
                const centerX = partPos.x + partNodeWidth / 2;
                portX = typeof oppositeX === 'number' && oppositeX >= centerX ? partPos.x + partNodeWidth : partPos.x;
            }

            return { x: portX, y: portY, direction: portDirection, isLeft: portX === partPos.x };
        };

        connectors.forEach((connector: any, connIdx: number) => {
            const srcPos = findPartPos(connector.sourceId);
            const tgtPos = findPartPos(connector.targetId);

            if (!srcPos || !tgtPos) return;

            const srcEndpointId = connector.sourceId || connector.source || null;
            const tgtEndpointId = connector.targetId || connector.target || null;

            const srcPortPos = findPortPosition(srcPos, srcEndpointId, tgtPos.x + ((tgtPos.width ?? partWidth) / 2));
            const tgtPortPos = findPortPosition(tgtPos, tgtEndpointId, srcPos.x + ((srcPos.width ?? partWidth) / 2));

            const srcHeight = srcPos.height || 80;
            const tgtHeight = tgtPos.height || 80;

            const offsetInfo = connectorOffsets.get(connIdx) || { offset: 0, groupIndex: 0, groupCount: 1 };
            const baseOffset = offsetInfo.offset;
            const routeSpread = offsetInfo.groupCount > 1 ? 18 + offsetInfo.groupCount * 4 : 0;

            let srcX: number, srcY: number, tgtX: number, tgtY: number;

            if (srcPortPos) {
                srcX = srcPortPos.x;
                srcY = srcPortPos.y;
            } else {
                const srcWidth = srcPos.width ?? partWidth;
                const tgtWidth = tgtPos.width ?? partWidth;
                const srcCx = srcPos.x + srcWidth / 2;
                const tgtCx = tgtPos.x + tgtWidth / 2;
                srcX = tgtCx > srcCx ? srcPos.x + srcWidth : srcPos.x;
                srcY = srcPos.y + srcHeight / 2;
            }

            if (tgtPortPos) {
                tgtX = tgtPortPos.x;
                tgtY = tgtPortPos.y;
            } else {
                const srcWidth = srcPos.width ?? partWidth;
                const tgtWidth = tgtPos.width ?? partWidth;
                const srcCx = srcPos.x + srcWidth / 2;
                const tgtCx = tgtPos.x + tgtWidth / 2;
                tgtX = tgtCx > srcCx ? tgtPos.x : tgtPos.x + tgtWidth;
                tgtY = tgtPos.y + tgtHeight / 2;
            }

            let pathD: string;
            let labelX: number, labelY: number;
            const standoff = 40 + routeSpread;

            const elkEdge = allElkEdges.find((e: any) => e.id === 'edge-' + connIdx);
            const elkPath = elkEdge?.sections && srcPortPos && tgtPortPos
                ? pathFromElkSectionsWithPorts(elkEdge.sections, srcX, srcY, tgtX, tgtY)
                : null;

            if (elkPath) {
                pathD = elkPath;
                const sec = elkEdge?.sections?.[0];
                const bp = sec?.bendPoints || [];
                if (bp.length > 0) {
                    const mid = bp[Math.floor(bp.length / 2)];
                    labelX = mid.x + padding;
                    labelY = mid.y + padding;
                } else {
                    labelX = (srcX + tgtX) / 2;
                    labelY = (srcY + tgtY) / 2;
                }
            } else if (srcPortPos && tgtPortPos) {
                const srcIsLeft = srcPortPos.isLeft;
                const tgtIsLeft = tgtPortPos.isLeft;
                const routeXOffset = baseOffset;

                if (srcIsLeft && tgtIsLeft) {
                    const routeX = Math.min(srcPos.x, tgtPos.x) - standoff - routeXOffset;
                    pathD = 'M' + srcX + ',' + srcY +
                            ' L' + routeX + ',' + srcY +
                            ' L' + routeX + ',' + tgtY +
                            ' L' + tgtX + ',' + tgtY;
                    labelX = routeX;
                    labelY = (srcY + tgtY) / 2;
                } else if (!srcIsLeft && !tgtIsLeft) {
                    const routeX = Math.max(srcPos.x + (srcPos.width ?? partWidth), tgtPos.x + (tgtPos.width ?? partWidth)) + standoff + routeXOffset;
                    pathD = 'M' + srcX + ',' + srcY +
                            ' L' + routeX + ',' + srcY +
                            ' L' + routeX + ',' + tgtY +
                            ' L' + tgtX + ',' + tgtY;
                    labelX = routeX;
                    labelY = (srcY + tgtY) / 2;
                } else {
                    const midX = (srcX + tgtX) / 2 + routeXOffset;
                    pathD = 'M' + srcX + ',' + srcY +
                            ' L' + midX + ',' + srcY +
                            ' L' + midX + ',' + tgtY +
                            ' L' + tgtX + ',' + tgtY;
                    labelX = midX;
                    labelY = (srcY + tgtY) / 2;
                }
            } else {
                const srcWidth = srcPos.width ?? partWidth;
                const tgtWidth = tgtPos.width ?? partWidth;
                const srcCx = srcPos.x + srcWidth / 2;
                const srcCy = srcPos.y + srcHeight / 2;
                const tgtCx = tgtPos.x + tgtWidth / 2;
                const tgtCy = tgtPos.y + tgtHeight / 2;

                if (Math.abs(tgtCx - srcCx) > Math.abs(tgtCy - srcCy)) {
                    const exitX = tgtCx > srcCx ? srcPos.x + srcWidth : srcPos.x;
                    const enterX = tgtCx > srcCx ? tgtPos.x : tgtPos.x + tgtWidth;
                    const midX = (exitX + enterX) / 2 + baseOffset;
                    const y1 = srcCy + baseOffset * 0.3;
                    const y2 = tgtCy + baseOffset * 0.3;

                    pathD = 'M' + exitX + ',' + y1 +
                            ' L' + midX + ',' + y1 +
                            ' L' + midX + ',' + y2 +
                            ' L' + enterX + ',' + y2;
                    labelX = midX;
                    labelY = (y1 + y2) / 2;
                } else {
                    const exitY = tgtCy > srcCy ? srcPos.y + srcHeight : srcPos.y;
                    const enterY = tgtCy > srcCy ? tgtPos.y : tgtPos.y + tgtHeight;
                    const midY = (exitY + enterY) / 2 + baseOffset;
                    const x1 = srcCx + baseOffset * 0.3;
                    const x2 = tgtCx + baseOffset * 0.3;

                    pathD = 'M' + x1 + ',' + exitY +
                            ' L' + x1 + ',' + midY +
                            ' L' + x2 + ',' + midY +
                            ' L' + x2 + ',' + enterY;
                    labelX = (x1 + x2) / 2;
                    labelY = midY;
                }
            }

            const obstacles = getLeafObstaclesExcluding(srcPos.part.name, tgtPos.part.name);
            if (obstacles.length > 0) {
                const pts = parsePathToPoints(pathD);
                const routed = routeAroundLeafObstacles(pts, obstacles);
                if (routed.length >= 2) {
                    pathD = pointsToPathD(routed);
                    const anchor = getBestLabelAnchor(routed, labelX, labelY);
                    labelX = anchor.x;
                    labelY = anchor.y;
                }
            }

            const visualStyle = getConnectorVisualStyle(connector);
            const { strokeStyle, strokeWidth, markerStart, markerEnd, strokeColor } = visualStyle;

            const originalStroke = strokeColor;
            const originalStrokeWidth = strokeWidth;

            const connectorPath = connectorGroup.append('path')
                .attr('d', pathD)
                .attr('class', 'ibd-connector')
                .attr('data-connector-id', 'connector-' + connIdx)
                .attr('data-source', connector.sourceId || '')
                .attr('data-target', connector.targetId || '')
                .style('fill', 'none')
                .style('stroke', strokeColor)
                .style('stroke-width', strokeWidth)
                .style('stroke-dasharray', strokeStyle)
                .style('marker-start', markerStart)
                .style('marker-end', markerEnd)
                .style('cursor', 'pointer');

            connectorPath.on('click', function(event: any) {
                event.stopPropagation();
                d3.selectAll('.ibd-connector').each(function(this: any) {
                    const el = d3.select(this);
                    const origStroke = el.attr('data-original-stroke');
                    const origWidth = el.attr('data-original-width');
                    if (origStroke) {
                        el.style('stroke', origStroke)
                          .style('stroke-width', origWidth)
                          .classed('connector-highlighted', false);
                        el.attr('data-original-stroke', null)
                          .attr('data-original-width', null);
                    }
                });

                const self = d3.select(this);
                self.attr('data-original-stroke', originalStroke)
                    .attr('data-original-width', originalStrokeWidth)
                    .style('stroke', '#FFD700')
                    .style('stroke-width', '4px')
                    .classed('connector-highlighted', true);
                (this as any).parentNode.appendChild(this);

                postMessage({
                    command: 'connectorSelected',
                    source: connector.sourceId,
                    target: connector.targetId,
                    type: connector.type,
                    name: connector.name
                });
            });

            connectorPath.on('mouseenter', function(this: any) {
                const self = d3.select(this);
                if (!self.classed('connector-highlighted')) {
                    self.style('stroke-width', '3px');
                }
            });

            connectorPath.on('mouseleave', function(this: any) {
                const self = d3.select(this);
                if (!self.classed('connector-highlighted')) {
                    self.style('stroke-width', originalStrokeWidth);
                }
            });

            const label = connector.name || '';
            if (label && label !== 'connection' && label !== 'connector') {
                const displayLabel = truncateLabel(label, 20);
                const labelWidth = displayLabel.length * 7 + 20;
                const labelHeight = 20;

                const positioned = findAvailableLabelPosition(labelX, labelY, labelWidth, labelHeight);
                const finalLabelX = positioned.x;
                const finalLabelY = positioned.y;

                usedLabelPositions.push({
                    x: finalLabelX,
                    y: finalLabelY,
                    width: labelWidth,
                    height: labelHeight
                });

                const typeIndicator = visualStyle.typeIndicator;

                pendingLabels.push({
                    x: finalLabelX,
                    y: finalLabelY,
                    width: labelWidth,
                    height: labelHeight,
                    text: typeIndicator + displayLabel,
                    strokeColor: strokeColor
                });
            }

            if (visualStyle.isFlow && connector.itemType) {
                const itemWidth = connector.itemType.length * 7 + 10;
                const itemHeight = 16;
                const positioned = findAvailableLabelPosition(labelX, labelY - 28, itemWidth, itemHeight);
                usedLabelPositions.push({
                    x: positioned.x,
                    y: positioned.y,
                    width: itemWidth,
                    height: itemHeight
                });
                pendingLabels.push({
                    x: positioned.x,
                    y: positioned.y,
                    width: itemWidth,
                    height: itemHeight,
                    text: '«' + connector.itemType + '»',
                    strokeColor: 'var(--vscode-charts-green)',
                    isItemType: true
                });
            }
        });

        const labelGroup = g.append('g').attr('class', 'ibd-connector-labels');
        pendingLabels.forEach(labelData => {
            if (labelData.isItemType) {
                labelGroup.append('text')
                    .attr('x', labelData.x)
                    .attr('y', labelData.y)
                    .attr('text-anchor', 'middle')
                    .text(labelData.text)
                    .style('font-size', '9px')
                    .style('font-style', 'italic')
                    .style('fill', labelData.strokeColor);
            } else {
                labelGroup.append('rect')
                    .attr('x', labelData.x - labelData.width / 2)
                    .attr('y', labelData.y - labelData.height / 2)
                    .attr('width', labelData.width)
                    .attr('height', labelData.height)
                    .attr('rx', 4)
                    .style('fill', 'var(--vscode-editor-background)')
                    .style('stroke', labelData.strokeColor)
                    .style('stroke-width', '1px');

                labelGroup.append('text')
                    .attr('x', labelData.x)
                    .attr('y', labelData.y + 4)
                    .attr('text-anchor', 'middle')
                    .text(labelData.text)
                    .style('font-size', '10px')
                    .style('font-weight', '600')
                    .style('fill', labelData.strokeColor);
            }
        });
    }

    const partGroup = g.append('g').attr('class', 'ibd-parts');

    const drawnPartIds = new Set<string>();
    const partEntries = Array.from(partPositions.entries());
    // Draw by depth ascending so parents (root, intermediate containers) are behind children
    const byDepth = partEntries.sort((a, b) => {
        const da = (a[1] as any).depth ?? 999;
        const db = (b[1] as any).depth ?? 999;
        return da - db;
    });
    byDepth.forEach(([partName, pos]) => {
        if (partName !== pos.part.name) return;
        const partId = pos.part.id || pos.part.name;
        if (drawnPartIds.has(partId)) return;
        drawnPartIds.add(partId);

        const part = pos.part;

        if (!part || !part.name) {
            console.error('[IBD Render] Invalid part in partPositions:', part);
            return;
        }

        const typeLower = (part.type || '').toLowerCase();
        const typeColor = getTypeColor(part.type);
        const isLibValidated = isLibraryValidated(part);
        const isDefinition = typeLower.includes('def');
        const isUsage = !isDefinition;

        let typedByName: string | null = null;
        if (part.attributes && part.attributes.get) {
            typedByName = part.attributes.get('partType') || part.attributes.get('type') || part.attributes.get('typedBy');
        }
        if (!typedByName && part.partType) typedByName = part.partType;

        const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id || p.parentId === part.qualifiedName));
        const partChildren = part.children || [];

        const contentLines: string[] = [];

        const formatProperties = (obj: any) => {
            const props: string[] = [];
            if (obj.properties) {
                if (typeof obj.properties === 'object') {
                    Object.entries(obj.properties).forEach(([key, value]) => {
                        if (value !== null && value !== undefined) {
                            props.push('  :>> ' + key + ' = ' + value);
                        }
                    });
                }
            }
            if (obj.attributes) {
                if (typeof obj.attributes.forEach === 'function') {
                    obj.attributes.forEach((value: any, key: string) => {
                        if (value !== null && value !== undefined && key !== 'isRedefinition') {
                            props.push('  ' + key + ' = ' + value);
                        }
                    });
                } else if (typeof obj.attributes === 'object') {
                    Object.entries(obj.attributes).forEach(([key, value]) => {
                        if (value !== null && value !== undefined && key !== 'isRedefinition') {
                            props.push('  ' + key + ' = ' + value);
                        }
                    });
                }
            }
            return props;
        };

        partPorts.forEach((p: any) => {
            if (p && p.name) {
                contentLines.push('[port] ' + p.name);
                contentLines.push(...formatProperties(p));
                if (p.children && p.children.length > 0) {
                    p.children.forEach((child: any) => {
                        if (child.type === 'redefinition' && child.name) {
                            const value = child.attributes && child.attributes.get ?
                                child.attributes.get('value') :
                                (child.attributes && child.attributes.value);
                            if (value) {
                                contentLines.push('  :>> ' + child.name + ' = ' + value);
                            }
                        }
                    });
                }
            }
        });

        partChildren.forEach((c: any) => {
            try {
                if (!c || !c.name || !c.type) return;

                if (c.type === 'part') {
                    contentLines.push('[part] ' + c.name);
                    contentLines.push(...formatProperties(c));
                    if (c.children && c.children.length > 0) {
                        c.children.forEach((grandchild: any) => {
                            if (grandchild.type === 'redefinition' && grandchild.name) {
                                const value = grandchild.attributes && grandchild.attributes.get ?
                                    grandchild.attributes.get('value') :
                                    (grandchild.attributes && grandchild.attributes.value);
                                if (value) {
                                    contentLines.push('  :>> ' + grandchild.name + ' = ' + value);
                                }
                            }
                        });
                    }
                } else if (c.type === 'port') {
                    contentLines.push('[port] ' + c.name);
                    contentLines.push(...formatProperties(c));
                    if (c.children && c.children.length > 0) {
                        c.children.forEach((grandchild: any) => {
                            if (grandchild.type === 'redefinition' && grandchild.name) {
                                const value = grandchild.attributes && grandchild.attributes.get ?
                                    grandchild.attributes.get('value') :
                                    (grandchild.attributes && grandchild.attributes.value);
                                if (value) {
                                    contentLines.push('  :>> ' + grandchild.name + ' = ' + value);
                                }
                            }
                        });
                    }
                } else if (c.type === 'redefinition') {
                    const value = c.attributes && c.attributes.get ?
                        c.attributes.get('value') :
                        (c.attributes && c.attributes.value);
                    if (value) {
                        contentLines.push(':>> ' + c.name + ' = ' + value);
                    }
                } else if (c.type === 'attribute' || c.type === 'property') {
                    const valueStr = c.value !== undefined ? ' = ' + c.value : '';
                    contentLines.push('[attr] ' + c.name + valueStr);
                } else if (c.type === 'state') {
                    contentLines.push('[state] ' + c.name);
                }
            } catch {
                // Skip problem children silently
            }
        });

        const lineHeight = 12;
        const headerHeight = typedByName ? 50 : 38;
        const contentHeight = contentLines.length * lineHeight + 10;
        const portsHeight = partPorts.length * 16 + 10;
        const totalHeight = Math.max(80, headerHeight + contentHeight + portsHeight);
        const w = pos.width ?? partWidth;
        const h = pos.height ?? totalHeight;

        const partG = partGroup.append('g')
            .attr('transform', 'translate(' + pos.x + ',' + pos.y + ')')
            .attr('class', 'ibd-part' + (isDefinition ? ' definition-node' : ' usage-node') + (pos.isContainer ? ' ibd-container' : ''))
            .attr('data-element-name', part.name)
            .style('cursor', 'pointer');

        if (pos.isContainer) {
            const depth = (pos as { depth?: number }).depth ?? 0;
            // Intermediate containers (depth 1): distinct fill + thicker stroke so nesting is visible
            const isIntermediate = depth === 1;
            const containerFill = isIntermediate
                ? 'rgba(255,255,255,0.06)'  // lighter tint so intermediate containers stand out
                : 'var(--vscode-editor-background)';
            const containerStrokeWidth = isIntermediate ? '3px' : '2px';
            partG.append('rect')
                .attr('width', w)
                .attr('height', h)
                .attr('rx', 8)
                .attr('class', 'graph-node-background')
                .attr('data-original-stroke', typeColor)
                .attr('data-original-width', containerStrokeWidth)
                .style('fill', containerFill)
                .style('stroke', typeColor)
                .style('stroke-width', containerStrokeWidth)
                .style('stroke-dasharray', '4,4');
            partG.append('rect')
                .attr('width', w)
                .attr('height', rootHeaderHeight)
                .attr('rx', 6)
                .attr('y', 0)
                .style('fill', 'var(--vscode-button-secondaryBackground)');
            partG.append('text')
                .attr('x', w / 2)
                .attr('y', rootHeaderHeight / 2 + 4)
                .attr('text-anchor', 'middle')
                .text(part.name)
                .style('font-size', '11px')
                .style('font-weight', 'bold')
                .style('fill', 'var(--vscode-editor-foreground)');
            partG.on('click', function (event: any) {
                event.stopPropagation();
                clearVisualHighlights();
                partGroup.selectAll('.ibd-part').select('.graph-node-background, rect').each(function (this: any) {
                    const r = d3.select(this);
                    if (r.attr('data-original-stroke')) {
                        r.style('stroke', r.attr('data-original-stroke'))
                            .style('stroke-width', r.attr('data-original-width'));
                    }
                });
                partG.select('rect.graph-node-background').style('stroke', '#FFD700').style('stroke-width', '4px');
                const statusEl = document.getElementById('status-text');
                if (statusEl) statusEl.textContent = part.name + ' [' + (part.type || 'part') + ']';
            });
            return;
        }

        const _ibdStroke = isLibValidated ? GENERAL_VIEW_PALETTE.structural.part : typeColor;
        const _ibdStrokeW = isUsage ? '3px' : '2px';
        partG.append('rect')
            .attr('width', w)
            .attr('height', totalHeight)
            .attr('rx', isUsage ? 8 : 4)
            .attr('data-original-stroke', _ibdStroke)
            .attr('data-original-width', _ibdStrokeW)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', _ibdStroke)
            .style('stroke-width', _ibdStrokeW)
            .style('stroke-dasharray', isDefinition ? '6,3' : 'none');

        partG.append('rect')
            .attr('width', w)
            .attr('height', 5)
            .attr('rx', 2)
            .style('fill', typeColor);

        partG.append('rect')
            .attr('y', 5)
            .attr('width', w)
            .attr('height', typedByName ? 36 : 28)
            .style('fill', 'var(--vscode-button-secondaryBackground)');

        let stereoDisplay = part.type || 'part';
        if (typeLower.includes('part def')) stereoDisplay = 'part def';
        else if (typeLower.includes('part')) stereoDisplay = 'part';
        else if (typeLower.includes('port def')) stereoDisplay = 'port def';
        else if (typeLower.includes('action def')) stereoDisplay = 'action def';
        else if (typeLower.includes('action')) stereoDisplay = 'action';

        partG.append('text')
            .attr('x', w / 2)
            .attr('y', 17)
            .attr('text-anchor', 'middle')
            .text('«' + stereoDisplay + '»')
            .style('font-size', '9px')
            .style('fill', typeColor);

        const displayName = part.name.length > 18 ? part.name.substring(0, 16) + '..' : part.name;
        partG.append('text')
            .attr('class', 'node-name-text')
            .attr('data-element-name', part.name)
            .attr('x', w / 2)
            .attr('y', 31)
            .attr('text-anchor', 'middle')
            .text(displayName)
            .style('font-size', '11px')
            .style('font-weight', 'bold')
            .style('fill', 'var(--vscode-editor-foreground)');

        if (typedByName) {
            partG.append('text')
                .attr('x', w / 2)
                .attr('y', 43)
                .attr('text-anchor', 'middle')
                .text(': ' + (typedByName.length > 18 ? typedByName.substring(0, 16) + '..' : typedByName))
                .style('font-size', '10px')
                .style('font-style', 'italic')
                .style('fill', '#569CD6');
        }

        const contentStartY = typedByName ? 50 : 38;

        contentLines.forEach((line, i) => {
            partG.append('text')
                .attr('x', 6)
                .attr('y', contentStartY + 8 + i * lineHeight)
                .text(line.length > 28 ? line.substring(0, 26) + '..' : line)
                .style('font-size', '9px')
                .style('fill', 'var(--vscode-descriptionForeground)');
        });

        const portSize = 14;
        const portSpacing = 28;
        const portStartY = contentStartY + 20;

        const inPorts = partPorts.filter((p: any) => p && p.name && getPortDirection(p) === 'in');
        const outPorts = partPorts.filter((p: any) => p && p.name && getPortDirection(p) === 'out');
        const inoutPorts = partPorts.filter((p: any) => p && p.name && !inPorts.includes(p) && !outPorts.includes(p));

        const drawPortBadge = (
            badgeX: number,
            badgeY: number,
            label: string,
            anchor: 'start' | 'end' | 'middle',
            fillColor: string,
            typeLabel?: string | null
        ) => {
            const effectiveLabel = truncateLabel(label, 18);
            const extra = typeLabel ? ` : ${truncateLabel(typeLabel, 12)}` : '';
            const badgeText = effectiveLabel + extra;
            const widthEstimate = Math.max(54, badgeText.length * 6.4 + 14);
            const offsetX = anchor === 'end' ? -widthEstimate : (anchor === 'middle' ? -widthEstimate / 2 : 0);
            partG.append('rect')
                .attr('x', badgeX + offsetX)
                .attr('y', badgeY - 9)
                .attr('width', widthEstimate)
                .attr('height', 18)
                .attr('rx', 9)
                .style('fill', fillColor)
                .style('fill-opacity', '0.12')
                .style('stroke', fillColor)
                .style('stroke-width', '1px');
            partG.append('text')
                .attr('x', badgeX + (anchor === 'middle' ? 0 : (anchor === 'end' ? -8 : 8)))
                .attr('y', badgeY + 4)
                .attr('text-anchor', anchor)
                .text(badgeText)
                .style('font-size', '9px')
                .style('font-weight', '600')
                .style('fill', fillColor);
        };

        inPorts.forEach((p: any, i: number) => {
            const portY = portStartY + i * portSpacing;
            const portColor = getPortVisualColor('in');
            partG.append('rect')
                .attr('class', 'port-icon')
                .attr('x', -portSize/2)
                .attr('y', portY - portSize/2)
                .attr('width', portSize)
                .attr('height', portSize)
                .style('fill', portColor)
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '2px');
            partG.append('path')
                .attr('d', 'M' + (-portSize/2 + 2) + ',' + portY + ' L' + (portSize/2 - 2) + ',' + portY + ' M' + (portSize/2 - 4) + ',' + (portY - 2) + ' L' + (portSize/2 - 2) + ',' + portY + ' L' + (portSize/2 - 4) + ',' + (portY + 2))
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '1.5px')
                .style('fill', 'none');
            drawPortBadge(-portSize/2 - 12, portY, p.name, 'end', portColor, getPortTypeName(p));
        });

        outPorts.forEach((p: any, i: number) => {
            const portY = portStartY + i * portSpacing;
            const portColor = getPortVisualColor('out');
            partG.append('rect')
                .attr('class', 'port-icon')
                .attr('x', w - portSize/2)
                .attr('y', portY - portSize/2)
                .attr('width', portSize)
                .attr('height', portSize)
                .style('fill', portColor)
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '2px');
            partG.append('path')
                .attr('d', 'M' + (w - portSize/2 + 2) + ',' + portY + ' L' + (w + portSize/2 - 2) + ',' + portY + ' M' + (w + portSize/2 - 4) + ',' + (portY - 2) + ' L' + (w + portSize/2 - 2) + ',' + portY + ' L' + (w + portSize/2 - 4) + ',' + (portY + 2))
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '1.5px')
                .style('fill', 'none');
            drawPortBadge(w + portSize/2 + 12, portY, p.name, 'start', portColor, getPortTypeName(p));
        });

        const inoutStartY = portStartY + inPorts.length * portSpacing;
        inoutPorts.forEach((p: any, i: number) => {
            const portY = inoutStartY + i * portSpacing;
            const portColor = getPortVisualColor('inout');
            partG.append('rect')
                .attr('class', 'port-icon')
                .attr('x', -portSize/2)
                .attr('y', portY - portSize/2)
                .attr('width', portSize)
                .attr('height', portSize)
                .style('fill', portColor)
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '2px');
            partG.append('path')
                .attr('d', 'M' + (-portSize/2 + 3) + ',' + portY + ' L' + (portSize/2 - 3) + ',' + portY)
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '1.5px')
                .style('fill', 'none');
            partG.append('rect')
                .attr('class', 'port-icon')
                .attr('x', w - portSize/2)
                .attr('y', portY - portSize/2)
                .attr('width', portSize)
                .attr('height', portSize)
                .style('fill', portColor)
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '2px');
            partG.append('path')
                .attr('d', 'M' + (w - portSize/2 + 3) + ',' + portY + ' L' + (w + portSize/2 - 3) + ',' + portY)
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '1.5px')
                .style('fill', 'none');
            drawPortBadge(w / 2, portY - 14, p.name, 'middle', portColor, getPortTypeName(p));
        });

        partG.on('click', function(event: any) {
            event.stopPropagation();
            clearVisualHighlights();
            const clickedPart = d3.select(this);
            clickedPart.classed('highlighted-element', true);
            clickedPart.select('rect')
                .style('stroke', '#FFD700')
                .style('stroke-width', '3px');
            postJumpToElement(postMessage, { name: part.name, id: part.qualifiedName || part.id }, { skipCentering: true });
        })
        .on('dblclick', function(event: any) {
            event.stopPropagation();
            onStartInlineEdit(d3.select(this), part.name, pos.x, pos.y, w);
        });

        partG.style('cursor', 'grab');
        const ibdDrag = d3.drag()
            .on('start', function(event: any) {
                d3.select(this).raise().style('cursor', 'grabbing');
                event.sourceEvent.stopPropagation();
            })
            .on('drag', function(event: any) {
                pos.x += event.dx;
                pos.y += event.dy;
                d3.select(this).attr('transform', 'translate(' + pos.x + ',' + pos.y + ')');
                drawIbdConnectors();
            })
            .on('end', function() {
                d3.select(this).style('cursor', 'grab');
            });
        partG.call(ibdDrag);
    });

    drawIbdConnectors();
}
