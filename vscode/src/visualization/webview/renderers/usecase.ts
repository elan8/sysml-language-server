/**
 * Use Case View renderer - actors, use cases, relationships.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RenderContext } from '../types';

declare const d3: any;

export function renderUseCaseView(ctx: RenderContext, data: any): void {
    const { width, height, g, usecaseLayoutOrientation, postMessage, onStartInlineEdit, renderPlaceholder } = ctx;

    if (!data || (!data.actors && !data.useCases) ||
        (data.actors && data.actors.length === 0 && data.useCases && data.useCases.length === 0)) {
        renderPlaceholder(width, height, 'Use Case View',
            'No actors or use cases found to display.\\n\\nThis view shows actors, use cases, and their relationships.',
            data);
        return;
    }

    const actors = data.actors || [];
    const useCases = data.useCases || [];
    const actions = data.actions || [];
    const requirements = data.requirements || [];
    const relationships = data.relationships || [];

    const useCaseWidth = 140;
    const useCaseHeight = 70;
    const actionWidth = 120;
    const actionHeight = 40;
    const requirementWidth = 130;
    const requirementHeight = 50;
    const actorSize = 60;
    const marginLeft = 80;
    const marginTop = 80;
    const horizontalSpacing = 180;
    const verticalSpacing = 120;
    const actorPositions = new Map<string, { x: number; y: number; actor: any }>();
    const useCasePositions = new Map<string, { x: number; y: number; useCase: any }>();
    const actionPositions = new Map<string, { x: number; y: number; action: any }>();
    const requirementPositions = new Map<string, { x: number; y: number; requirement: any }>();

    if (usecaseLayoutOrientation === 'force') {
        const allNodes = [
            ...actors.map((a: any) => ({ id: a.name, type: 'actor', data: a, x: Math.random() * width, y: Math.random() * height })),
            ...useCases.map((uc: any) => ({ id: uc.name, type: 'usecase', data: uc, x: Math.random() * width, y: Math.random() * height })),
            ...actions.map((a: any) => ({ id: a.name, type: 'action', data: a, x: Math.random() * width, y: Math.random() * height })),
            ...requirements.map((r: any) => ({ id: r.name, type: 'requirement', data: r, x: Math.random() * width, y: Math.random() * height }))
        ];

        const nodeMap = new Map<string, any>();
        allNodes.forEach((n: any) => nodeMap.set(n.id, n));

        const links = relationships.map((r: any) => ({
            source: nodeMap.get(r.source),
            target: nodeMap.get(r.target)
        })).filter((l: any) => l.source && l.target);

        const simulation = d3.forceSimulation(allNodes)
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('charge', d3.forceManyBody().strength(-400))
            .force('link', d3.forceLink(links).distance(200).strength(0.5))
            .force('collide', d3.forceCollide().radius(100))
            .force('x', d3.forceX(width / 2).strength(0.05))
            .force('y', d3.forceY(height / 2).strength(0.05));

        simulation.stop();
        for (let i = 0; i < 300; ++i) simulation.tick();

        allNodes.forEach((n: any) => {
            const x = Math.max(marginLeft, Math.min(width - marginLeft - useCaseWidth, n.x));
            const y = Math.max(marginTop, Math.min(height - marginTop - useCaseHeight, n.y));
            if (n.type === 'actor') {
                actorPositions.set(n.id, { x: x + actorSize / 2, y: y + actorSize / 2, actor: n.data });
            } else if (n.type === 'action') {
                actionPositions.set(n.id, { x: x, y: y, action: n.data });
            } else if (n.type === 'requirement') {
                requirementPositions.set(n.id, { x: x, y: y, requirement: n.data });
            } else {
                useCasePositions.set(n.id, { x: x, y: y, useCase: n.data });
            }
        });
    } else if (usecaseLayoutOrientation === 'vertical') {
        const actorSpacing = Math.min(120, (width - marginLeft * 2) / Math.max(actors.length, 1));
        const actorStartX = marginLeft + (width - marginLeft * 2 - (actors.length - 1) * actorSpacing) / 2;

        actors.forEach((actor: any, index: number) => {
            actorPositions.set(actor.name, {
                x: actorStartX + index * actorSpacing,
                y: marginTop + 40,
                actor: actor
            });
        });

        const cols = Math.ceil(Math.sqrt(useCases.length * 1.5));
        const useCaseSpacingX = useCaseWidth + 40;
        const useCaseSpacingY = useCaseHeight + 40;
        const useCaseStartX = marginLeft + (width - marginLeft * 2 - (cols - 1) * useCaseSpacingX - useCaseWidth) / 2;
        const useCaseStartY = marginTop + 160;
        const useCaseRows = Math.ceil(useCases.length / cols);

        useCases.forEach((useCase: any, index: number) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            useCasePositions.set(useCase.name, {
                x: useCaseStartX + col * useCaseSpacingX,
                y: useCaseStartY + row * useCaseSpacingY,
                useCase: useCase
            });
        });

        const useCaseBottomY = useCaseStartY + useCaseRows * useCaseSpacingY + 40;

        let actionsBottomY = useCaseBottomY;
        if (actions.length > 0) {
            const actionSpacingX = actionWidth + 30;
            const actionStartY = useCaseBottomY;
            const actionCols = Math.ceil(Math.sqrt(actions.length * 2));
            const actionStartX = marginLeft + (width - marginLeft * 2 - (actionCols - 1) * actionSpacingX - actionWidth) / 2;
            const actionRows = Math.ceil(actions.length / actionCols);

            actions.forEach((action: any, index: number) => {
                const col = index % actionCols;
                const row = Math.floor(index / actionCols);
                actionPositions.set(action.name, {
                    x: actionStartX + col * actionSpacingX,
                    y: actionStartY + row * (actionHeight + 30),
                    action: action
                });
            });

            actionsBottomY = actionStartY + actionRows * (actionHeight + 30) + 40;
        }

        if (requirements.length > 0) {
            const reqSpacingX = requirementWidth + 30;
            const reqCols = Math.min(requirements.length, Math.floor((width - marginLeft * 2) / reqSpacingX));
            const reqStartX = marginLeft + (width - marginLeft * 2 - (Math.min(requirements.length, reqCols) - 1) * reqSpacingX - requirementWidth) / 2;

            requirements.forEach((req: any, index: number) => {
                const col = index % reqCols;
                const row = Math.floor(index / reqCols);
                requirementPositions.set(req.name, {
                    x: reqStartX + col * reqSpacingX,
                    y: actionsBottomY + row * (requirementHeight + 20),
                    requirement: req
                });
            });
        }
    } else {
        const centerX = width / 2;

        const actorSpacing = Math.min(120, (width - marginLeft * 2) / Math.max(actors.length, 1));
        const actorStartX = marginLeft + (width - marginLeft * 2 - (actors.length - 1) * actorSpacing) / 2;
        const actorRowY = marginTop + 40;

        actors.forEach((actor: any, index: number) => {
            actorPositions.set(actor.name, {
                x: actorStartX + index * actorSpacing,
                y: actorRowY,
                actor: actor
            });
        });

        const useCaseStartY = actorRowY + actorSize + 80;
        const cols = Math.ceil(Math.sqrt(useCases.length * 1.5));
        const useCaseSpacingX = useCaseWidth + 50;
        const useCaseSpacingY = useCaseHeight + 50;
        const useCaseStartX = centerX - (cols * useCaseSpacingX) / 2;
        const useCaseRows = Math.ceil(useCases.length / cols);

        useCases.forEach((useCase: any, index: number) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            useCasePositions.set(useCase.name, {
                x: useCaseStartX + col * useCaseSpacingX,
                y: useCaseStartY + row * useCaseSpacingY,
                useCase: useCase
            });
        });

        const useCaseBottomY = useCaseStartY + useCaseRows * useCaseSpacingY + 40;

        if (actions.length > 0) {
            const actionCols = Math.ceil(Math.sqrt(actions.length * 2));
            const actionSpacingX = actionWidth + 30;
            const actionSpacingY = actionHeight + 25;
            const actionStartX = centerX - (actionCols * actionSpacingX) / 2;

            actions.forEach((action: any, index: number) => {
                const col = index % actionCols;
                const row = Math.floor(index / actionCols);
                actionPositions.set(action.name, {
                    x: actionStartX + col * actionSpacingX,
                    y: useCaseBottomY + row * actionSpacingY,
                    action: action
                });
            });
        }

        if (requirements.length > 0) {
            const actionRows = actions.length > 0 ? Math.ceil(actions.length / Math.ceil(Math.sqrt(actions.length * 2))) : 0;
            const reqStartY = useCaseBottomY + actionRows * (actionHeight + 25) + 60;

            const reqSpacingX = requirementWidth + 30;
            const reqCols = Math.min(requirements.length, Math.floor((width - marginLeft * 2) / reqSpacingX));
            const reqStartX = centerX - (Math.min(requirements.length, reqCols) * reqSpacingX) / 2;
            const reqRows = Math.ceil(requirements.length / reqCols);

            requirements.forEach((req: any, index: number) => {
                const col = index % reqCols;
                const row = Math.floor(index / reqCols);
                requirementPositions.set(req.name, {
                    x: reqStartX + col * reqSpacingX,
                    y: reqStartY + row * (requirementHeight + 20),
                    requirement: req
                });
            });
        }
    }

    function findActorPosition(name: string) {
        if (actorPositions.has(name)) {
            return actorPositions.get(name);
        }
        const nameLower = name.toLowerCase();
        for (const [key, value] of actorPositions.entries()) {
            if (key.toLowerCase() === nameLower) {
                return value;
            }
        }
        return undefined;
    }

    const relationshipGroup = g.append('g').attr('class', 'usecase-relationships');

    function drawUseCaseRelationships() {
        relationshipGroup.selectAll('*').remove();

        relationships.forEach((rel: any) => {
            let startX: number, startY: number, endX: number, endY: number;

            if (rel.type === 'include') {
                const sourcePos = actionPositions.get(rel.source);
                const targetPos = actionPositions.get(rel.target);

                if (!sourcePos || !targetPos) return;

                startX = sourcePos.x + actionWidth / 2;
                startY = sourcePos.y + actionHeight;
                endX = targetPos.x + actionWidth / 2;
                endY = targetPos.y;

                const relGroup = relationshipGroup.append('g');
                relGroup.append('line')
                    .attr('x1', startX)
                    .attr('y1', startY)
                    .attr('x2', endX)
                    .attr('y2', endY)
                    .style('stroke', 'var(--vscode-charts-orange)')
                    .style('stroke-width', '1.5px')
                    .style('stroke-dasharray', '4,2');

                const angle = Math.atan2(endY - startY, endX - startX);
                const arrowSize = 6;
                relGroup.append('polygon')
                    .attr('points', [
                        [endX, endY],
                        [endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6)],
                        [endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6)]
                    ].map((p: number[]) => p.join(',')).join(' '))
                    .style('fill', 'var(--vscode-charts-orange)');

                const midX = (startX + endX) / 2;
                const midY = (startY + endY) / 2;
                relGroup.append('text')
                    .attr('x', midX + 5)
                    .attr('y', midY - 5)
                    .attr('text-anchor', 'start')
                    .style('font-size', '9px')
                    .style('fill', 'var(--vscode-charts-orange)')
                    .style('font-style', 'italic')
                    .text('«include»');

                return;
            }

            if (rel.type === 'realize') {
                const sourcePos = useCasePositions.get(rel.source);
                const targetPos = actionPositions.get(rel.target);

                if (!sourcePos || !targetPos) return;

                startX = sourcePos.x + useCaseWidth / 2;
                startY = sourcePos.y + useCaseHeight;
                endX = targetPos.x + actionWidth / 2;
                endY = targetPos.y;

                relationshipGroup.append('line')
                    .attr('x1', startX)
                    .attr('y1', startY)
                    .attr('x2', endX)
                    .attr('y2', endY)
                    .style('stroke', 'var(--vscode-charts-yellow)')
                    .style('stroke-width', '2px')
                    .style('stroke-dasharray', '5,3');

                const angle = Math.atan2(endY - startY, endX - startX);
                const arrowSize = 8;
                relationshipGroup.append('polygon')
                    .attr('points', [
                        [endX, endY],
                        [endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6)],
                        [endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6)]
                    ].map((p: number[]) => p.join(',')).join(' '))
                    .style('fill', 'var(--vscode-charts-yellow)');

                return;
            }

            if (rel.type === 'stakeholder') {
                const sourcePos = requirementPositions.get(rel.source);
                const targetPos = findActorPosition(rel.target);

                if (!sourcePos || !targetPos) return;

                startX = sourcePos.x + requirementWidth / 2;
                startY = sourcePos.y;
                endX = targetPos.x;
                endY = targetPos.y + actorSize / 2;

                const relGroup = relationshipGroup.append('g');
                relGroup.append('line')
                    .attr('x1', startX)
                    .attr('y1', startY)
                    .attr('x2', endX)
                    .attr('y2', endY)
                    .style('stroke', 'var(--vscode-charts-green)')
                    .style('stroke-width', '1.5px')
                    .style('stroke-dasharray', '4,2');

                const angle = Math.atan2(endY - startY, endX - startX);
                const arrowSize = 6;
                relGroup.append('polygon')
                    .attr('points', [
                        [endX, endY],
                        [endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6)],
                        [endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6)]
                    ].map((p: number[]) => p.join(',')).join(' '))
                    .style('fill', 'var(--vscode-charts-green)');

                const midX = (startX + endX) / 2;
                const midY = (startY + endY) / 2;
                relGroup.append('text')
                    .attr('x', midX)
                    .attr('y', midY - 5)
                    .attr('text-anchor', 'middle')
                    .style('font-size', '9px')
                    .style('fill', 'var(--vscode-charts-green)')
                    .style('font-style', 'italic')
                    .text('«stakeholder»');

                return;
            }

            const sourcePos = findActorPosition(rel.source);
            const targetPos = useCasePositions.get(rel.target);

            if (!sourcePos || !targetPos) return;

            startX = sourcePos.x;
            startY = sourcePos.y + actorSize / 2;
            endX = targetPos.x + useCaseWidth / 2;
            endY = targetPos.y;

            const lineColor = rel.type === 'subject' ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-blue)';
            const lineStyle = rel.type === 'subject' ? '5,3' : 'none';

            relationshipGroup.append('line')
                .attr('x1', startX)
                .attr('y1', startY)
                .attr('x2', endX)
                .attr('y2', endY)
                .style('stroke', lineColor)
                .style('stroke-width', '2px')
                .style('stroke-dasharray', lineStyle);

            if (rel.label) {
                const midX = (startX + endX) / 2;
                const midY = (startY + endY) / 2;

                const maxLabelLength = 40;
                let labelText = rel.label;
                if (labelText.length > maxLabelLength) {
                    labelText = labelText.substring(0, maxLabelLength - 3) + '...';
                }

                const labelPadding = 4;
                const labelGroup = relationshipGroup.append('g')
                    .attr('transform', 'translate(' + midX + ',' + midY + ')');

                const textElement = labelGroup.append('text')
                    .attr('text-anchor', 'middle')
                    .attr('dominant-baseline', 'middle')
                    .style('font-size', '10px')
                    .style('fill', 'var(--vscode-descriptionForeground)')
                    .style('font-style', 'italic')
                    .text(labelText);

                const bbox = textElement.node().getBBox();
                labelGroup.insert('rect', 'text')
                    .attr('x', bbox.x - labelPadding)
                    .attr('y', bbox.y - labelPadding / 2)
                    .attr('width', bbox.width + labelPadding * 2)
                    .attr('height', bbox.height + labelPadding)
                    .style('fill', 'var(--vscode-editor-background)')
                    .style('opacity', 0.9);
            }
        });
    }

    drawUseCaseRelationships();

    const useCaseGroup = g.append('g').attr('class', 'usecase-nodes');

    useCasePositions.forEach((pos, useCaseName) => {
        const useCase = pos.useCase;

        const useCaseElement = useCaseGroup.append('g')
            .attr('class', 'usecase-node')
            .attr('transform', 'translate(' + pos.x + ',' + pos.y + ')')
            .style('cursor', 'grab');

        const useCaseDrag = d3.drag()
            .on('start', function() {
                d3.select(this).raise().style('cursor', 'grabbing');
            })
            .on('drag', function(event: any) {
                pos.x += event.dx;
                pos.y += event.dy;
                d3.select(this).attr('transform', 'translate(' + pos.x + ',' + pos.y + ')');
                drawUseCaseRelationships();
            })
            .on('end', function() {
                d3.select(this).style('cursor', 'grab');
            });

        useCaseElement.call(useCaseDrag);

        useCaseElement.append('ellipse')
            .attr('cx', useCaseWidth / 2)
            .attr('cy', useCaseHeight / 2)
            .attr('rx', useCaseWidth / 2)
            .attr('ry', useCaseHeight / 2)
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', 'var(--vscode-charts-purple)')
            .style('stroke-width', '2px');

        useCaseElement.on('click', function(event: any) {
            event.stopPropagation();
            postMessage({
                command: 'jumpToElement',
                elementName: useCase.name
            });
        })
        .on('dblclick', function(event: any) {
            event.stopPropagation();
            onStartInlineEdit(d3.select(this), useCase.name, pos.x, pos.y, useCaseWidth);
        });

        const maxChars = 16;
        const words = useCase.name.split(' ');
        let line1 = '';
        let line2 = '';

        if (useCase.name.length <= maxChars) {
            line1 = useCase.name;
        } else {
            let charCount = 0;
            for (let i = 0; i < words.length; i++) {
                if (charCount + words[i].length > maxChars && line1) {
                    line2 = words.slice(i).join(' ');
                    break;
                }
                line1 += (i > 0 ? ' ' : '') + words[i];
                charCount += words[i].length + 1;
            }
            if (line1.length > maxChars) {
                line1 = line1.substring(0, maxChars - 3) + '...';
            }
            if (line2.length > maxChars) {
                line2 = line2.substring(0, maxChars - 3) + '...';
            }
        }

        if (line2) {
            useCaseElement.append('text')
                .attr('class', 'node-name-text')
                .attr('data-element-name', useCase.name)
                .attr('x', useCaseWidth / 2)
                .attr('y', useCaseHeight / 2 - 6)
                .attr('text-anchor', 'middle')
                .text(line1)
                .style('font-size', '12px')
                .style('fill', 'var(--vscode-editor-foreground)')
                .style('user-select', 'none');

            useCaseElement.append('text')
                .attr('x', useCaseWidth / 2)
                .attr('y', useCaseHeight / 2 + 8)
                .attr('text-anchor', 'middle')
                .text(line2)
                .style('font-size', '12px')
                .style('fill', 'var(--vscode-editor-foreground)')
                .style('user-select', 'none');
        } else {
            useCaseElement.append('text')
                .attr('class', 'node-name-text')
                .attr('data-element-name', useCase.name)
                .attr('x', useCaseWidth / 2)
                .attr('y', useCaseHeight / 2 + 4)
                .attr('text-anchor', 'middle')
                .text(line1)
                .style('font-size', '12px')
                .style('fill', 'var(--vscode-editor-foreground)')
                .style('user-select', 'none');
        }
    });

    const requirementGroup = g.append('g').attr('class', 'requirement-nodes');

    requirementPositions.forEach((pos, reqName) => {
        const requirement = pos.requirement;

        const reqElement = requirementGroup.append('g')
            .attr('class', 'requirement-node')
            .attr('transform', 'translate(' + pos.x + ',' + pos.y + ')')
            .style('cursor', 'grab');

        const reqDrag = d3.drag()
            .on('start', function() {
                d3.select(this).raise().style('cursor', 'grabbing');
            })
            .on('drag', function(event: any) {
                pos.x += event.dx;
                pos.y += event.dy;
                d3.select(this).attr('transform', 'translate(' + pos.x + ',' + pos.y + ')');
                drawUseCaseRelationships();
            })
            .on('end', function() {
                d3.select(this).style('cursor', 'grab');
            });

        reqElement.call(reqDrag);

        reqElement.append('path')
            .attr('d', 'M0,0 L' + (requirementWidth - 12) + ',0 L' + requirementWidth + ',12 L' + requirementWidth + ',' + requirementHeight + ' L0,' + requirementHeight + ' Z')
            .style('fill', 'var(--vscode-editor-background)')
            .style('stroke', '#B5CEA8')
            .style('stroke-width', '2px');

        reqElement.on('click', function(event: any) {
            event.stopPropagation();
            postMessage({
                command: 'jumpToElement',
                elementName: requirement.name
            });
        })
        .on('dblclick', function(event: any) {
            event.stopPropagation();
            onStartInlineEdit(d3.select(this), requirement.name, pos.x, pos.y, requirementWidth);
        });

        reqElement.append('path')
            .attr('d', 'M' + (requirementWidth - 12) + ',0 L' + (requirementWidth - 12) + ',12 L' + requirementWidth + ',12')
            .style('fill', 'none')
            .style('stroke', '#B5CEA8')
            .style('stroke-width', '1px');

        reqElement.append('text')
            .attr('x', requirementWidth / 2)
            .attr('y', 12)
            .attr('text-anchor', 'middle')
            .text('«req»')
            .style('font-size', '9px')
            .style('fill', '#B5CEA8')
            .style('font-style', 'italic')
            .style('user-select', 'none');

        const maxChars = 18;
        let displayName = requirement.name;
        if (displayName.length > maxChars) {
            displayName = displayName.substring(0, maxChars - 3) + '...';
        }

        reqElement.append('text')
            .attr('class', 'node-name-text')
            .attr('data-element-name', requirement.name)
            .attr('x', requirementWidth / 2)
            .attr('y', requirementHeight / 2 + 6)
            .attr('text-anchor', 'middle')
            .text(displayName)
            .style('font-size', '11px')
            .style('fill', 'var(--vscode-editor-foreground)')
            .style('font-weight', '500')
            .style('user-select', 'none');
    });

    const actorGroup = g.append('g').attr('class', 'actor-nodes');

    actorPositions.forEach((pos, actorName) => {
        const actor = pos.actor;

        const actorElement = actorGroup.append('g')
            .attr('class', 'actor-node')
            .attr('transform', 'translate(' + (pos.x - actorSize / 2) + ',' + (pos.y - actorSize / 2) + ')')
            .style('cursor', 'grab');

        actorElement.on('click', function(event: any) {
            event.stopPropagation();
            postMessage({
                command: 'jumpToElement',
                elementName: actor.name
            });
        })
        .on('dblclick', function(event: any) {
            event.stopPropagation();
            onStartInlineEdit(d3.select(this), actor.name, pos.x - actorSize / 2, pos.y - actorSize / 2, actorSize);
        });

        const actorDrag = d3.drag()
            .on('start', function() {
                d3.select(this).raise().style('cursor', 'grabbing');
            })
            .on('drag', function(event: any) {
                pos.x += event.dx;
                pos.y += event.dy;
                d3.select(this).attr('transform', 'translate(' + (pos.x - actorSize / 2) + ',' + (pos.y - actorSize / 2) + ')');
                drawUseCaseRelationships();
            })
            .on('end', function() {
                d3.select(this).style('cursor', 'grab');
            });

        actorElement.call(actorDrag);

        const headRadius = 8;
        const bodyHeight = 20;
        const armWidth = 12;
        const legHeight = 15;

        actorElement.append('circle')
            .attr('cx', actorSize / 2)
            .attr('cy', 10)
            .attr('r', headRadius)
            .style('fill', 'none')
            .style('stroke', 'var(--vscode-charts-orange)')
            .style('stroke-width', '2px');

        actorElement.append('line')
            .attr('x1', actorSize / 2)
            .attr('y1', 10 + headRadius)
            .attr('x2', actorSize / 2)
            .attr('y2', 10 + headRadius + bodyHeight)
            .style('stroke', 'var(--vscode-charts-orange)')
            .style('stroke-width', '2px');

        actorElement.append('line')
            .attr('x1', actorSize / 2 - armWidth)
            .attr('y1', 10 + headRadius + 8)
            .attr('x2', actorSize / 2 + armWidth)
            .attr('y2', 10 + headRadius + 8)
            .style('stroke', 'var(--vscode-charts-orange)')
            .style('stroke-width', '2px');

        actorElement.append('line')
            .attr('x1', actorSize / 2)
            .attr('y1', 10 + headRadius + bodyHeight)
            .attr('x2', actorSize / 2 - armWidth)
            .attr('y2', 10 + headRadius + bodyHeight + legHeight)
            .style('stroke', 'var(--vscode-charts-orange)')
            .style('stroke-width', '2px');

        actorElement.append('line')
            .attr('x1', actorSize / 2)
            .attr('y1', 10 + headRadius + bodyHeight)
            .attr('x2', actorSize / 2 + armWidth)
            .attr('y2', 10 + headRadius + bodyHeight + legHeight)
            .style('stroke', 'var(--vscode-charts-orange)')
            .style('stroke-width', '2px');

        const truncatedName = actor.name.length > 12 ? actor.name.substring(0, 9) + '...' : actor.name;
        actorElement.append('text')
            .attr('class', 'node-name-text')
            .attr('data-element-name', actor.name)
            .attr('x', actorSize / 2)
            .attr('y', 10 + headRadius + bodyHeight + legHeight + 18)
            .attr('text-anchor', 'middle')
            .text(truncatedName)
            .style('font-size', '11px')
            .style('fill', 'var(--vscode-editor-foreground)')
            .style('user-select', 'none');
    });

    if (actionPositions.size > 0) {
        const actionGroup = g.append('g').attr('class', 'action-nodes');

        actionPositions.forEach((pos, actionName) => {
            const action = pos.action;

            const actionElement = actionGroup.append('g')
                .attr('class', 'action-node')
                .attr('transform', 'translate(' + pos.x + ',' + pos.y + ')')
                .style('cursor', 'grab');

            actionElement.on('click', function(event: any) {
                event.stopPropagation();
                postMessage({
                    command: 'jumpToElement',
                    elementName: action.name
                });
            })
            .on('dblclick', function(event: any) {
                event.stopPropagation();
                onStartInlineEdit(d3.select(this), action.name, pos.x, pos.y, actionWidth);
            });

            const actionDrag = d3.drag()
                .on('start', function() {
                    d3.select(this).raise().style('cursor', 'grabbing');
                })
                .on('drag', function(event: any) {
                    pos.x += event.dx;
                    pos.y += event.dy;
                    d3.select(this).attr('transform', 'translate(' + pos.x + ',' + pos.y + ')');
                    drawUseCaseRelationships();
                })
                .on('end', function() {
                    d3.select(this).style('cursor', 'grab');
                });

            actionElement.call(actionDrag);

            actionElement.append('rect')
                .attr('x', 0)
                .attr('y', 0)
                .attr('width', actionWidth)
                .attr('height', actionHeight)
                .attr('rx', 15)
                .attr('ry', 15)
                .style('fill', 'var(--vscode-editor-background)')
                .style('stroke', 'var(--vscode-charts-yellow)')
                .style('stroke-width', '2px');

            const truncatedActionName = action.name.length > 18
                ? action.name.substring(0, 15) + '...'
                : action.name;

            actionElement.append('text')
                .attr('class', 'node-name-text')
                .attr('data-element-name', action.name)
                .attr('x', actionWidth / 2)
                .attr('y', actionHeight / 2 + 4)
                .attr('text-anchor', 'middle')
                .text(truncatedActionName)
                .style('font-size', '11px')
                .style('fill', 'var(--vscode-editor-foreground)')
                .style('user-select', 'none');
        });
    }
}
