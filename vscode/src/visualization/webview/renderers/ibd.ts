/**
 * IBD/Interconnection View renderer - parts, ports, connectors.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RenderContext } from '../types';
import { GENERAL_VIEW_PALETTE } from '../constants';
import { getTypeColor, isLibraryValidated } from '../shared';

declare const d3: any;

export function renderIbdView(ctx: RenderContext, data: any): void {
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

    // Layout configuration - expanded spacing for ports and connectors
    const isHorizontal = layoutDirection === 'horizontal';
    const partWidth = 280;  // Wider to fit port labels on both sides
    const padding = 140;     // More padding for port labels outside nodes
    const horizontalSpacing = 160;  // More space between nodes for connectors
    const verticalSpacing = 100;    // More vertical space for connector routing

    // Assign IDs to parts
    parts.forEach((part: any, index: number) => {
        if (!part.id) part.id = part.name || ('part-' + index);
    });

    // Helper function to calculate part height based on content
    const calculatePartHeight = (part: any) => {
        const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id));
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

    const partHeights = new Map<string, number>();
    parts.forEach((part: any) => {
        partHeights.set(part.name, calculatePartHeight(part));
        if (part.id) partHeights.set(part.id, calculatePartHeight(part));
    });

    // Build part tree from containment: roots have containerId null/absent; children have containerId === parent
    // Backend sends containerId as parent's qualifiedName (dot form); match by name, id, or qualifiedName
    type PartTreeNode = { part: any; children: PartTreeNode[] };
    const getPartChildren = (p: any) => parts.filter((c: any) =>
        c.containerId === p.name || c.containerId === p.id || c.containerId === p.qualifiedName
    );
    const buildTree = (part: any): PartTreeNode => ({
        part,
        children: getPartChildren(part).map((c: any) => buildTree(c))
    });
    const roots = parts.filter((p: any) => p.containerId == null || p.containerId === undefined || p.containerId === '');
    const rootPart = roots.length > 0
        ? roots.reduce((a, b) => (getPartChildren(a).length >= getPartChildren(b).length ? a : b))
        : parts[0];
    const partTree = rootPart ? buildTree(rootPart) : null;
    const rootName = rootPart ? rootPart.name : '';

    const partPositions = new Map<string, { x: number; y: number; part: any; height: number; width?: number; isContainer?: boolean }>();
    const innerMargin = 24;
    const rootHeaderHeight = 28;

    const relativePath = (qualifiedName: string) => {
        if (!rootName || !qualifiedName) return qualifiedName;
        const prefix = rootName + '.';
        return qualifiedName.startsWith(prefix) ? qualifiedName.slice(prefix.length) : qualifiedName;
    };

    if (partTree) {
        const placeNode = (node: PartTreeNode, baseX: number, baseY: number, depth: number): { width: number; height: number } => {
            const part = node.part;
            const h = partHeights.get(part.name) || 80;
            const setPos = (posData: { x: number; y: number; part: any; height: number; width?: number; isContainer?: boolean; depth?: number }) => {
                partPositions.set(part.name, posData);
                partPositions.set(part.id, posData);
                if (part.qualifiedName && part.qualifiedName !== part.name) {
                    partPositions.set(part.qualifiedName, posData);
                }
                const rel = relativePath(part.qualifiedName || part.name);
                if (rel && rel !== part.name) partPositions.set(rel, posData);
            };
            if (node.children.length === 0) {
                const posData = { x: baseX, y: baseY, part, height: h, width: partWidth, depth };
                setPos(posData);
                return { width: partWidth, height: h };
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
            const frameW = Math.max(partWidth, contentW);
            const frameH = rootHeaderHeight + contentH;
            const posData = { x: baseX, y: baseY, part, height: frameH, width: frameW, isContainer: true, depth };
            setPos(posData);
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
                width: partWidth,
                depth: 0
            };
            partPositions.set(part.name, posData);
            partPositions.set(part.id, posData);
            if (part.qualifiedName && part.qualifiedName !== part.name) {
                partPositions.set(part.qualifiedName, posData);
            }
        });
    }

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

    function drawIbdConnectors() {
        g.selectAll('.ibd-connectors').remove();
        g.selectAll('.ibd-connector-labels').remove();

        connectorGroup = g.insert('g', '.ibd-parts').attr('class', 'ibd-connectors');
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

        const connectorOffsets = new Map<number, { offset: number; groupIndex: number; groupCount: number }>();
        nodePairConnectors.forEach((group) => {
            const count = group.length;
            const step = 25;
            group.forEach((item, i) => {
                const offset = (i - (count - 1) / 2) * step;
                connectorOffsets.set(item.idx, { offset, groupIndex: i, groupCount: count });
            });
        });

        partPositions.forEach((pos, partName) => {
            if (partName !== pos.part.name) return;
            const part = pos.part;
            const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id));
            const portStartY = (part.attributes && (part.attributes.get && (part.attributes.get('partType') || part.attributes.get('type')))) ? 70 : 58;

            partPorts.forEach((p: any, i: number) => {
                const portY = pos.y + portStartY + i * 28;
                usedLabelPositions.push({ x: pos.x - 50, y: portY, width: 80, height: 20 });
                usedLabelPositions.push({ x: pos.x + partWidth + 50, y: portY, width: 80, height: 20 });
            });
        });

        const findPortPosition = (partPos: { x: number; y: number; part: any } | null, portName: string | null) => {
            if (!partPos || !portName) return null;

            const part = partPos.part;
            const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id));

            const portNameLower = portName.toLowerCase();
            const port = partPorts.find((p: any) => p && p.name &&
                (p.name.toLowerCase() === portNameLower || portName.toLowerCase().includes(p.name.toLowerCase())));

            if (!port) return null;

            const portDirection = port.direction || 'inout';
            const isInPort = portDirection === 'in' || (port.name && port.name.toLowerCase().includes('in'));
            const isOutPort = portDirection === 'out' || (port.name && port.name.toLowerCase().includes('out'));

            const inPorts = partPorts.filter((p: any) => p && p.name && (p.direction === 'in' || (p.name && p.name.toLowerCase().includes('in'))));
            const outPorts = partPorts.filter((p: any) => p && p.name && (p.direction === 'out' || (p.name && p.name.toLowerCase().includes('out'))));
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
                portX = partPos.x + partWidth;
            } else {
                const idx = inoutPorts.findIndex((p: any) => p.name === port.name);
                portY = partPos.y + portStartY + inPorts.length * portSpacing + idx * portSpacing;
                portX = partPos.x;
            }

            return { x: portX, y: portY, direction: portDirection, isLeft: portX === partPos.x };
        };

        connectors.forEach((connector: any, connIdx: number) => {
            const srcPos = findPartPos(connector.sourceId);
            const tgtPos = findPartPos(connector.targetId);

            if (!srcPos || !tgtPos) return;

            const srcPortName = connector.sourceId ? connector.sourceId.split('.').pop() : null;
            const tgtPortName = connector.targetId ? connector.targetId.split('.').pop() : null;

            const srcPortPos = findPortPosition(srcPos, srcPortName);
            const tgtPortPos = findPortPosition(tgtPos, tgtPortName);

            const srcHeight = srcPos.height || 80;
            const tgtHeight = tgtPos.height || 80;

            const offsetInfo = connectorOffsets.get(connIdx) || { offset: 0, groupIndex: 0, groupCount: 1 };
            const baseOffset = offsetInfo.offset;

            let srcX: number, srcY: number, tgtX: number, tgtY: number;

            if (srcPortPos) {
                srcX = srcPortPos.x;
                srcY = srcPortPos.y;
            } else {
                const srcCx = srcPos.x + partWidth / 2;
                const tgtCx = tgtPos.x + partWidth / 2;
                srcX = tgtCx > srcCx ? srcPos.x + partWidth : srcPos.x;
                srcY = srcPos.y + srcHeight / 2;
            }

            if (tgtPortPos) {
                tgtX = tgtPortPos.x;
                tgtY = tgtPortPos.y;
            } else {
                const srcCx = srcPos.x + partWidth / 2;
                const tgtCx = tgtPos.x + partWidth / 2;
                tgtX = tgtCx > srcCx ? tgtPos.x : tgtPos.x + partWidth;
                tgtY = tgtPos.y + tgtHeight / 2;
            }

            let pathD: string;
            let labelX: number, labelY: number;
            const standoff = 40;

            if (srcPortPos && tgtPortPos) {
                const srcIsLeft = srcPortPos.isLeft;
                const tgtIsLeft = tgtPortPos.isLeft;

                const offsetSrcY = srcY + baseOffset * 0.5;
                const offsetTgtY = tgtY + baseOffset * 0.5;

                if (srcIsLeft && tgtIsLeft) {
                    const routeX = Math.min(srcPos.x, tgtPos.x) - standoff - baseOffset;
                    pathD = 'M' + srcX + ',' + offsetSrcY +
                            ' L' + routeX + ',' + offsetSrcY +
                            ' L' + routeX + ',' + offsetTgtY +
                            ' L' + tgtX + ',' + offsetTgtY;
                    labelX = routeX;
                    labelY = (offsetSrcY + offsetTgtY) / 2;
                } else if (!srcIsLeft && !tgtIsLeft) {
                    const routeX = Math.max(srcPos.x + partWidth, tgtPos.x + partWidth) + standoff + baseOffset;
                    pathD = 'M' + srcX + ',' + offsetSrcY +
                            ' L' + routeX + ',' + offsetSrcY +
                            ' L' + routeX + ',' + offsetTgtY +
                            ' L' + tgtX + ',' + offsetTgtY;
                    labelX = routeX;
                    labelY = (offsetSrcY + offsetTgtY) / 2;
                } else {
                    const midX = (srcX + tgtX) / 2 + baseOffset;
                    pathD = 'M' + srcX + ',' + offsetSrcY +
                            ' L' + midX + ',' + offsetSrcY +
                            ' L' + midX + ',' + offsetTgtY +
                            ' L' + tgtX + ',' + offsetTgtY;
                    labelX = midX;
                    labelY = (offsetSrcY + offsetTgtY) / 2;
                }
            } else {
                const srcCx = srcPos.x + partWidth / 2;
                const srcCy = srcPos.y + srcHeight / 2;
                const tgtCx = tgtPos.x + partWidth / 2;
                const tgtCy = tgtPos.y + tgtHeight / 2;

                if (Math.abs(tgtCx - srcCx) > Math.abs(tgtCy - srcCy)) {
                    const exitX = tgtCx > srcCx ? srcPos.x + partWidth : srcPos.x;
                    const enterX = tgtCx > srcCx ? tgtPos.x : tgtPos.x + partWidth;
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

            const connTypeLower = (connector.type || '').toLowerCase();
            const connNameLower = (connector.name || '').toLowerCase();
            const isFlow = connTypeLower === 'flow' || connNameLower.includes('flow');
            const isInterface = connTypeLower === 'interface' || connNameLower.includes('interface');
            const isBinding = connTypeLower === 'binding' || connNameLower.includes('bind');

            let strokeStyle = 'none';
            let strokeWidth = '2px';
            let markerStart = 'none';
            let markerEnd = 'none';
            let strokeColor = 'var(--vscode-charts-blue)';

            if (isFlow) {
                markerEnd = 'url(#ibd-flow-arrow)';
                strokeColor = 'var(--vscode-charts-green)';
            } else if (isInterface) {
                markerEnd = 'url(#ibd-interface-arrow)';
                strokeColor = 'var(--vscode-charts-purple)';
            } else if (isBinding) {
                strokeStyle = '6,4';
                strokeWidth = '1.5px';
                markerStart = 'url(#ibd-connection-dot)';
                markerEnd = 'url(#ibd-connection-dot)';
            } else {
                markerStart = 'url(#ibd-connection-dot)';
                markerEnd = 'url(#ibd-connection-dot)';
            }

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
                const displayLabel = label.length > 20 ? label.substring(0, 18) + '..' : label;
                const labelWidth = displayLabel.length * 7 + 20;
                const labelHeight = 20;

                let finalLabelX = labelX;
                let finalLabelY = labelY;
                let attempts = 0;
                const maxAttempts = 8;
                const offsets = [0, -25, 25, -50, 50, -75, 75, -100];

                while (attempts < maxAttempts) {
                    const testY = labelY + offsets[attempts];
                    const hasOverlap = usedLabelPositions.some(pos => {
                        return Math.abs(pos.x - labelX) < (pos.width + labelWidth) / 2 + 10 &&
                               Math.abs(pos.y - testY) < (pos.height + labelHeight) / 2 + 5;
                    });

                    if (!hasOverlap) {
                        finalLabelY = testY;
                        break;
                    }
                    attempts++;
                }

                usedLabelPositions.push({
                    x: finalLabelX,
                    y: finalLabelY,
                    width: labelWidth,
                    height: labelHeight
                });

                const isConnection = connTypeLower === 'connection' || connTypeLower === 'connect';
                const typeIndicator = isFlow ? '→ ' : (isInterface ? '⟨⟩ ' : (isBinding ? '≡ ' : (isConnection ? '⊞ ' : '')));

                pendingLabels.push({
                    x: finalLabelX,
                    y: finalLabelY,
                    width: labelWidth,
                    height: labelHeight,
                    text: typeIndicator + displayLabel,
                    strokeColor: strokeColor
                });
            }

            if (isFlow && connector.itemType) {
                pendingLabels.push({
                    x: labelX,
                    y: labelY - 28,
                    width: connector.itemType.length * 7 + 10,
                    height: 16,
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

    drawIbdConnectors();

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

        const partPorts = ports.filter((p: any) => p && (p.parentId === part.name || p.parentId === part.id));
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
            .attr('width', partWidth)
            .attr('height', totalHeight)
            .attr('rx', isUsage ? 8 : 4)
            .attr('data-original-stroke', _ibdStroke)
            .attr('data-original-width', _ibdStrokeW)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', _ibdStroke)
            .style('stroke-width', _ibdStrokeW)
            .style('stroke-dasharray', isDefinition ? '6,3' : 'none');

        partG.append('rect')
            .attr('width', partWidth)
            .attr('height', 5)
            .attr('rx', 2)
            .style('fill', typeColor);

        partG.append('rect')
            .attr('y', 5)
            .attr('width', partWidth)
            .attr('height', typedByName ? 36 : 28)
            .style('fill', 'var(--vscode-button-secondaryBackground)');

        let stereoDisplay = part.type || 'part';
        if (typeLower.includes('part def')) stereoDisplay = 'part def';
        else if (typeLower.includes('part')) stereoDisplay = 'part';
        else if (typeLower.includes('port def')) stereoDisplay = 'port def';
        else if (typeLower.includes('action def')) stereoDisplay = 'action def';
        else if (typeLower.includes('action')) stereoDisplay = 'action';

        partG.append('text')
            .attr('x', partWidth / 2)
            .attr('y', 17)
            .attr('text-anchor', 'middle')
            .text('«' + stereoDisplay + '»')
            .style('font-size', '9px')
            .style('fill', typeColor);

        const displayName = part.name.length > 18 ? part.name.substring(0, 16) + '..' : part.name;
        partG.append('text')
            .attr('class', 'node-name-text')
            .attr('data-element-name', part.name)
            .attr('x', partWidth / 2)
            .attr('y', 31)
            .attr('text-anchor', 'middle')
            .text(displayName)
            .style('font-size', '11px')
            .style('font-weight', 'bold')
            .style('fill', 'var(--vscode-editor-foreground)');

        if (typedByName) {
            partG.append('text')
                .attr('x', partWidth / 2)
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

        const inPorts = partPorts.filter((p: any) => p && p.name && (p.direction === 'in' || (p.name && p.name.toLowerCase().includes('in'))));
        const outPorts = partPorts.filter((p: any) => p && p.name && (p.direction === 'out' || (p.name && p.name.toLowerCase().includes('out'))));
        const inoutPorts = partPorts.filter((p: any) => p && p.name && !inPorts.includes(p) && !outPorts.includes(p));

        inPorts.forEach((p: any, i: number) => {
            const portY = portStartY + i * portSpacing;
            const portColor = GENERAL_VIEW_PALETTE.structural.port;
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
            const portLabel = p.name.length > 14 ? p.name.substring(0, 12) + '..' : p.name;
            partG.append('text')
                .attr('x', -portSize/2 - 10)
                .attr('y', portY + 4)
                .attr('text-anchor', 'end')
                .text(portLabel)
                .style('font-size', '10px')
                .style('font-weight', '500')
                .style('fill', portColor);
        });

        outPorts.forEach((p: any, i: number) => {
            const portY = portStartY + i * portSpacing;
            const portColor = GENERAL_VIEW_PALETTE.structural.part;
            partG.append('rect')
                .attr('class', 'port-icon')
                .attr('x', partWidth - portSize/2)
                .attr('y', portY - portSize/2)
                .attr('width', portSize)
                .attr('height', portSize)
                .style('fill', portColor)
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '2px');
            partG.append('path')
                .attr('d', 'M' + (partWidth - portSize/2 + 2) + ',' + portY + ' L' + (partWidth + portSize/2 - 2) + ',' + portY + ' M' + (partWidth + portSize/2 - 4) + ',' + (portY - 2) + ' L' + (partWidth + portSize/2 - 2) + ',' + portY + ' L' + (partWidth + portSize/2 - 4) + ',' + (portY + 2))
                .style('stroke', 'var(--vscode-editor-background)')
                .style('stroke-width', '1.5px')
                .style('fill', 'none');
            const portLabel = p.name.length > 14 ? p.name.substring(0, 12) + '..' : p.name;
            partG.append('text')
                .attr('x', partWidth + portSize/2 + 10)
                .attr('y', portY + 4)
                .attr('text-anchor', 'start')
                .text(portLabel)
                .style('font-size', '10px')
                .style('font-weight', '500')
                .style('fill', portColor);
        });

        const inoutStartY = portStartY + inPorts.length * portSpacing;
        inoutPorts.forEach((p: any, i: number) => {
            const portY = inoutStartY + i * portSpacing;
            const portColor = GENERAL_VIEW_PALETTE.structural.attribute;
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
            const portLabel = p.name.length > 14 ? p.name.substring(0, 12) + '..' : p.name;
            partG.append('text')
                .attr('x', -portSize/2 - 10)
                .attr('y', portY + 4)
                .attr('text-anchor', 'end')
                .text(portLabel)
                .style('font-size', '10px')
                .style('font-weight', '500')
                .style('fill', portColor);
        });

        partG.on('click', function(event: any) {
            event.stopPropagation();
            clearVisualHighlights();
            const clickedPart = d3.select(this);
            clickedPart.classed('highlighted-element', true);
            clickedPart.select('rect')
                .style('stroke', '#FFD700')
                .style('stroke-width', '3px');
            postMessage({ command: 'jumpToElement', elementName: part.name, skipCentering: true });
        })
        .on('dblclick', function(event: any) {
            event.stopPropagation();
            onStartInlineEdit(d3.select(this), part.name, pos.x, pos.y, partWidth);
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
}
