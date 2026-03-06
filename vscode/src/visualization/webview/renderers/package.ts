/**
 * Package view renderer - displays package containment and dependencies.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RenderContext } from '../types';

declare const d3: any;

export function renderPackageView(
    ctx: RenderContext,
    data: any
): void {
    const { width, height, svg, g, layoutDirection, postMessage, onStartInlineEdit, renderPlaceholder } = ctx;

    if (!data || !data.nodes || data.nodes.length === 0) {
        renderPlaceholder(width, height, 'Package View',
            'No packages found to display.\n\nThis view shows package containment and dependencies.',
            data);
        return;
    }

    const nodes = data.nodes || [];
    const dependencies = data.dependencies || [];

    const isHorizontal = layoutDirection === 'horizontal';

    const packageWidth = 180;
    const packageHeight = 120;
    const horizontalSpacing = 60;
    const verticalSpacing = 80;
    const startX = 100;
    const startY = 100;

    const cols = isHorizontal
        ? Math.ceil(Math.sqrt(nodes.length * 2))
        : Math.ceil(Math.sqrt(nodes.length / 2));
    const packagePositions = new Map<string, { x: number; y: number; package: any }>();

    nodes.forEach((pkg: any, index: number) => {
        const col = index % Math.max(1, cols);
        const row = Math.floor(index / Math.max(1, cols));
        packagePositions.set(pkg.id, {
            x: startX + col * (packageWidth + horizontalSpacing),
            y: startY + row * (packageHeight + verticalSpacing),
            package: pkg
        });
    });

    const dependencyGroup = g.append('g').attr('class', 'package-dependencies');

    dependencies.forEach((dep: any) => {
        const sourcePos = packagePositions.get(dep.sourceId);
        const targetPos = packagePositions.get(dep.targetId);

        if (!sourcePos || !targetPos) return;

        const depStartX = sourcePos.x + packageWidth / 2;
        const depStartY = sourcePos.y + packageHeight;
        const endX = targetPos.x + packageWidth / 2;
        const endY = targetPos.y;

        const lineStyle = dep.kind === 'import' ? '5,5' : '0';

        dependencyGroup.append('line')
            .attr('x1', depStartX)
            .attr('y1', depStartY)
            .attr('x2', endX)
            .attr('y2', endY)
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '2px')
            .style('stroke-dasharray', lineStyle)
            .style('marker-end', 'url(#package-arrowhead)');

        const midX = (depStartX + endX) / 2;
        const midY = (depStartY + endY) / 2;

        dependencyGroup.append('text')
            .attr('x', midX)
            .attr('y', midY - 5)
            .attr('text-anchor', 'middle')
            .text('<<' + dep.kind + '>>')
            .style('font-size', '9px')
            .style('fill', 'var(--vscode-charts-blue)')
            .style('font-style', 'italic');
    });

    const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');

    defs.append('marker')
        .attr('id', 'package-arrowhead')
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 8)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .style('fill', 'var(--vscode-charts-blue)');

    const packageGroup = g.append('g').attr('class', 'package-nodes');

    packagePositions.forEach((pos, pkgId) => {
        const pkg = pos.package;

        const packageElement = packageGroup.append('g')
            .attr('class', 'package-node')
            .attr('transform', 'translate(' + pos.x + ',' + pos.y + ')')
            .style('cursor', 'pointer');

        packageElement.on('click', function (event: any) {
            event.stopPropagation();
            postMessage({ command: 'jumpToElement', elementName: pkg.name });
        })
            .on('dblclick', function (event: any) {
                event.stopPropagation();
                onStartInlineEdit(d3.select(this), pkg.name, pos.x, pos.y, packageWidth);
            });

        const tabHeight = 25;
        const tabWidth = 60;

        packageElement.append('rect')
            .attr('width', packageWidth)
            .attr('height', packageHeight)
            .attr('rx', 4)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '2px');

        packageElement.append('rect')
            .attr('x', 0)
            .attr('y', -tabHeight)
            .attr('width', tabWidth)
            .attr('height', tabHeight)
            .attr('rx', 4)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '2px');

        packageElement.append('text')
            .attr('x', tabWidth / 2)
            .attr('y', -tabHeight / 2 + 5)
            .attr('text-anchor', 'middle')
            .text('▤')
            .style('font-size', '14px')
            .style('fill', 'var(--vscode-charts-blue)')
            .style('user-select', 'none');

        const pkgName = pkg.name || 'Unnamed Package';
        const truncatedName = pkgName.length > 20 ? pkgName.substring(0, 17) + '...' : pkgName;
        packageElement.append('text')
            .attr('class', 'node-name-text')
            .attr('data-element-name', pkgName)
            .attr('x', packageWidth / 2)
            .attr('y', 25)
            .attr('text-anchor', 'middle')
            .text(truncatedName)
            .style('font-size', '13px')
            .style('font-weight', 'bold')
            .style('fill', 'var(--vscode-editor-foreground)')
            .style('user-select', 'none');

        if (pkg.kind && pkg.kind !== 'standard') {
            packageElement.append('text')
                .attr('x', packageWidth / 2)
                .attr('y', 42)
                .attr('text-anchor', 'middle')
                .text('<<' + pkg.kind + '>>')
                .style('font-size', '10px')
                .style('fill', 'var(--vscode-descriptionForeground)')
                .style('font-style', 'italic')
                .style('user-select', 'none');
        }

        if (pkg.childPackageIds && pkg.childPackageIds.length > 0) {
            packageElement.append('text')
                .attr('x', 10)
                .attr('y', packageHeight - 30)
                .text('└ ' + pkg.childPackageIds.length + ' child package' + (pkg.childPackageIds.length > 1 ? 's' : ''))
                .style('font-size', '10px')
                .style('fill', 'var(--vscode-descriptionForeground)')
                .style('user-select', 'none');
        }

        const elCount = pkg.elementCount || (pkg.children ? pkg.children.length : 0) || 0;
        packageElement.append('text')
            .attr('x', 10)
            .attr('y', packageHeight - 12)
            .text('◉ ' + elCount + ' element' + (elCount !== 1 ? 's' : ''))
            .style('font-size', '10px')
            .style('fill', 'var(--vscode-descriptionForeground)')
            .style('user-select', 'none');
    });
}
