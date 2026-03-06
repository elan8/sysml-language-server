/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ELK and SysML visualization renderers.
 * Extracted from legacyBundle - uses ElkContext for all external dependencies.
 */

declare const cytoscape: any;
declare const d3: any;

import { MIN_SYSML_ZOOM, MAX_SYSML_ZOOM, GENERAL_VIEW_PALETTE } from './constants';
import { getTypeColor } from './shared';

export interface ElkContext {
    elkWorkerUrl: string;
    getCy: () => any;
    setCy: (cy: any) => void;
    getSvg: () => any;
    getG: () => any;
    buildSysMLGraph: (elements: any[], relationships?: any[], useHierarchicalNesting?: boolean) => { elements: any[]; stats: Record<string, number> };
    setSysMLToolbarVisible: (visible: boolean) => void;
    renderPillarChips: (stats?: Record<string, number>) => void;
    setLastPillarStats: (stats: Record<string, number>) => void;
    getSysMLStyles: () => any[];
    runSysMLLayout: (fit?: boolean) => void;
    updatePillarVisibility: () => void;
    togglePillarExpansion: (pillarId: string) => void;
    centerOnNode: (node: any, padding?: number) => void;
    isSequentialBehaviorContext: () => boolean;
    updateMinimap: () => void;
    postMessage: (msg: unknown) => void;
    SYSML_PILLARS: Array<{ id: string; label: string }>;
    PILLAR_COLOR_MAP: Record<string, string>;
    sysmlMode: string;
    getCategoryForType: (typeLower: string) => string;
    expandedGeneralCategories: Set<string>;
    GENERAL_VIEW_CATEGORIES: Array<{ id: string; label: string; keywords: string[]; color: string }>;
    renderGeneralChips: (typeStats: Record<string, number>) => void;
    reRenderElk: () => void;
    showCategoryHeaders: boolean;
    selectedDiagramIndex: number;
    currentData: any;
    clearVisualHighlights: () => void;
    renderPlaceholder: (width: number, height: number, viewName: string, message: string, data: any) => void;
    isLibraryValidated: (element: any) => boolean;
    getLibraryKind: (element: any) => string | null;
    getLibraryChain: (element: any) => string | null;
    onStartInlineEdit: (nodeG: any, elementName: string, x: number, y: number, width: number) => void;
}

export function renderSysMLView(ctx: ElkContext, width: number, height: number, data: any): void {
    ctx.setSysMLToolbarVisible(true);
    const container = document.getElementById('visualization');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    const cyContainer = document.createElement('div');
    cyContainer.id = 'sysml-cytoscape';
    cyContainer.style.width = '100%';
    cyContainer.style.height = '100%';
    cyContainer.style.position = 'absolute';
    cyContainer.style.top = '0';
    cyContainer.style.left = '0';
    container.appendChild(cyContainer);

    const useHierarchicalNesting = ctx.sysmlMode === 'hierarchy';
    const graph = ctx.buildSysMLGraph(data.elements || [], data.relationships || [], useHierarchicalNesting);

    ctx.setLastPillarStats(graph.stats);
    ctx.renderPillarChips(graph.stats);

    const existingCy = ctx.getCy();
    if (existingCy) {
        existingCy.destroy();
    }

    const cy = cytoscape({
        container: cyContainer,
        elements: graph.elements,
        style: ctx.getSysMLStyles(),
        minZoom: MIN_SYSML_ZOOM,
        maxZoom: MAX_SYSML_ZOOM,
        wheelSensitivity: 0.2,
        boxSelectionEnabled: false,
        autounselectify: true
    });

    ctx.setCy(cy);

    cy.on('zoom', () => {
        (window as any).userHasManuallyZoomed = true;
        ctx.updateMinimap();
    });

    cy.on('pan', () => {
        ctx.updateMinimap();
    });

    let tapTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastTapped: string | null = null;

    cy.on('tap', 'node[type = "pillar"]', (event: any) => {
        const id = event.target.data('pillar');
        ctx.togglePillarExpansion(id);
    });

    cy.on('tap', 'node[type = "element"]', (event: any) => {
        const node = event.target;
        cy.elements().removeClass('highlighted-sysml');
        node.addClass('highlighted-sysml');

        const pillarLabel = ctx.SYSML_PILLARS.find((p: any) => p.id === node.data('pillar'))?.label || 'Element';
        const statusEl = document.getElementById('status-text');
        if (statusEl) statusEl.textContent = pillarLabel + ': ' + node.data('label') + ' [' + node.data('sysmlType') + ']';

        ctx.centerOnNode(node);

        if (tapTimeout && lastTapped === node.id()) {
            clearTimeout(tapTimeout);
            tapTimeout = null;
            lastTapped = null;
            const elementNameToJump = node.data('elementName');
            ctx.postMessage({
                command: 'jumpToElement',
                elementName: elementNameToJump
            });
        } else {
            lastTapped = node.id();
            tapTimeout = setTimeout(() => {
                tapTimeout = null;
                lastTapped = null;
            }, 250);
        }
    });

    ctx.updatePillarVisibility();

    cy.resize();
    cy.forceRender();

    setTimeout(() => {
        ctx.runSysMLLayout(true);
        if (!ctx.isSequentialBehaviorContext()) {
            const statusEl = document.getElementById('status-text');
            if (statusEl) statusEl.textContent = 'SysML Pillar View • Tap a pillar to expand/collapse';
        }
    }, 100);
}

export function renderSimpleElkFallback(ctx: ElkContext, width: number, height: number): void {
    const g = ctx.getG();
    if (!g) return;
    g.append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .text('ELK Layout Engine not available - please refresh')
        .style('font-size', '16px')
        .style('fill', 'var(--vscode-errorForeground)');
}

