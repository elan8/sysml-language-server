/**
 * Hierarchy view renderer - partition/treemap layout of element hierarchy.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RenderContext } from '../types';
import { convertToHierarchy } from '../helpers';
import { wrapTextToLines, truncateLabel } from '../helpers';
import { isLibraryValidated, getNodeColor, getNodeBorderStyle } from '../shared';

declare const d3: any;

export function renderHierarchyView(ctx: RenderContext, data: any): void {
    const { width, height, svg, g, layoutDirection, postMessage, onStartInlineEdit, renderPlaceholder } = ctx;

    if (!data || !data.elements || data.elements.length === 0) {
        renderPlaceholder(width, height, 'Hierarchy View',
            'No elements found to display.\n\nThe parser did not return any elements for visualization.',
            data);
        return;
    }

    const isHorizontal = layoutDirection === 'horizontal' || layoutDirection === 'auto';

    const partition = d3.partition()
        .size(isHorizontal ? [height - 100, width - 100] : [width - 100, height - 100])
        .padding(1);

    const hierarchyData = convertToHierarchy(data.elements);

    if (!hierarchyData || !hierarchyData.name || !hierarchyData.type) {
        return;
    }

    const root = d3.hierarchy(hierarchyData)
        .sum((d: any) => {
            if (!d || !d.name || !d.type) return 0;
            return d.children && d.children.length > 0 ? 0 : 1;
        })
        .sort((a: any, b: any) => b.value - a.value);

    partition(root);

    const allDescendants = root.descendants();
    const validDescendants = allDescendants.filter((d: any) => {
        const hasValidData = d.data && d.data.name && d.data.type;
        const hasValidDimensions = d.x1 > d.x0 && d.y1 > d.y0 &&
            (d.x1 - d.x0) > 0.1 && (d.y1 - d.y0) > 0.1;
        const hasValidValue = d.value !== undefined && d.value >= 0;
        return hasValidData && hasValidDimensions && hasValidValue;
    });

    const cells = g.selectAll('.hierarchy-cell')
        .data(validDescendants)
        .enter()
        .append('g')
        .attr('class', 'hierarchy-cell')
        .attr('transform', (d: any) => isHorizontal
            ? 'translate(' + (d.y0 + 50) + ',' + (d.x0 + 50) + ')'
            : 'translate(' + (d.x0 + 50) + ',' + (d.y0 + 50) + ')');

    const defs = svg.selectAll('defs').data([0]).enter().append('defs');

    const gradient = defs.selectAll('#hierarchy-gradient').data([0]).enter()
        .append('linearGradient')
        .attr('id', 'hierarchy-gradient')
        .attr('gradientUnits', 'objectBoundingBox')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', 0).attr('y2', 1);

    gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', 'var(--vscode-button-background)')
        .attr('stop-opacity', 0.8);

    gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', 'var(--vscode-button-background)')
        .attr('stop-opacity', 0.6);

    cells.append('rect')
        .attr('class', 'node hierarchy-rect')
        .attr('width', (d: any) => {
            const w = isHorizontal ? (d.y1 - d.y0) : (d.x1 - d.x0);
            return Math.max(8, w);
        })
        .attr('height', (d: any) => {
            const h = isHorizontal ? (d.x1 - d.x0) : (d.y1 - d.y0);
            return Math.max(8, h);
        })
        .attr('rx', 3)
        .attr('ry', 3)
        .style('fill', 'url(#hierarchy-gradient)')
        .style('stroke', (d: any) => getNodeColor(d.data.element || d.data))
        .style('stroke-width', (d: any) => getNodeBorderStyle(d.data.element || d.data))
        .style('cursor', 'pointer');

    cells.on('click', function (event: any, d: any) {
        event.stopPropagation();

        g.selectAll('.hierarchy-cell rect')
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '1px')
            .style('stroke-opacity', 0.6)
            .style('filter', 'none');
        g.selectAll('.hierarchy-cell').classed('selected', false);

        const cellGroup = d3.select(this);
        cellGroup.classed('selected', true);

        cellGroup.select('rect')
            .style('stroke', 'var(--vscode-charts-orange)')
            .style('stroke-width', '3px')
            .style('stroke-opacity', 1)
            .style('filter', 'drop-shadow(0 0 6px var(--vscode-charts-orange))');

        postMessage({
            command: 'jumpToElement',
            elementName: d.data.name,
            skipCentering: true
        });
    })
        .on('dblclick', function (event: any, d: any) {
            event.stopPropagation();
            const cellWidth = isHorizontal ? (d.y1 - d.y0) : (d.x1 - d.x0);
            const cellX = isHorizontal ? (d.y0 + 50) : (d.x0 + 50);
            const cellY = isHorizontal ? (d.x0 + 50) : (d.y0 + 50);
            onStartInlineEdit(d3.select(this), d.data.name, cellX, cellY, Math.max(8, cellWidth));
        });

    cells.each(function (d: any) {
        const cell = d3.select(this);
        const cellWidth = d.y1 - d.y0;
        const cellHeight = d.x1 - d.x0;

        renderHierarchyCellContent(cell, d, cellWidth, cellHeight);
    });
}

export function renderHierarchyCellContent(cell: any, node: any, width: number, height: number): void {
    const hasSpaceForDetails = width > 140 && height > 90;
    if (hasSpaceForDetails) {
        renderHierarchyDetailCard(cell, node, width, height);
    } else {
        renderCompactHierarchyCell(cell, node, width, height);
    }
}

export function renderHierarchyDetailCard(cell: any, node: any, width: number, height: number): void {
    const padding = 8;
    const availableWidth = Math.max(16, width - padding * 2);
    const availableHeight = Math.max(16, height - padding * 2);
    const content = cell.append('g')
        .attr('class', 'hierarchy-card-content')
        .attr('transform', 'translate(' + padding + ',' + padding + ')');

    const maxTitleChars = Math.max(25, Math.floor(availableWidth / 4.5));
    const truncatedName = truncateLabel(node.data.name, maxTitleChars);
    let cursorY = 0;

    const titleText = content.append('text')
        .attr('class', 'hierarchy-card-title node-name-text')
        .attr('data-element-name', node.data.name)
        .attr('x', 0)
        .attr('y', cursorY + 12)
        .text(truncatedName);

    titleText.append('title').text(node.data.name);

    cursorY += 24;

    const truncatedType = truncateLabel(node.data.type || '', maxTitleChars);
    const typeText = content.append('text')
        .attr('class', 'hierarchy-card-type')
        .attr('x', 0)
        .attr('y', cursorY)
        .text('[' + truncatedType + ']');

    typeText.append('title').text(node.data.type || '');

    cursorY += 10;

    const childNodes = node.children || [];
    const descendantLeafCount = node.value || 0;
    const stats = [
        { label: 'Children', value: childNodes.length },
        { label: 'Leaves', value: descendantLeafCount },
        { label: 'Depth', value: node.depth || 0 }
    ];

    const statsRow = content.append('g')
        .attr('class', 'hierarchy-stat-row')
        .attr('transform', 'translate(0,' + (cursorY + 8) + ')');

    stats.forEach((stat, index) => {
        const group = statsRow.append('g')
            .attr('class', 'hierarchy-stat-pill')
            .attr('transform', 'translate(' + (index * 70) + ',0)');

        group.append('rect')
            .attr('class', 'hierarchy-stat-pill-bg')
            .attr('x', 0)
            .attr('y', -10)
            .attr('width', 62)
            .attr('height', 22)
            .attr('rx', 11)
            .attr('ry', 11);

        group.append('text')
            .attr('class', 'hierarchy-stat-pill-label')
            .attr('x', 31)
            .attr('y', 4)
            .attr('text-anchor', 'middle')
            .text(stat.label + ': ' + stat.value);
    });

    cursorY += 40;

    const documentation = node.data.properties ? node.data.properties.documentation : null;
    if (documentation && cursorY + 30 < availableHeight) {
        content.append('text')
            .attr('class', 'hierarchy-section-title')
            .attr('x', 0)
            .attr('y', cursorY)
            .text('Documentation');

        cursorY += 12;

        const docLines = wrapTextToLines(documentation, Math.floor(availableWidth / 7), 3);
        docLines.forEach((line, index) => {
            content.append('text')
                .attr('class', 'hierarchy-detail-text')
                .attr('x', 0)
                .attr('y', cursorY + index * 12)
                .text(line);
        });

        cursorY += docLines.length * 12 + 10;
    }

    const properties = Object.entries(node.data.properties || {})
        .filter((entry: [string, unknown]) => entry[0] !== 'documentation');
    if (properties.length > 0 && cursorY + 24 < availableHeight) {
        content.append('text')
            .attr('class', 'hierarchy-section-title')
            .attr('x', 0)
            .attr('y', cursorY)
            .text('Properties');

        cursorY += 12;

        const propLineHeight = 12;
        const linesAvailable = Math.max(1, Math.floor((availableHeight - cursorY - 20) / propLineHeight));
        properties.slice(0, linesAvailable).forEach((entry, index) => {
            const key = truncateLabel(entry[0], 12);
            const value = truncateLabel(String(entry[1]), Math.floor(availableWidth / 8));
            content.append('text')
                .attr('class', 'hierarchy-detail-text')
                .attr('x', 0)
                .attr('y', cursorY + index * propLineHeight)
                .text(key + ': ' + value);
        });

        cursorY += linesAvailable * propLineHeight + 8;

        if (properties.length > linesAvailable) {
            content.append('text')
                .attr('class', 'hierarchy-detail-text')
                .attr('x', 0)
                .attr('y', cursorY)
                .style('font-style', 'italic')
                .text('+' + (properties.length - linesAvailable) + ' more properties');
            cursorY += 12;
        }
    }

    if (childNodes.length > 0 && cursorY + 24 < availableHeight) {
        content.append('text')
            .attr('class', 'hierarchy-section-title')
            .attr('x', 0)
            .attr('y', cursorY)
            .text('Nested');

        cursorY += 14;

        const childRowHeight = 18;
        const rowsAvailable = Math.max(1, Math.floor((availableHeight - cursorY - 6) / childRowHeight));
        const visibleChildren = childNodes.slice(0, rowsAvailable);

        visibleChildren.forEach((child, index) => {
            const childGroup = content.append('g')
                .attr('class', 'hierarchy-child-card')
                .attr('transform', 'translate(0,' + (cursorY + index * childRowHeight) + ')');

            childGroup.append('rect')
                .attr('x', 0)
                .attr('y', -12)
                .attr('width', availableWidth - 4)
                .attr('height', 16);

            const childName = truncateLabel(child.data.name, Math.floor((availableWidth - 20) / 7));
            const childType = truncateLabel(child.data.type || '', 12);
            childGroup.append('text')
                .attr('x', 6)
                .attr('y', 0)
                .text('• ' + childName + ' [' + childType + ']');
        });

        cursorY += visibleChildren.length * childRowHeight;

        if (childNodes.length > visibleChildren.length) {
            content.append('text')
                .attr('class', 'hierarchy-detail-text')
                .attr('x', 0)
                .attr('y', cursorY + 10)
                .style('font-style', 'italic')
                .text('+' + (childNodes.length - visibleChildren.length) + ' more nested items');
        }
    }
}

export function renderCompactHierarchyCell(cell: any, node: any, width: number, height: number): void {
    if (width <= 8 || height <= 8) {
        return;
    }

    if (width > 20 && height > 8 && node.data.name && node.data.type) {
        const maxChars = Math.max(8, Math.floor(width / 5));
        const truncatedName = truncateLabel(node.data.name, maxChars);

        if (truncatedName) {
            const labelText = cell.append('text')
                .attr('class', 'node-label node-name-text')
                .attr('data-element-name', node.data.name)
                .attr('x', 2)
                .attr('y', Math.min(12, height / 2 + 2))
                .text(truncatedName)
                .style('font-size', Math.max(10, Math.min(14, height / 1.8)) + 'px')
                .style('font-weight', '600')
                .style('pointer-events', 'none');

            labelText.append('title').text(node.data.name);
        }

        if (height > 20 && node.data.type) {
            const truncatedType = truncateLabel(node.data.type, maxChars);
            const typeText = cell.append('text')
                .attr('class', 'node-type')
                .attr('x', 2)
                .attr('y', Math.min(height - 3, height / 2 + 12))
                .text('[' + truncatedType + ']')
                .style('font-size', Math.max(9, Math.min(12, height / 2.8)) + 'px')
                .style('font-weight', '500')
                .style('opacity', 0.8)
                .style('pointer-events', 'none');

            typeText.append('title').text(node.data.type);
        }
    } else {
        const initial = node.data.name ? node.data.name.charAt(0).toUpperCase() : '?';
        const initialText = cell.append('text')
            .attr('class', 'node-label node-name-text')
            .attr('data-element-name', node.data.name)
            .attr('x', width / 2)
            .attr('y', height / 2 + 2)
            .attr('text-anchor', 'middle')
            .text(initial)
            .style('font-size', Math.min(12, height / 1.2) + 'px')
            .style('font-weight', 'bold')
            .style('pointer-events', 'none');

        initialText.append('title').text(node.data.name + ' [' + node.data.type + ']');
    }
}
