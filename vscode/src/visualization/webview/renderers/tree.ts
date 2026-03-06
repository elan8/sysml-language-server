/**
 * Tree view renderer - hierarchical tree layout of elements.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RenderContext } from '../types';
import { convertToHierarchy } from '../helpers';
import { isLibraryValidated, getNodeColor } from '../shared';

declare const d3: any;

export function renderTreeView(ctx: RenderContext, data: any): void {
    const { width, height, g, layoutDirection, postMessage, onStartInlineEdit, renderPlaceholder, clearVisualHighlights } = ctx;

    if (!data || !data.elements || data.elements.length === 0) {
        renderPlaceholder(width, height, 'Tree View',
            'No elements found to display.\n\nThe parser did not return any elements for visualization.',
            data);
        return;
    }

    const isHorizontal = layoutDirection === 'horizontal' || layoutDirection === 'auto';

    const hierarchyData = convertToHierarchy(data.elements);
    const root = d3.hierarchy(hierarchyData);

    const nodeHeight = 70;
    const nodeWidth = 280;

    const treeLayout = d3.tree()
        .nodeSize(isHorizontal ? [nodeHeight, nodeWidth] : [nodeWidth, nodeHeight])
        .separation((a: any, b: any) => {
            if (a.parent === b.parent) {
                const aChildCount = (a.children || []).length;
                const bChildCount = (b.children || []).length;
                const maxChildCount = Math.max(aChildCount, bChildCount);
                return 1.5 + (maxChildCount > 0 ? Math.min(maxChildCount * 0.3, 2) : 0);
            }
            return 2.5;
        });

    treeLayout(root);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    root.each((d: any) => {
        if (d.x < minX) minX = d.x;
        if (d.x > maxX) maxX = d.x;
        if (d.y < minY) minY = d.y;
        if (d.y > maxY) maxY = d.y;
    });

    const offsetX = isHorizontal ? 150 : -minX + 150;
    const offsetY = isHorizontal ? -minX + 50 : 150;

    g.selectAll('.link')
        .data(root.links())
        .enter()
        .append('path')
        .attr('class', 'link')
        .attr('d', isHorizontal
            ? d3.linkHorizontal().x((d: any) => d.y + offsetX).y((d: any) => d.x + offsetY)
            : d3.linkVertical().x((d: any) => d.x + offsetX).y((d: any) => d.y + offsetY));

    const nodes = g.selectAll('.node')
        .data(root.descendants())
        .enter()
        .append('g')
        .attr('class', 'node-group')
        .attr('transform', (d: any) => isHorizontal
            ? 'translate(' + (d.y + offsetX) + ',' + (d.x + offsetY) + ')'
            : 'translate(' + (d.x + offsetX) + ',' + (d.y + offsetY) + ')');

    nodes.each(function (d: any) {
        const node = d3.select(this);

        const MIN_NODE_WIDTH = 100;
        const MAX_NODE_WIDTH = 220;
        const CHAR_WIDTH = 7.5;
        const PADDING = 28;

        const nameWidth = d.data.name.length * CHAR_WIDTH + PADDING;
        const typeWidth = (d.data.type.length + 2) * CHAR_WIDTH + PADDING;
        const childCountWidth = (d.children || d._children)
            ? ((d.children || d._children).length.toString().length + 12) * CHAR_WIDTH + PADDING
            : 0;

        const requiredWidth = Math.max(nameWidth, typeWidth, childCountWidth);
        const nodeWidth = Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, requiredWidth));

        const availableChars = Math.floor((nodeWidth - PADDING) / CHAR_WIDTH);
        const truncatedName = d.data.name.length > availableChars
            ? d.data.name.substring(0, availableChars - 3) + '...'
            : d.data.name;
        const maxTypeChars = availableChars - 2;
        const truncatedType = d.data.type.length > maxTypeChars
            ? d.data.type.substring(0, maxTypeChars - 3) + '...'
            : d.data.type;
        const displayType = '[' + truncatedType + ']';

        const elem = d.data.element || d.data;
        const isLibValidated = isLibraryValidated(elem);
        const borderColor = isLibValidated ? 'var(--vscode-charts-green)' : 'var(--vscode-panel-border)';
        const borderWidth = isLibValidated ? '2px' : '1px';

        const handleNodeClick = function (event: any) {
            event.stopPropagation();
            clearVisualHighlights();
            node.classed('highlighted-element', true);
            node.select('.node-background')
                .style('stroke', '#FFD700')
                .style('stroke-width', '3px');
            postMessage({
                command: 'jumpToElement',
                elementName: d.data.name,
                skipCentering: true
            });
        };

        node.append('rect')
            .attr('class', 'node-background')
            .attr('x', -8)
            .attr('y', -15)
            .attr('width', nodeWidth)
            .attr('height', 46)
            .attr('rx', 5)
            .attr('data-original-stroke', borderColor)
            .attr('data-original-width', borderWidth)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', borderColor)
            .style('stroke-width', borderWidth)
            .style('opacity', 0.9)
            .style('cursor', 'pointer')
            .on('click', handleNodeClick);

        node.style('cursor', 'pointer')
            .on('click', handleNodeClick)
            .on('dblclick', function (event: any) {
                event.stopPropagation();
                event.preventDefault();
                const transform = node.attr('transform');
                const matches = transform.match(/translate[(]([^,]+),([^)]+)[)]/);
                const nodeX = parseFloat(matches[1]);
                const nodeY = parseFloat(matches[2]);
                onStartInlineEdit(node, d.data.name, nodeX - 8, nodeY - 15, nodeWidth);
            });

        const nodeColor = getNodeColor(elem);
        node.append('circle')
            .attr('class', 'node')
            .attr('r', 6)
            .style('fill', nodeColor);

        node.append('text')
            .attr('class', 'node-label node-name-text')
            .attr('data-element-name', d.data.name)
            .attr('dx', 10)
            .attr('dy', -2)
            .text(truncatedName)
            .style('font-weight', 'bold');

        node.append('text')
            .attr('class', 'node-type')
            .attr('dx', 10)
            .attr('dy', 12)
            .text(displayType);

        if (d.children || d._children) {
            const childCount = (d.children || d._children).length;
            node.append('text')
                .attr('class', 'node-children')
                .attr('dx', 10)
                .attr('dy', 24)
                .text('(' + childCount + ' children)')
                .style('font-size', '9px')
                .style('font-style', 'italic');
        }
    });
}