export async function renderElkTreeView(ctx: ElkContext, width: number, height: number, data: any): Promise<void> {
    const svg = ctx.getSvg();
    const g = ctx.getG();
    if (!svg || !g) return;

    try {
        let elementsData = (data && data.elements) ? data.elements : (ctx.currentData ? ctx.currentData.elements : null);

        if (ctx.selectedDiagramIndex > 0 && elementsData) {
            const packagesArray: Array<{ name: string; element: any }> = [];
            const seenPackages = new Set<string>();

            function findPackagesForFilter(elementList: any[], depth = 0) {
                elementList.forEach((el: any) => {
                    const typeLower = (el.type || '').toLowerCase();
                    if (typeLower.includes('package') && depth <= 3 && !seenPackages.has(el.name)) {
                        seenPackages.add(el.name);
                        packagesArray.push({ name: el.name, element: el });
                    }
                    if (el.children && el.children.length > 0) {
                        findPackagesForFilter(el.children, depth + 1);
                    }
                });
            }

            findPackagesForFilter(elementsData);

            const selectedPackageIdx = ctx.selectedDiagramIndex - 1;
            if (selectedPackageIdx >= 0 && selectedPackageIdx < packagesArray.length) {
                const selectedPackage = packagesArray[selectedPackageIdx];
                if (selectedPackage.element) {
                    elementsData = [selectedPackage.element];
                }
            }
        }

        if (!elementsData || elementsData.length === 0) {
            ctx.renderPlaceholder(width, height, 'General View',
                'No elements to display.\\n\\nThe parser did not return any elements.',
                ctx.currentData);
            return;
        }

        const PACKAGE_TYPES = new Set(['package', 'library package', 'standard library package']);
        const topLevelElements: any[] = [];
        const elementMap = new Map<string, any>();
        const portToOwner = new Map<string, string>();
        const defElements = new Map<string, any>();
        const partToDefLinks: Array<{ source: any; target: string; type: string }> = [];
        const childAttributeNames = new Set<string>();
        const childPortNames = new Set<string>();

        function collectChildAttributesAndPorts(elements: any) {
            if (!elements || !Array.isArray(elements)) return;
            elements.forEach((el: any) => {
                if (!el) return;
                if (el.children && el.children.length > 0) {
                    el.children.forEach((child: any) => {
                        if (!child || !child.name) return;
                        const cType = (child.type || '').toLowerCase();
                        if (cType === 'attribute' || cType.includes('attribute')) childAttributeNames.add(child.name);
                        if (cType === 'port' || cType.includes('port')) childPortNames.add(child.name);
                    });
                }
                if (el.children) collectChildAttributesAndPorts(el.children);
            });
        }

        function findTopLevelElements(elements: any, depth: number) {
            if (!elements || !Array.isArray(elements)) return;
            elements.forEach((el: any) => {
                if (!el || !el.name) return;
                const typeLower = (el.type || '').toLowerCase().trim();

                if (PACKAGE_TYPES.has(typeLower) || typeLower.includes('package')) {
                    if (el.children) findTopLevelElements(el.children, depth);
                    return;
                }
                if ((typeLower === 'attribute' || typeLower.includes('attribute')) && childAttributeNames.has(el.name)) return;
                if ((typeLower === 'port' || typeLower.includes('port')) && childPortNames.has(el.name)) return;

                const category = ctx.getCategoryForType(typeLower);
                if (!ctx.expandedGeneralCategories.has(category)) {
                    if (el.children) findTopLevelElements(el.children, depth + 1);
                    return;
                }

                topLevelElements.push(el);
                elementMap.set(el.name, el);
                if (typeLower.includes('def')) defElements.set(el.name, el);
                if (el.children) findTopLevelElements(el.children, depth + 1);
            });
        }

        function collectPartToDefLinks(elements: any, parentElement: string | null) {
            if (!elements) return;
            elements.forEach((el: any) => {
                if (!el || !el.name) return;
                const typeLower = (el.type || '').toLowerCase().trim();

                if (PACKAGE_TYPES.has(typeLower) || typeLower.includes('package')) {
                    if (el.children) collectPartToDefLinks(el.children, null);
                    return;
                }

                const isPartDef = typeLower.includes('part') && typeLower.includes('def');
                const isPartUsage = typeLower.includes('part') && !typeLower.includes('def');
                const isRequirementDef = typeLower.includes('requirement') && typeLower.includes('def');
                const isRequirementUsage = typeLower.includes('requirement') && !typeLower.includes('def');
                const isDefElement = isPartDef || isRequirementDef;
                const isUsageElement = isPartUsage || isRequirementUsage;

                if (parentElement && isUsageElement) {
                    partToDefLinks.push({ source: parentElement, target: el.name, type: 'contains' });
                }
                if (el.relationships) {
                    el.relationships.forEach((rel: any) => {
                        if (rel.type === 'specializes' && rel.target) {
                            partToDefLinks.push({ source: el.name, target: rel.target, type: 'specializes' });
                        }
                    });
                }

                let partTypes: string[] = [];
                if (el.typings && el.typings.length > 0) {
                    partTypes = el.typings.map((t: string) => t.replace(/^:/, '').trim()).filter(Boolean);
                } else {
                    let partType: string | null = null;
                    if (el.attributes && el.attributes.get) {
                        partType = el.attributes.get('partType') || el.attributes.get('type') || el.attributes.get('typedBy');
                    }
                    if (!partType && el.partType) partType = el.partType;
                    if (!partType && el.typing) partType = el.typing.replace(/^:/, '').trim();
                    if (!partType && el.fullText) {
                        const typeMatch = el.fullText.match(/:\s*([A-Z][a-zA-Z0-9_]*)/);
                        if (typeMatch) partType = typeMatch[1];
                    }
                    if (partType) {
                        partTypes = partType.split(',').map((t: string) => t.trim()).filter(Boolean);
                    }
                }
                if (partTypes.length > 0 && !typeLower.includes('def')) {
                    partTypes.forEach((pt: string) => {
                        partToDefLinks.push({ source: el.name, target: pt, type: 'typed by' });
                    });
                }
                const nextParent = (isDefElement || isUsageElement) ? el.name : parentElement;
                if (el.children) collectPartToDefLinks(el.children, nextParent);
            });
        }

        const typeStats: Record<string, number> = {};
        function calculateTypeStats(elements: any) {
            if (!elements) return;
            elements.forEach((el: any) => {
                if (!el || !el.type) return;
                const typeLower = (el.type || '').toLowerCase().trim();
                if (PACKAGE_TYPES.has(typeLower) || typeLower.includes('package')) {
                    if (el.children) calculateTypeStats(el.children);
                    return;
                }
                const category = ctx.getCategoryForType(typeLower);
                typeStats[category] = (typeStats[category] || 0) + 1;
                if (el.children) calculateTypeStats(el.children);
            });
        }
        calculateTypeStats(elementsData);
        ctx.renderGeneralChips(typeStats);
        collectChildAttributesAndPorts(elementsData);
        findTopLevelElements(elementsData, 0);
        collectPartToDefLinks(elementsData, null);

        if (topLevelElements.length === 0) {
            ctx.renderPlaceholder(width, height, 'General View',
                'No matching elements to display.\\n\\nTry enabling more categories using the filter chips above.',
                ctx.currentData);
            return;
        }

        const elementCount = topLevelElements.length;
        const nodeWidth = 150;
        const nodeBaseHeight = 44;
        const lineHeight = 13;
        const sectionGap = 5;
        const padding = 24;
        const hSpacing = elementCount > 25 ? 40 : 34;
        const vSpacing = elementCount > 25 ? 36 : 32;

        function truncateText(text: string, maxChars: number) {
            if (!text) return '';
            if (text.length <= maxChars) return text;
            return text.substring(0, maxChars - 2) + '..';
        }

        function collectNodeContent(el: any) {
            const sections: Array<{ title: string; lines: any[] }> = [];
            const attrLines: any[] = [];
            const portLines: any[] = [];
            const partLines: any[] = [];
            const actionLines: any[] = [];
            const otherLines: any[] = [];
            const docLines: any[] = [];
            const subjectLines: any[] = [];
            const stakeholderLines: any[] = [];
            const constraintLines: any[] = [];

            const typeLower = (el.type || '').toLowerCase();
            const isRequirement = typeLower.includes('requirement');

            let doc: string | null = null;
            if (el.attributes) {
                if (typeof el.attributes.get === 'function') {
                    doc = el.attributes.get('doc') || el.attributes.get('documentation') || el.attributes.get('text');
                } else {
                    doc = el.attributes.doc || el.attributes.documentation || el.attributes.text;
                }
            }
            if (!doc && el.documentation) doc = el.documentation;
            if (!doc && el.text) doc = el.text;

            if (!doc && el.children && el.children.length > 0) {
                for (let i = 0; i < el.children.length; i++) {
                    const child = el.children[i];
                    if (child && child.type && child.type.toLowerCase() === 'doc') {
                        if (child.attributes) {
                            if (typeof child.attributes.get === 'function') {
                                doc = child.attributes.get('content');
                            } else {
                                doc = child.attributes.content;
                            }
                        }
                        if (!doc) {
                            doc = child.fullText || child.name || '';
                            if (doc && doc.includes('/*')) {
                                const startIdx = doc.indexOf('/*');
                                const endIdx = doc.indexOf('*/');
                                if (startIdx >= 0 && endIdx > startIdx) {
                                    doc = doc.substring(startIdx + 2, endIdx).trim();
                                }
                            }
                        }
                        if (doc) break;
                    }
                }
            }

            if (doc && typeof doc === 'string') {
                const cleanDoc = doc.split('/*').join('').split('*/').join('').trim();
                if (cleanDoc.length > 0) {
                    docLines.push({ type: 'doc', text: cleanDoc, rawDoc: true });
                }
            }

            if (el.children && el.children.length > 0) {
                el.children.forEach((child: any) => {
                    if (!child || !child.name) return;
                    const cType = (child.type || '').toLowerCase();
                    if (cType.includes('state') || cType.includes('package') || cType === 'doc') return;

                    if (isRequirement) {
                        if (cType === 'subject' || cType.includes('subject') || child.name === 'subject' || (child.attributes && child.attributes.get && child.attributes.get('isSubject'))) {
                            let subjectType = child.typing || (child.attributes && child.attributes.get ? child.attributes.get('type') || child.attributes.get('typedBy') : '');
                            if (subjectType) subjectType = subjectType.replace(/^[:~]+/, '').trim();
                            subjectLines.push({ type: 'subject', text: '👤 ' + child.name + (subjectType ? ' : ' + subjectType : '') });
                            return;
                        }
                        if (cType === 'stakeholder' || cType.includes('stakeholder')) {
                            let stakeholderType = child.typing || (child.attributes && child.attributes.get ? child.attributes.get('type') || child.attributes.get('typedBy') : '');
                            if (stakeholderType) stakeholderType = stakeholderType.replace(/^[:~]+/, '').trim();
                            stakeholderLines.push({ type: 'stakeholder', text: '🏢 ' + child.name + (stakeholderType ? ' : ' + stakeholderType : ''), stakeholderType });
                            return;
                        }
                        if (cType.includes('constraint') || cType === 'require constraint' || cType === 'assume constraint' || cType === 'require') {
                            const constraintExpr = child.attributes && child.attributes.get ? child.attributes.get('expression') || child.attributes.get('constraint') : '';
                            const constraintText = child.name || constraintExpr || 'constraint';
                            constraintLines.push({ type: 'constraint', text: '⚙ ' + constraintText });
                            return;
                        }
                    }

                    if (cType === 'attribute' || cType.includes('attribute')) {
                        const dataType = child.attributes && child.attributes.get ? child.attributes.get('dataType') : null;
                        const typeStr = dataType ? ' : ' + dataType.split('::').pop() : '';
                        attrLines.push({ type: 'attr', text: '◆ ' + child.name + typeStr });
                    } else if (cType === 'port' || cType.includes('port')) {
                        const portType = child.attributes && child.attributes.get ? child.attributes.get('portType') : null;
                        const pTypeStr = portType ? ' : ' + portType : '';
                        portLines.push({ type: 'port', name: child.name, text: '▢ ' + child.name + pTypeStr });
                        portToOwner.set(child.name, el.name);
                    } else if (cType.includes('part')) {
                        const partType = child.type ? child.type.split(' ').pop() : '';
                        partLines.push({ type: 'part', text: '■ ' + child.name + (partType ? ' : ' + partType : '') });
                    } else if (cType.includes('action')) {
                        actionLines.push({ type: 'action', text: '▶ ' + child.name });
                    } else if (cType.includes('requirement')) {
                        otherLines.push({ type: 'req', text: '✓ ' + child.name });
                    } else if (cType.includes('interface') || cType.includes('connect')) {
                        otherLines.push({ type: 'conn', text: '↔ ' + child.name });
                    } else if (cType.includes('constraint')) {
                        constraintLines.push({ type: 'constraint', text: '⚙ ' + child.name });
                    }
                });
            }

            if (el.ports && el.ports.length > 0) {
                el.ports.forEach((p: any) => {
                    const pName = typeof p === 'string' ? p : (p.name || 'port');
                    if (!portLines.some((pl: any) => pl.name === pName)) {
                        const pType = (typeof p === 'object' && p.portType) ? ' : ' + p.portType : '';
                        portLines.push({ type: 'port', name: pName, text: '▢ ' + pName + pType });
                        portToOwner.set(pName, el.name);
                    }
                });
            }

            if (isRequirement) {
                if (docLines.length > 0) sections.push({ title: 'Documentation', lines: docLines.slice(0, 6) });
                if (subjectLines.length > 0) sections.push({ title: 'Subject', lines: subjectLines.slice(0, 3) });
                if (stakeholderLines.length > 0) sections.push({ title: 'Stakeholder', lines: stakeholderLines.slice(0, 3) });
                if (attrLines.length > 0) sections.push({ title: 'Attributes', lines: attrLines.slice(0, 8) });
                if (constraintLines.length > 0) sections.push({ title: 'Constraints', lines: constraintLines.slice(0, 4) });
                if (otherLines.length > 0) sections.push({ title: 'Nested Reqs', lines: otherLines.slice(0, 4) });
            } else {
                if (docLines.length > 0) sections.push({ title: 'Doc', lines: docLines.slice(0, 4) });
                if (attrLines.length > 0) sections.push({ title: 'Attributes', lines: attrLines.slice(0, 12) });
                if (partLines.length > 0) sections.push({ title: 'Parts', lines: partLines.slice(0, 10) });
                if (actionLines.length > 0) sections.push({ title: 'Actions', lines: actionLines.slice(0, 6) });
                if (constraintLines.length > 0) sections.push({ title: 'Constraints', lines: constraintLines.slice(0, 3) });
                if (otherLines.length > 0) sections.push({ title: 'Other', lines: otherLines.slice(0, 4) });
            }
            return sections;
        }

        const nodePositions = new Map<string, any>();
        const portPositions = new Map<string, any>();

        const availableWidth = width - padding * 2;
        const maxColsByWidth = Math.max(4, Math.floor((availableWidth + hSpacing) / (nodeWidth + hSpacing)));
        const cols = Math.max(4, Math.min(maxColsByWidth, topLevelElements.length));

        const nodeData = topLevelElements.map((el: any, index: number) => {
            const sections = collectNodeContent(el);
            let totalLines = 0;
            const lineMaxChars = Math.floor((nodeWidth - 20) / 5);
            sections.forEach((s: any) => {
                totalLines += 1;
                s.lines.forEach((line: any) => {
                    if (line.rawDoc && line.type === 'doc') {
                        const estimatedLines = Math.ceil(line.text.length / (lineMaxChars - 3));
                        const maxDocLines = s.title === 'Documentation' ? 6 : 4;
                        totalLines += Math.min(estimatedLines, maxDocLines);
                    } else {
                        totalLines += 1;
                    }
                });
            });
            const nodeHeight = Math.max(60, nodeBaseHeight + totalLines * lineHeight + sections.length * sectionGap);
            const typeLower = (el.type || '').toLowerCase();
            const category = ctx.getCategoryForType(typeLower);
            return { el, sections, height: nodeHeight, index, category };
        });

        const categoryOrder = ctx.GENERAL_VIEW_CATEGORIES.map((c: any) => c.id);
        const groupedNodes: Record<string, typeof nodeData> = {};
        categoryOrder.forEach((catId: string) => { groupedNodes[catId] = []; });
        nodeData.forEach((nd: any) => {
            if (!groupedNodes[nd.category]) groupedNodes[nd.category] = [];
            groupedNodes[nd.category].push(nd);
        });

        const categoryStartPositions = new Map<string, { y: number; count: number }>();
        let currentY = padding;
        const groupSpacing = ctx.showCategoryHeaders ? 65 : 45;
        const categoryLabelHeight = ctx.showCategoryHeaders ? 28 : 0;

        categoryOrder.forEach((catId: string) => {
            const group = groupedNodes[catId];
            if (!group || group.length === 0) return;

            categoryStartPositions.set(catId, { y: currentY, count: group.length });
            currentY += categoryLabelHeight;

            const groupRowHeights: number[] = [];
            for (let i = 0; i < group.length; i += cols) {
                const rowNodes = group.slice(i, Math.min(i + cols, group.length));
                groupRowHeights.push(Math.max(...rowNodes.map((n: any) => n.height)));
            }

            group.forEach((nd: any, idx: number) => {
                const col = idx % cols;
                const row = Math.floor(idx / cols);
                let y = currentY;
                for (let r = 0; r < row; r++) {
                    y += groupRowHeights[r] + vSpacing;
                }
                nodePositions.set(nd.el.name, {
                    x: padding + col * (nodeWidth + hSpacing),
                    y,
                    width: nodeWidth,
                    height: nd.height,
                    element: nd.el,
                    sections: nd.sections,
                    category: nd.category
                });
            });

            let totalGroupHeight = 0;
            groupRowHeights.forEach((h: number) => { totalGroupHeight += h + vSpacing; });
            currentY += totalGroupHeight + groupSpacing;
        });

        const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');
        defs.selectAll('#general-node-shadow').remove();
        defs.append('filter').attr('id', 'general-node-shadow').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%')
            .append('feDropShadow').attr('dx', 0).attr('dy', 1).attr('stdDeviation', 2).attr('flood-color', '#000').attr('flood-opacity', 0.15);
        defs.selectAll('#general-arrow').remove();
        defs.append('marker')
            .attr('id', 'general-arrow')
            .attr('viewBox', '0 -5 10 10')
            .attr('refX', 8)
            .attr('refY', 0)
            .attr('markerWidth', 5)
            .attr('markerHeight', 5)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M0,-4L10,0L0,4')
            .style('fill', 'var(--vscode-charts-blue)');

        if (ctx.showCategoryHeaders) {
            const headerGroup = g.append('g').attr('class', 'category-headers');
            categoryStartPositions.forEach((info: { y: number; count: number }, catId: string) => {
                const category = ctx.GENERAL_VIEW_CATEGORIES.find((c: any) => c.id === catId);
                if (!category) return;
                const headerG = headerGroup.append('g').attr('transform', 'translate(' + padding + ',' + info.y + ')');
                headerG.append('text').attr('x', 0).attr('y', 16)
                    .style('font-size', '14px').style('font-weight', '600').style('fill', category.color)
                    .text(category.label + ' (' + info.count + ')');
                headerG.append('line').attr('x1', 0).attr('y1', 24).attr('x2', availableWidth).attr('y2', 24)
                    .style('stroke', category.color).style('stroke-width', '2px').style('opacity', 0.35);
            });
        }

        const nodeGroup = g.append('g').attr('class', 'general-nodes');

        function drawGeneralEdges() {
            g.selectAll('.general-edges').remove();
            const edgeGroup = g.insert('g', '.general-nodes').attr('class', 'general-edges');

            portPositions.clear();
            nodePositions.forEach((pos: any, name: string) => {
                const el = pos.element;
                if (!el) return;
                const portSize = 10;
                const portSpacing = 16;
                const nodePorts: any[] = [];
                if (el.children) {
                    el.children.forEach((child: any) => {
                        if (!child || !child.name) return;
                        const cType = (child.type || '').toLowerCase();
                        if (cType === 'port' || cType.includes('port')) {
                            nodePorts.push({
                                name: child.name,
                                type: child.type,
                                direction: child.attributes?.get ? (child.attributes.get('direction') || 'inout') : 'inout'
                            });
                        }
                    });
                }
                if (el.ports) {
                    el.ports.forEach((p: any) => {
                        const pName = typeof p === 'string' ? p : (p.name || 'port');
                        if (!nodePorts.some((np: any) => np.name === pName)) {
                            nodePorts.push({ name: pName, type: 'port', direction: (typeof p === 'object' && p.direction) ? p.direction : 'inout' });
                        }
                    });
                }
                const leftPorts: any[] = [];
                const rightPorts: any[] = [];
                nodePorts.forEach((p: any, i: number) => {
                    if (i % 2 === 0) leftPorts.push(p);
                    else rightPorts.push(p);
                });
                const portStartY = 55;
                leftPorts.forEach((port: any, i: number) => {
                    const py = portStartY + i * portSpacing;
                    if (py <= pos.height - 20) {
                        portPositions.set(port.name, { ownerName: name, x: pos.x, y: pos.y + py, side: 'left' });
                    }
                });
                rightPorts.forEach((port: any, i: number) => {
                    const py = portStartY + i * portSpacing;
                    if (py <= pos.height - 20) {
                        portPositions.set(port.name, { ownerName: name, x: pos.x + pos.width, y: pos.y + py, side: 'right' });
                    }
                });
            });

            const connections: any[] = [];
            function collectRelationships(elements: any) {
                if (!elements) return;
                elements.forEach((el: any) => {
                    if (el.relationships) {
                        el.relationships.forEach((rel: any) => {
                            const tgt = rel.target || rel.relatedElement;
                            if (elementMap.has(el.name) && elementMap.has(tgt)) {
                                const rType = rel.type || 'relates';
                                connections.push({
                                    source: el.name, target: tgt, type: rType,
                                    isSpecialization: rType === 'specializes',
                                    isTypedBy: rType === 'typing' || rType === 'typed by',
                                    isContains: rType === 'contains' || rType === 'containment'
                                });
                            }
                        });
                    }
                    if (el.children) collectRelationships(el.children);
                });
            }
            collectRelationships(elementsData);
            partToDefLinks.forEach((link: any) => {
                if (elementMap.has(link.source) && elementMap.has(link.target)) {
                    connections.push({
                        source: link.source, target: link.target, type: link.type,
                        isSpecialization: link.type === 'specializes',
                        isTypedBy: link.type === 'typed by',
                        isContains: link.type === 'contains'
                    });
                }
            });

            const drawnEdges = new Set<string>();
            const edgeOffsets: Record<string, number> = {};

            connections.forEach((conn: any) => {
                const srcPos = nodePositions.get(conn.source);
                const tgtPos = nodePositions.get(conn.target);
                if (!srcPos || !tgtPos || conn.source === conn.target) return;
                let edgeTypeNorm = conn.type;
                if (edgeTypeNorm === 'typing') edgeTypeNorm = 'typed by';
                if (edgeTypeNorm === 'connection') edgeTypeNorm = 'connect';
                if (edgeTypeNorm === 'allocation') edgeTypeNorm = 'allocate';
                if (edgeTypeNorm === 'binding') edgeTypeNorm = 'bind';
                if (edgeTypeNorm === 'containment') edgeTypeNorm = 'contains';
                const edgeKey = conn.source + '->' + conn.target + '::' + edgeTypeNorm;
                if (drawnEdges.has(edgeKey)) return;
                drawnEdges.add(edgeKey);

                const pairKey = [conn.source, conn.target].sort().join('--');
                const pairCount = (edgeOffsets[pairKey] || 0) + 1;
                edgeOffsets[pairKey] = pairCount;
                const offsetStep = 22;
                const isReverse = conn.source > conn.target;
                const offset = (pairCount - 1) * offsetStep * (isReverse && pairCount > 1 ? -1 : 1);

                const srcCx = srcPos.x + srcPos.width / 2;
                const srcCy = srcPos.y + srcPos.height / 2;
                const tgtCx = tgtPos.x + tgtPos.width / 2;
                const tgtCy = tgtPos.y + tgtPos.height / 2;
                const dx = tgtCx - srcCx;
                const dy = tgtCy - srcCy;

                let x1: number, y1: number, x2: number, y2: number;
                if (Math.abs(dx) > Math.abs(dy)) {
                    x1 = dx > 0 ? srcPos.x + srcPos.width : srcPos.x;
                    y1 = srcCy + offset;
                    x2 = dx > 0 ? tgtPos.x : tgtPos.x + tgtPos.width;
                    y2 = tgtCy + offset;
                } else {
                    x1 = srcCx + offset;
                    y1 = dy > 0 ? srcPos.y + srcPos.height : srcPos.y;
                    x2 = tgtCx + offset;
                    y2 = dy > 0 ? tgtPos.y : tgtPos.y + tgtPos.height;
                }
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;
                let pathD: string;
                if (Math.abs(dx) > Math.abs(dy)) {
                    pathD = 'M' + x1 + ',' + y1 + ' L' + midX + ',' + y1 + ' L' + midX + ',' + y2 + ' L' + x2 + ',' + y2;
                } else {
                    pathD = 'M' + x1 + ',' + y1 + ' L' + x1 + ',' + midY + ' L' + x2 + ',' + midY + ' L' + x2 + ',' + y2;
                }

                let strokeColor: string, strokeDash: string, markerEnd: string, strokeWidth: string;
                if (conn.isSpecialization || conn.type === 'specializes') {
                    strokeColor = GENERAL_VIEW_PALETTE.structural.port; strokeDash = 'none'; markerEnd = 'url(#general-specializes)'; strokeWidth = '1.5px';
                } else if (conn.isTypedBy || conn.type === 'typed by' || conn.type === 'typing') {
                    strokeColor = GENERAL_VIEW_PALETTE.requirements.requirement; strokeDash = '5,3'; markerEnd = 'url(#general-typed-by)'; strokeWidth = '1.5px';
                } else if (conn.isContains || conn.type === 'contains' || conn.type === 'containment') {
                    strokeColor = GENERAL_VIEW_PALETTE.structural.part; strokeDash = 'none'; markerEnd = 'url(#general-contains)'; strokeWidth = '1.5px';
                } else if (conn.type === 'connect' || conn.type === 'connection' || conn.type === 'interface') {
                    strokeColor = GENERAL_VIEW_PALETTE.structural.interface; strokeDash = 'none'; markerEnd = 'url(#general-connect)'; strokeWidth = '2px';
                } else if (conn.type === 'bind' || conn.type === 'binding') {
                    strokeColor = '#808080'; strokeDash = '2,2'; markerEnd = 'none'; strokeWidth = '1px';
                } else if (conn.type === 'allocate' || conn.type === 'allocation') {
                    strokeColor = GENERAL_VIEW_PALETTE.other.allocation; strokeDash = '8,4'; markerEnd = 'url(#general-arrow)'; strokeWidth = '1.5px';
                } else if (conn.type === 'flow') {
                    strokeColor = GENERAL_VIEW_PALETTE.structural.part; strokeDash = 'none'; markerEnd = 'url(#general-arrow)'; strokeWidth = '2px';
                } else if (conn.type === 'subsetting' || conn.type === 'redefinition') {
                    strokeColor = GENERAL_VIEW_PALETTE.behavior.state; strokeDash = '4,2'; markerEnd = 'url(#general-arrow)'; strokeWidth = '1.5px';
                } else if (conn.type === 'satisfy' || conn.type === 'verify') {
                    strokeColor = GENERAL_VIEW_PALETTE.behavior.action; strokeDash = '6,3'; markerEnd = 'url(#general-arrow)'; strokeWidth = '1.5px';
                } else if (conn.type === 'dependency') {
                    strokeColor = GENERAL_VIEW_PALETTE.other.allocation; strokeDash = '6,3'; markerEnd = 'url(#general-arrow)'; strokeWidth = '1.5px';
                } else {
                    strokeColor = 'var(--vscode-charts-blue)'; strokeDash = 'none'; markerEnd = 'url(#general-arrow)'; strokeWidth = '1.5px';
                }
                const origStroke = strokeColor;
                const origWidth = strokeWidth;

                const edgePath = edgeGroup.append('path')
                    .attr('d', pathD).attr('class', 'relationship-edge general-connector')
                    .attr('data-connector-id', 'rel-' + conn.source + '-' + conn.target)
                    .attr('data-source', conn.source).attr('data-target', conn.target).attr('data-type', conn.type || 'relates')
                    .style('fill', 'none').style('stroke', strokeColor).style('stroke-width', strokeWidth)
                    .style('stroke-dasharray', strokeDash).style('opacity', 0.85).style('marker-end', markerEnd).style('cursor', 'pointer');

                edgePath.on('click', function(this: any, event: any) {
                    event.stopPropagation();
                    d3.selectAll('.general-connector').each(function() {
                        const el = d3.select(this);
                        const os = el.attr('data-original-stroke');
                        const ow = el.attr('data-original-width');
                        if (os) {
                            el.style('stroke', os).style('stroke-width', ow).classed('connector-highlighted', false);
                            el.attr('data-original-stroke', null).attr('data-original-width', null);
                        }
                    });
                    d3.select(this).attr('data-original-stroke', origStroke).attr('data-original-width', origWidth)
                        .style('stroke', '#FFD700').style('stroke-width', '4px').classed('connector-highlighted', true);
                    this.parentNode.appendChild(this);
                    ctx.postMessage({ command: 'connectorSelected', source: conn.source, target: conn.target, type: conn.type });
                });
                edgePath.on('mouseenter', function(this: any) {
                    const self = d3.select(this);
                    if (!self.classed('connector-highlighted')) self.style('stroke-width', '3px');
                });
                edgePath.on('mouseleave', function(this: any) {
                    const self = d3.select(this);
                    if (!self.classed('connector-highlighted')) self.style('stroke-width', origWidth);
                });

                if (conn.type) {
                    const labelX = Math.abs(dx) > Math.abs(dy) ? midX : (x1 + x2) / 2;
                    const labelY = Math.abs(dx) > Math.abs(dy) ? (y1 + y2) / 2 - 6 : midY - 6;
                    let labelText = conn.type;
                    if (conn.isSpecialization || conn.type === 'specializes') labelText = ':>';
                    else if (conn.isTypedBy || conn.type === 'typed by') labelText = ':';
                    else if (conn.isContains || conn.type === 'contains') labelText = '◆';
                    else if (conn.type === 'connect') labelText = 'connect';
                    else if (conn.type === 'bind') labelText = '=';
                    else if (conn.type.length > 12) labelText = conn.type.substring(0, 10) + '..';
                    edgeGroup.append('rect').attr('x', labelX - 22).attr('y', labelY - 9).attr('width', 44).attr('height', 14).attr('rx', 7)
                        .style('fill', 'var(--vscode-editor-background)').style('opacity', 0.92);
                    edgeGroup.append('text').attr('x', labelX).attr('y', labelY).attr('text-anchor', 'middle')
                        .text(labelText).style('font-size', '9px').style('font-weight', 'bold').style('fill', strokeColor);
                }
            });

            const portConnections: any[] = [];
            function collectPortConnections(elements: any) {
                if (!elements) return;
                elements.forEach((el: any) => {
                    const elType = (el.type || '').toLowerCase();
                    if (elType.includes('connection') || elType.includes('interface') || elType.includes('connect') || elType === 'bind') {
                        const fromAttr = el.attributes?.get ? el.attributes.get('from') : (el.attributes?.from);
                        const toAttr = el.attributes?.get ? el.attributes.get('to') : (el.attributes?.to);
                        if (fromAttr && toAttr) {
                            portConnections.push({
                                name: el.name, fromPort: fromAttr.split('.').pop(), toPort: toAttr.split('.').pop(),
                                fromFull: fromAttr, toFull: toAttr, type: elType === 'bind' ? 'bind' : 'connect'
                            });
                        }
                    }
                    if (el.children?.length > 0 && (elType.includes('connection') || elType.includes('interface'))) {
                        const ends: string[] = [];
                        el.children.forEach((child: any) => {
                            const childType = (child.type || '').toLowerCase();
                            if (childType === 'end' || child.name === 'end') {
                                let ref = child.attributes?.get ? child.attributes.get('reference') || child.attributes.get('typedBy') : '';
                                if (!ref && child.attributes) ref = child.attributes.reference || child.attributes.typedBy || '';
                                if (ref) ends.push(ref);
                            }
                        });
                        if (ends.length >= 2) {
                            portConnections.push({
                                name: el.name, fromPort: ends[0].split('.').pop(), toPort: ends[1].split('.').pop(),
                                fromFull: ends[0], toFull: ends[1], type: 'connect'
                            });
                        }
                    }
                    if (el.children) collectPortConnections(el.children);
                });
            }
            collectPortConnections(elementsData);

            portConnections.forEach((pConn: any) => {
                const fromPos = portPositions.get(pConn.fromPort);
                const toPos = portPositions.get(pConn.toPort);
                if (!fromPos || !toPos) return;
                let x1 = fromPos.x, y1 = fromPos.y, x2 = toPos.x, y2 = toPos.y;
                if (fromPos.side === 'left') x1 -= 5;
                else if (fromPos.side === 'right') x1 += 5;
                if (toPos.side === 'left') x2 -= 5;
                else if (toPos.side === 'right') x2 += 5;
                const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
                const dx = x2 - x1, dy = y2 - y1;
                let pathD: string;
                if (Math.abs(dx) > Math.abs(dy)) {
                    pathD = 'M' + x1 + ',' + y1 + ' L' + midX + ',' + y1 + ' L' + midX + ',' + y2 + ' L' + x2 + ',' + y2;
                } else {
                    pathD = 'M' + x1 + ',' + y1 + ' L' + x1 + ',' + midY + ' L' + x2 + ',' + midY + ' L' + x2 + ',' + y2;
                }
                const isBind = pConn.type === 'bind';
                const strokeColor = isBind ? GENERAL_VIEW_PALETTE.requirements.requirement : GENERAL_VIEW_PALETTE.structural.interface;
                const strokeDash = isBind ? '4,2' : 'none';
                const portOrigStroke = strokeColor;
                const portOrigWidth = '2px';
                const portEdge = edgeGroup.append('path')
                    .attr('d', pathD).attr('class', 'port-connection-edge general-connector')
                    .attr('data-connector-id', 'port-' + pConn.fromPort + '-' + pConn.toPort)
                    .attr('data-source', pConn.fromFull || pConn.fromPort).attr('data-target', pConn.toFull || pConn.toPort)
                    .attr('data-type', pConn.type || 'connect')
                    .style('fill', 'none').style('stroke', strokeColor).style('stroke-width', '2px').style('stroke-dasharray', strokeDash)
                    .style('opacity', 0.9).style('marker-end', 'url(#general-connect)').style('marker-start', 'url(#general-connect)').style('cursor', 'pointer');
                portEdge.on('click', function(this: any, event: any) {
                    event.stopPropagation();
                    d3.selectAll('.general-connector').each(function() {
                        const el = d3.select(this);
                        const os = el.attr('data-original-stroke');
                        const ow = el.attr('data-original-width');
                        if (os) {
                            el.style('stroke', os).style('stroke-width', ow).classed('connector-highlighted', false);
                            el.attr('data-original-stroke', null).attr('data-original-width', null);
                        }
                    });
                    d3.select(this).attr('data-original-stroke', portOrigStroke).attr('data-original-width', portOrigWidth)
                        .style('stroke', '#FFD700').style('stroke-width', '4px').classed('connector-highlighted', true);
                    this.parentNode.appendChild(this);
                    ctx.postMessage({ command: 'connectorSelected', source: pConn.fromFull || pConn.fromPort, target: pConn.toFull || pConn.toPort, type: pConn.type, name: pConn.name });
                });
                portEdge.on('mouseenter', function(this: any) {
                    const self = d3.select(this);
                    if (!self.classed('connector-highlighted')) self.style('stroke-width', '3px');
                });
                portEdge.on('mouseleave', function(this: any) {
                    const self = d3.select(this);
                    if (!self.classed('connector-highlighted')) self.style('stroke-width', portOrigWidth);
                });
                if (pConn.name) {
                    edgeGroup.append('text').attr('x', midX).attr('y', midY - 6).attr('text-anchor', 'middle')
                        .text(pConn.name.length > 15 ? pConn.name.substring(0, 13) + '..' : pConn.name)
                        .style('font-size', '8px').style('fill', strokeColor).style('font-style', 'italic');
                }
            });
        }

        defs.selectAll('#general-specializes').remove();
        defs.append('marker').attr('id', 'general-specializes').attr('viewBox', '0 -6 12 12').attr('refX', 11).attr('refY', 0)
            .attr('markerWidth', 8).attr('markerHeight', 8).attr('orient', 'auto')
            .append('path').attr('d', 'M0,-5L10,0L0,5Z')
            .style('fill', 'var(--vscode-editor-background)').style('stroke', GENERAL_VIEW_PALETTE.structural.port).style('stroke-width', '1.5px');
        defs.selectAll('#general-typed-by').remove();
        defs.append('marker').attr('id', 'general-typed-by').attr('viewBox', '0 -5 10 10').attr('refX', 9).attr('refY', 0)
            .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
            .append('path').attr('d', 'M0,-4L10,0L0,4Z').style('fill', GENERAL_VIEW_PALETTE.requirements.requirement);
        defs.selectAll('#general-contains').remove();
        defs.append('marker').attr('id', 'general-contains').attr('viewBox', '-6 -6 12 12').attr('refX', 0).attr('refY', 0)
            .attr('markerWidth', 8).attr('markerHeight', 8).attr('orient', 'auto')
            .append('path').attr('d', 'M-5,0L0,-4L5,0L0,4Z').style('fill', GENERAL_VIEW_PALETTE.structural.part);
        defs.selectAll('#general-connect').remove();
        defs.append('marker').attr('id', 'general-connect').attr('viewBox', '0 -4 8 8').attr('refX', 4).attr('refY', 0)
            .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
            .append('circle').attr('cx', 4).attr('cy', 0).attr('r', 3).style('fill', GENERAL_VIEW_PALETTE.structural.interface);
        defs.selectAll('#general-arrow').remove();
        defs.append('marker').attr('id', 'general-arrow').attr('viewBox', '0 -5 10 10').attr('refX', 8).attr('refY', 0)
            .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
            .append('path').attr('d', 'M0,-4L10,0L0,4').style('fill', 'var(--vscode-charts-blue)');

        nodePositions.forEach((pos: any, name: string) => {
            const el = pos.element;
            const typeLower = (el.type || '').toLowerCase();
            const typeColor = getTypeColor(el.type);
            const isLibValidated = ctx.isLibraryValidated(el);
            const isDefinition = typeLower.includes('def');
            const isUsage = !isDefinition && (typeLower.includes('part') || typeLower.includes('action') || typeLower.includes('port'));

            let typedByName: string | null = null;
            if (el.attributes?.get) {
                typedByName = el.attributes.get('partType') || el.attributes.get('type') || el.attributes.get('typedBy');
            }
            if (!typedByName && el.partType) typedByName = el.partType;

            const nodeG = nodeGroup.append('g')
                .attr('transform', 'translate(' + pos.x + ',' + pos.y + ')')
                .attr('class', 'general-node' + (isDefinition ? ' definition-node' : ' usage-node'))
                .attr('data-element-name', name)
                .style('cursor', 'pointer');

            const _nodeStroke = isLibValidated ? GENERAL_VIEW_PALETTE.structural.part : typeColor;
            const _nodeStrokeW = isUsage ? '3px' : '2px';
            nodeG.append('rect').attr('class', 'node-background')
                .attr('width', pos.width).attr('height', pos.height).attr('rx', isDefinition ? 5 : 10)
                .attr('data-original-stroke', _nodeStroke).attr('data-original-width', _nodeStrokeW)
                .style('fill', 'var(--vscode-editor-background)').style('stroke', _nodeStroke)
                .style('stroke-width', _nodeStrokeW).style('stroke-dasharray', isDefinition ? '6,3' : 'none')
                .style('filter', 'url(#general-node-shadow)');

            nodeG.append('rect').attr('width', pos.width).attr('height', 5).attr('rx', 2).style('fill', typeColor);
            nodeG.append('rect').attr('y', 5).attr('width', pos.width).attr('height', typedByName ? 36 : 28)
                .style('fill', 'var(--vscode-button-secondaryBackground)');

            let stereoDisplay = (el.type || 'element');
            if (typeLower.includes('part def')) stereoDisplay = 'part def';
            else if (typeLower.includes('part')) stereoDisplay = 'part';
            else if (typeLower.includes('port def')) stereoDisplay = 'port def';
            else if (typeLower.includes('action def')) stereoDisplay = 'action def';
            else if (typeLower.includes('action')) stereoDisplay = 'action';
            else if (typeLower.includes('requirement def')) stereoDisplay = 'requirement def';
            else if (typeLower.includes('requirement')) stereoDisplay = 'requirement';
            else if (typeLower.includes('use case def')) stereoDisplay = 'use case def';
            else if (typeLower.includes('use case')) stereoDisplay = 'use case';
            else if (typeLower.includes('interface def')) stereoDisplay = 'interface def';
            else if (typeLower.includes('interface')) stereoDisplay = 'interface';
            else if (typeLower.includes('state def')) stereoDisplay = 'state def';
            else if (typeLower.includes('state')) stereoDisplay = 'state';
            else if (typeLower.includes('attribute def')) stereoDisplay = 'attribute def';
            else if (typeLower.includes('attribute')) stereoDisplay = 'attribute';

            nodeG.append('text').attr('x', pos.width / 2).attr('y', 17).attr('text-anchor', 'middle')
                .text('\u00AB' + stereoDisplay + '\u00BB').style('font-size', '9px').style('fill', typeColor);

            const displayName = truncateText(name, 26);
            nodeG.append('text').attr('class', 'node-name-text').attr('data-element-name', name)
                .attr('x', pos.width / 2).attr('y', 31).attr('text-anchor', 'middle').text(displayName)
                .style('font-size', '11px').style('font-weight', 'bold').style('fill', 'var(--vscode-editor-foreground)');

            if (typedByName) {
                nodeG.append('text').attr('x', pos.width / 2).attr('y', 43).attr('text-anchor', 'middle')
                    .text(': ' + truncateText(typedByName, 24))
                    .style('font-size', '10px').style('font-style', 'italic').style('fill', GENERAL_VIEW_PALETTE.requirements.requirement);
            }

            const contentStartY = typedByName ? 50 : 38;
            const clipId = 'clip-' + name.replace(/[^a-zA-Z0-9]/g, '_');
            defs.append('clipPath').attr('id', clipId).append('rect')
                .attr('x', 4).attr('y', contentStartY).attr('width', pos.width - 8).attr('height', pos.height - contentStartY - 4);
            const contentGroup = nodeG.append('g').attr('clip-path', 'url(#' + clipId + ')');

            let yOffset = contentStartY + 8;
            pos.sections.forEach((section: any) => {
                contentGroup.append('text').attr('x', 8).attr('y', yOffset)
                    .text('─ ' + section.title + ' ─')
                    .style('font-size', '9px').style('font-weight', 'bold').style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += lineHeight;

                section.lines.forEach((line: any) => {
                    if (line.type === 'port' && line.name) {
                        portPositions.set(line.name, { ownerName: name, x: pos.x, y: pos.y + yOffset, nodeWidth: pos.width });
                    }
                    const fillColor = line.type === 'port' ? 'var(--vscode-charts-yellow)' :
                        line.type === 'part' ? 'var(--vscode-charts-green)' :
                        line.type === 'action' ? 'var(--vscode-charts-orange)' :
                        line.type === 'req' ? 'var(--vscode-charts-blue)' :
                        line.type === 'attr' ? 'var(--vscode-charts-lines)' :
                        line.type === 'doc' ? 'var(--vscode-foreground)' :
                        line.type === 'subject' ? 'var(--vscode-charts-purple)' :
                        line.type === 'constraint' ? 'var(--vscode-charts-red)' : 'var(--vscode-descriptionForeground)';
                    const lineMaxChars = Math.floor((pos.width - 20) / 5);
                    if (line.rawDoc && line.type === 'doc') {
                        const docText = line.text;
                        const words = docText.split(/\s+/);
                        const docLineTexts: string[] = [];
                        let currentDocLine = '';
                        let isFirst = true;
                        words.forEach((word: string) => {
                            const limit = isFirst ? lineMaxChars - 3 : lineMaxChars;
                            if ((currentDocLine + ' ' + word).length > limit) {
                                if (currentDocLine) {
                                    docLineTexts.push((isFirst ? '📄 ' : '') + currentDocLine);
                                    isFirst = false;
                                }
                                currentDocLine = word;
                            } else {
                                currentDocLine = currentDocLine ? currentDocLine + ' ' + word : word;
                            }
                        });
                        if (currentDocLine) docLineTexts.push((isFirst ? '📄 ' : '') + currentDocLine);
                        const maxDocLines = section.title === 'Documentation' ? 6 : 4;
                        docLineTexts.slice(0, maxDocLines).forEach((docLine: string) => {
                            contentGroup.append('text').attr('x', 12).attr('y', yOffset).text(docLine)
                                .style('font-size', '10px').style('fill', fillColor);
                            yOffset += lineHeight;
                        });
                    } else {
                        contentGroup.append('text').attr('x', 12).attr('y', yOffset).text(truncateText(line.text, lineMaxChars))
                            .style('font-size', '10px').style('fill', fillColor);
                        yOffset += lineHeight;
                    }
                });
                yOffset += sectionGap;
            });

            nodeG.on('click', function(this: any, event: any) {
                event.stopPropagation();
                ctx.clearVisualHighlights();
                const clickedNode = d3.select(this);
                clickedNode.classed('highlighted-element', true);
                clickedNode.select('.node-background').style('stroke', '#FFD700').style('stroke-width', '3px');
                ctx.postMessage({ command: 'jumpToElement', elementName: name, skipCentering: true });
            }).on('dblclick', function(this: any, event: any) {
                event.stopPropagation();
                ctx.onStartInlineEdit(nodeG, name, pos.x, pos.y, pos.width);
            });

            nodeG.style('cursor', 'grab');
            const generalDrag = d3.drag()
                .on('start', function(this: any, event: any) {
                    d3.select(this).raise().style('cursor', 'grabbing');
                    event.sourceEvent.stopPropagation();
                })
                .on('drag', function(this: any, event: any) {
                    pos.x += event.dx;
                    pos.y += event.dy;
                    d3.select(this).attr('transform', 'translate(' + pos.x + ',' + pos.y + ')');
                    drawGeneralEdges();
                })
                .on('end', function(this: any) {
                    d3.select(this).style('cursor', 'grab');
                });
            nodeG.call(generalDrag);

            const portSize = 10;
            const portSpacing = 16;
            const nodePorts: any[] = [];
            if (el.children) {
                el.children.forEach((child: any) => {
                    if (!child || !child.name) return;
                    const cType = (child.type || '').toLowerCase();
                    if (cType === 'port' || cType.includes('port')) {
                        nodePorts.push({
                            name: child.name,
                            type: child.type,
                            direction: child.attributes?.get ? (child.attributes.get('direction') || 'inout') : 'inout'
                        });
                    }
                });
            }
            if (el.ports) {
                el.ports.forEach((p: any) => {
                    const pName = typeof p === 'string' ? p : (p.name || 'port');
                    if (!nodePorts.some((np: any) => np.name === pName)) {
                        nodePorts.push({ name: pName, type: 'port', direction: (typeof p === 'object' && p.direction) ? p.direction : 'inout' });
                    }
                });
            }
            const leftPorts: any[] = [];
            const rightPorts: any[] = [];
            nodePorts.forEach((p: any, i: number) => {
                if (i % 2 === 0) leftPorts.push(p);
                else rightPorts.push(p);
            });
            const portStartY = Math.max(55, contentStartY + 10);
            leftPorts.forEach((port: any, i: number) => {
                const py = portStartY + i * portSpacing;
                if (py > pos.height - 20) return;
                nodeG.append('rect').attr('class', 'port-icon')
                    .attr('x', -portSize / 2).attr('y', py - portSize / 2).attr('width', portSize).attr('height', portSize)
                    .style('fill', port.direction === 'in' ? GENERAL_VIEW_PALETTE.structural.port : (port.direction === 'out' ? GENERAL_VIEW_PALETTE.structural.part : GENERAL_VIEW_PALETTE.structural.attribute))
                    .style('stroke', 'var(--vscode-editor-background)').style('stroke-width', '1px');
                nodeG.append('text').attr('x', -portSize - 3).attr('y', py + 3).attr('text-anchor', 'end')
                    .text(port.name).style('font-size', '8px').style('fill', GENERAL_VIEW_PALETTE.structural.port);
                portPositions.set(port.name, { ownerName: name, x: pos.x, y: pos.y + py, side: 'left' });
            });
            rightPorts.forEach((port: any, i: number) => {
                const py = portStartY + i * portSpacing;
                if (py > pos.height - 20) return;
                nodeG.append('rect').attr('class', 'port-icon')
                    .attr('x', pos.width - portSize / 2).attr('y', py - portSize / 2).attr('width', portSize).attr('height', portSize)
                    .style('fill', port.direction === 'in' ? GENERAL_VIEW_PALETTE.structural.port : (port.direction === 'out' ? GENERAL_VIEW_PALETTE.structural.part : GENERAL_VIEW_PALETTE.structural.attribute))
                    .style('stroke', 'var(--vscode-editor-background)').style('stroke-width', '1px');
                nodeG.append('text').attr('x', pos.width + portSize + 3).attr('y', py + 3).attr('text-anchor', 'start')
                    .text(port.name).style('font-size', '8px').style('fill', GENERAL_VIEW_PALETTE.structural.port);
                portPositions.set(port.name, { ownerName: name, x: pos.x + pos.width, y: pos.y + py, side: 'right' });
            });
        });

        drawGeneralEdges();

    } catch (error) {
        console.error('[General] Error:', error);
        ctx.renderPlaceholder(width, height, 'General View',
            'An error occurred while rendering.\\n\\nError: ' + ((error as Error).message || 'Unknown error'),
            ctx.currentData);
    }
}

