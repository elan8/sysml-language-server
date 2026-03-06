/**
 * Graph view renderer - force-directed graph of elements and relationships.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RenderContext } from '../types';
import { flattenElements, createLinksFromHierarchy } from '../helpers';
import { isLibraryValidated } from '../shared';

declare const d3: any;

export function renderGraphView(ctx: RenderContext, data: any): void {
    const { width, height, svg, g, postMessage, renderPlaceholder } = ctx;

    if (!data || !data.elements || data.elements.length === 0) {
        renderPlaceholder(width, height, 'Graph View',
            'No elements found to display.\n\nThe parser did not return any elements for visualization.',
            data);
        return;
    }

    const nodes = flattenElements(data.elements);
    const links = createLinksFromHierarchy(data.elements);

    const relationships = data.relationships || [];
    relationships.forEach((rel: any) => {
        const source = nodes.find((n: any) => n.name === rel.source);
        const target = nodes.find((n: any) => n.name === rel.target);
        if (source && target) {
            links.push({ source, target, type: rel.type });
        }
    });

    const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id((d: any) => d.name).distance(250))
        .force('charge', d3.forceManyBody().strength(-1000))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(120))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05));

    g.append('defs').append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10')
        .attr('refX', 13)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 8)
        .attr('markerHeight', 8)
        .attr('xoverflow', 'visible')
        .append('svg:path')
        .attr('d', 'M 0,-5 L 10 ,0 L 0,5')
        .attr('fill', 'var(--vscode-charts-purple)')
        .style('stroke', 'none');

    const link = g.append('g')
        .selectAll('line')
        .data(links)
        .enter()
        .append('line')
        .attr('class', (d: any) => d.type ? 'relationship-link' : 'link')
        .style('stroke', (d: any) => d.type ? 'var(--vscode-charts-purple)' : 'var(--vscode-panel-border)')
        .style('stroke-width', (d: any) => d.type ? 3 : 2)
        .style('opacity', 0.7)
        .style('marker-end', (d: any) => d.type ? 'url(#arrowhead)' : 'none');

    const node = g.append('g')
        .selectAll('g')
        .data(nodes)
        .enter()
        .append('g')
        .attr('class', 'graph-node-group')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    function expandNodeDetails(nodeData: any, nodeGroup: any) {
        g.selectAll('.expanded-details').remove();

        g.selectAll('.graph-node-background')
            .style('stroke', 'var(--vscode-panel-border)')
            .style('stroke-width', '2px');
        g.selectAll('.graph-node-group').classed('selected', false);

        nodeGroup.select('.graph-node-background')
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '3px');
        nodeGroup.classed('selected', true);

        const detailsGroup = g.append('g')
            .attr('class', 'expanded-details')
            .attr('transform', 'translate(' + (nodeData.x + 80) + ',' + (nodeData.y - 50) + ')');

        let panelHeight = 160;
        const el = nodeData.element;
        if (el && el.attributes && el.attributes.size > 0) {
            const attributeEntries = Array.from(el.attributes.entries())
                .filter(([key, value]: [string, unknown]) => !key.startsWith('is') && key !== 'visibility' && value);
            if (attributeEntries.length > 0) {
                panelHeight += Math.min(attributeEntries.length, 3) * 15 + 30;
                if (attributeEntries.length > 3) panelHeight += 15;
            }
        }

        if (nodeData.element?.children) {
            const ports = nodeData.element.children.filter((child: any) =>
                child.type && (child.type.toLowerCase().includes('port') ||
                    child.type.toLowerCase().includes('interface')));
            if (ports.length > 0) {
                panelHeight += Math.min(ports.length, 3) * 15 + 30;
                if (ports.length > 3) panelHeight += 15;
            }
        }

        detailsGroup.append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', 280)
            .attr('height', panelHeight)
            .attr('rx', 8)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'var(--vscode-charts-blue)')
            .style('stroke-width', '2px')
            .style('filter', 'drop-shadow(3px 3px 6px rgba(0,0,0,0.4))');

        detailsGroup.append('circle')
            .attr('cx', 265)
            .attr('cy', 15)
            .attr('r', 10)
            .style('fill', 'var(--vscode-charts-red)')
            .style('cursor', 'pointer')
            .on('click', () => {
                g.selectAll('.expanded-details').remove();
                g.selectAll('.graph-node-background')
                    .style('stroke', 'var(--vscode-panel-border)')
                    .style('stroke-width', '2px');
            });

        detailsGroup.append('text')
            .attr('x', 265)
            .attr('y', 19)
            .attr('text-anchor', 'middle')
            .text('×')
            .style('fill', 'white')
            .style('font-size', '12px')
            .style('font-weight', 'bold')
            .style('cursor', 'pointer')
            .on('click', () => {
                g.selectAll('.expanded-details').remove();
                g.selectAll('.graph-node-background')
                    .style('stroke', 'var(--vscode-panel-border)')
                    .style('stroke-width', '2px');
            });

        detailsGroup.append('text')
            .attr('x', 15)
            .attr('y', 25)
            .text(nodeData.name)
            .style('font-weight', 'bold')
            .style('font-size', '16px')
            .style('fill', 'var(--vscode-editor-foreground)');

        detailsGroup.append('text')
            .attr('x', 15)
            .attr('y', 45)
            .text('Type: ' + nodeData.type)
            .style('font-size', '12px')
            .style('fill', 'var(--vscode-descriptionForeground)');

        let yOffset = 65;

        if (el && el.attributes && el.attributes.size > 0) {
            const attributeEntries = Array.from(el.attributes.entries())
                .filter(([key, value]: [string, unknown]) => !key.startsWith('is') && key !== 'visibility' && value);

            if (attributeEntries.length > 0) {
                detailsGroup.append('text')
                    .attr('x', 15)
                    .attr('y', yOffset)
                    .text('Attributes:')
                    .style('font-weight', 'bold')
                    .style('font-size', '13px')
                    .style('fill', 'var(--vscode-charts-purple)');

                yOffset += 20;
                attributeEntries.slice(0, 3).forEach(([key, value]: [string, unknown]) => {
                    const displayValue = String(value).length > 25 ? String(value).substring(0, 22) + '...' : String(value);
                    detailsGroup.append('text')
                        .attr('x', 25)
                        .attr('y', yOffset)
                        .text(key + ': ' + displayValue)
                        .style('font-size', '11px')
                        .style('fill', 'var(--vscode-charts-purple)')
                        .style('opacity', '0.9');
                    yOffset += 15;
                });

                if (attributeEntries.length > 3) {
                    detailsGroup.append('text')
                        .attr('x', 25)
                        .attr('y', yOffset)
                        .text('... and ' + (attributeEntries.length - 3) + ' more attributes')
                        .style('font-size', '10px')
                        .style('font-style', 'italic')
                        .style('fill', 'var(--vscode-charts-purple)')
                        .style('opacity', '0.7');
                    yOffset += 15;
                }
                yOffset += 10;
            }
        }

        if (nodeData.properties && nodeData.properties.documentation) {
            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('Documentation:')
                .style('font-weight', 'bold')
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-editor-foreground)');

            yOffset += 20;
            const docText = String(nodeData.properties.documentation);
            const maxLineLength = 40;
            const lines: string[] = [];

            if (docText.length > maxLineLength) {
                let currentLine = '';
                const words = docText.split(' ');
                for (const word of words) {
                    if ((currentLine + word).length > maxLineLength && currentLine.length > 0) {
                        lines.push(currentLine.trim());
                        currentLine = word + ' ';
                    } else {
                        currentLine += word + ' ';
                    }
                }
                if (currentLine.trim().length > 0) {
                    lines.push(currentLine.trim());
                }
            } else {
                lines.push(docText);
            }

            lines.slice(0, 3).forEach((line: string) => {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text(line)
                    .style('font-size', '10px')
                    .style('fill', 'var(--vscode-descriptionForeground)')
                    .style('font-style', 'italic');
                yOffset += 14;
            });

            if (lines.length > 3) {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text('... (' + (lines.length - 3) + ' more lines)')
                    .style('font-size', '9px')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 12;
            }
            yOffset += 10;
        }

        const properties = nodeData.properties || {};
        const regularProperties = Object.entries(properties).filter(([key]) => key !== 'documentation');

        if (regularProperties.length > 0) {
            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('Properties:')
                .style('font-weight', 'bold')
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-editor-foreground)');

            yOffset += 20;
            regularProperties.slice(0, 4).forEach(([key, value]) => {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text(key + ': ' + (String(value).length > 30 ? String(value).substring(0, 27) + '...' : String(value)))
                    .style('font-size', '11px')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 15;
            });

            if (regularProperties.length > 4) {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text('... and ' + (regularProperties.length - 4) + ' more')
                    .style('font-size', '10px')
                    .style('font-style', 'italic')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 15;
            }
        }

        const children = nodeData.element?.children || [];
        if (children.length > 0) {
            detailsGroup.append('text')
                .attr('x', 15)
                .attr('y', yOffset)
                .text('Children (' + children.length + '):')
                .style('font-weight', 'bold')
                .style('font-size', '13px')
                .style('fill', 'var(--vscode-editor-foreground)');

            yOffset += 20;
            children.slice(0, 3).forEach((child: any) => {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text('• ' + child.name + ' [' + child.type + ']')
                    .style('font-size', '11px')
                    .style('fill', 'var(--vscode-descriptionForeground)');
                yOffset += 15;
            });

            if (children.length > 3) {
                detailsGroup.append('text')
                    .attr('x', 25)
                    .attr('y', yOffset)
                    .text('... and ' + (children.length - 3) + ' more')
                    .style('font-size', '10px')
                    .style('font-style', 'italic')
                    .style('fill', 'var(--vscode-descriptionForeground)');
            }
        }

        const buttonY = panelHeight - 25;

        detailsGroup.append('rect')
            .attr('x', 15)
            .attr('y', buttonY)
            .attr('width', 80)
            .attr('height', 20)
            .attr('rx', 4)
            .style('fill', 'var(--vscode-button-background)')
            .style('stroke', 'var(--vscode-button-border)')
            .style('cursor', 'pointer')
            .on('click', () => {
                postMessage({ command: 'jumpToElement', elementName: nodeData.name });
            });

        detailsGroup.append('text')
            .attr('x', 55)
            .attr('y', buttonY + 14)
            .attr('text-anchor', 'middle')
            .text('Navigate')
            .style('fill', 'var(--vscode-button-foreground)')
            .style('font-size', '11px')
            .style('cursor', 'pointer')
            .on('click', () => {
                postMessage({ command: 'jumpToElement', elementName: nodeData.name });
            });
    }

    node.each(function (d: any) {
        const nodeGroup = d3.select(this);

        const displayName = d.name.length > 16 ? d.name.substring(0, 13) + '...' : d.name;
        const nameWidth = displayName.length * 8;
        const maxWidth = Math.max(nameWidth + 20, 100);
        const nodeHeight = 50;

        const el = d.element;
        const borderColor = isLibraryValidated(el) ? 'var(--vscode-charts-green)' : 'var(--vscode-panel-border)';
        const borderWidth = isLibraryValidated(el) ? '3px' : '2px';

        nodeGroup.append('rect')
            .attr('class', 'graph-node-background')
            .attr('x', -maxWidth / 2)
            .attr('y', -nodeHeight / 2)
            .attr('width', maxWidth)
            .attr('height', nodeHeight)
            .attr('rx', 8)
            .attr('ry', 8)
            .attr('data-original-stroke', borderColor)
            .attr('data-original-width', borderWidth)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', borderColor)
            .style('stroke-width', borderWidth)
            .style('filter', 'drop-shadow(2px 2px 4px rgba(0,0,0,0.2))')
            .on('click', (event: any, datum: any) => {
                event.stopPropagation();
                expandNodeDetails(datum, nodeGroup);
            })
            .on('dblclick', (event: any, datum: any) => {
                event.stopPropagation();
                postMessage({ command: 'jumpToElement', elementName: datum.name });
            });

        nodeGroup.append('text')
            .attr('class', 'node-label')
            .attr('text-anchor', 'middle')
            .attr('dy', -3)
            .text(displayName)
            .style('font-weight', '600')
            .style('font-size', '13px')
            .style('fill', 'var(--vscode-editor-foreground)');

        nodeGroup.append('text')
            .attr('class', 'node-type')
            .attr('text-anchor', 'middle')
            .attr('dy', 12)
            .text(d.type)
            .style('font-size', '10px')
            .style('fill', 'var(--vscode-descriptionForeground)')
            .style('font-style', 'italic');
    });

    simulation.on('tick', () => {
        link
            .attr('x1', (d: any) => d.source.x)
            .attr('y1', (d: any) => d.source.y)
            .attr('x2', (d: any) => d.target.x)
            .attr('y2', (d: any) => d.target.y);

        node.attr('transform', (d: any) => 'translate(' + d.x + ',' + d.y + ')');
    });

    function dragstarted(event: any) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
    }

    function dragged(event: any) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
    }

    function dragended(event: any) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
    }
}