function expandElkNodeDetails(
    ctx: ElkContext,
    nodeData: any,
    nodeElement: any,
    layoutNode: { x: number; y: number; width: number; height: number }
): void {
    const g = ctx.getG();
    if (!g) return;

    g.selectAll('.expanded-details').remove();

    g.selectAll('.elk-node-bg')
        .each(function(this: Element) {
            const node = d3.select(this);
            const parentNode = d3.select(this.parentNode);
            const nodeProps = parentNode.datum()?.properties;
            const isLibValidated = ctx.isLibraryValidated(nodeProps?.element);
            const borderColor = isLibValidated ? 'var(--vscode-charts-green)' : 'var(--vscode-panel-border)';
            const isRoot = !g.selectAll('.elk-edge').nodes().some((edge: any) => {
                return edge.__data__ && edge.__data__.targets &&
                       edge.__data__.targets.includes(parentNode.datum()?.id);
            });
            const borderWidth = isLibValidated ? '3px' : (isRoot ? '3px' : '2px');
            node.style('stroke', borderColor)
                .style('stroke-width', borderWidth);
        });
    g.selectAll('.elk-node').classed('selected', false);

    nodeElement.select('.elk-node-bg')
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', '4px');
    nodeElement.classed('selected', true);

    const detailsX = layoutNode.x + layoutNode.width + 25;
    const detailsY = layoutNode.y;

    const detailsGroup = g.append('g')
        .attr('class', 'expanded-details')
        .attr('transform', 'translate(' + detailsX + ',' + detailsY + ')');

    detailsGroup.append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', 320)
        .attr('height', 200)
        .attr('rx', 15)
        .style('fill', 'var(--vscode-editor-background)')
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', '2px')
        .style('filter', 'drop-shadow(0 12px 24px rgba(0,0,0,0.25))')
        .style('opacity', 0.98);

    const closeButton = detailsGroup.append('g')
        .attr('class', 'close-button')
        .attr('transform', 'translate(285, 18)')
        .style('cursor', 'pointer')
        .on('click', () => {
            g.selectAll('.expanded-details').remove();
            nodeElement.select('.elk-node-bg')
                .style('stroke', 'var(--vscode-panel-border)')
                .style('stroke-width', '2px');
        });

    closeButton.append('circle')
        .attr('r', 14)
        .style('fill', 'var(--vscode-charts-red)')
        .style('opacity', 0.9);

    closeButton.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em')
        .text('×')
        .style('fill', 'white')
        .style('font-size', '18px')
        .style('font-weight', 'bold')
        .style('pointer-events', 'none');

    const content = detailsGroup.append('g')
        .attr('class', 'details-content')
        .attr('transform', 'translate(25, 30)');

    let yPos = 0;

    content.append('text')
        .attr('x', 0)
        .attr('y', (yPos += 25))
        .text(nodeData.name)
        .style('font-size', '20px')
        .style('font-weight', 'bold')
        .style('fill', 'var(--vscode-editor-foreground)');

    content.append('text')
        .attr('x', 0)
        .attr('y', (yPos += 35))
        .text('Type: ' + nodeData.type)
        .style('font-size', '14px')
        .style('fill', 'var(--vscode-descriptionForeground)');

    if (ctx.isLibraryValidated(nodeData.element)) {
        content.append('text')
            .attr('x', 0)
            .attr('y', (yPos += 22))
            .text('✓ Standard Library Type')
            .style('font-size', '13px')
            .style('fill', 'var(--vscode-charts-green)')
            .style('font-weight', 'bold');

        const libKind = ctx.getLibraryKind(nodeData.element);
        if (libKind) {
            content.append('text')
                .attr('x', 0)
                .attr('y', (yPos += 18))
                .text('Library Kind: ' + libKind)
                .style('font-size', '12px')
                .style('fill', 'var(--vscode-descriptionForeground)');
        }

        const libChain = ctx.getLibraryChain(nodeData.element);
        if (libChain) {
            content.append('text')
                .attr('x', 0)
                .attr('y', (yPos += 18))
                .text('Specializes: ' + libChain)
                .style('font-size', '11px')
                .style('fill', 'var(--vscode-descriptionForeground)')
                .style('font-style', 'italic');
        }
    }

    if (nodeData.element?.doc) {
        content.append('text')
            .attr('x', 0)
            .attr('y', (yPos += 25))
            .text('Doc: ' + nodeData.element.doc.substring(0, 60) + (nodeData.element.doc.length > 60 ? '...' : ''))
            .style('font-size', '11px')
            .style('fill', 'var(--vscode-descriptionForeground)')
            .style('font-style', 'italic');
    }

    if (nodeData.children && nodeData.children.length > 0) {
        content.append('text')
            .attr('x', 0)
            .attr('y', (yPos += 25))
            .text('Children: ' + nodeData.children.length)
            .style('font-size', '14px')
            .style('fill', 'var(--vscode-descriptionForeground)');
    }

    const actionButton = content.append('g')
        .attr('class', 'action-button')
        .attr('transform', 'translate(0, ' + (yPos += 45) + ')')
        .style('cursor', 'pointer')
        .on('click', () => {
            ctx.postMessage({
                command: 'jumpToElement',
                elementName: nodeData.name
            });
        });

    actionButton.append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', 180)
        .attr('height', 40)
        .attr('rx', 10)
        .style('fill', 'var(--vscode-button-background)')
        .style('stroke', 'var(--vscode-button-border)')
        .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))');

    actionButton.append('text')
        .attr('x', 90)
        .attr('y', 20)
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em')
        .text('Go to Definition')
        .style('fill', 'var(--vscode-button-foreground)')
        .style('font-size', '13px')
        .style('font-weight', '600')
        .style('pointer-events', 'none');
}
