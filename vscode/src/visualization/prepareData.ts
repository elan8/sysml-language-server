/**
 * prepareDataForView - Transforms generic model data into view-specific structures.
 * Helper functions (collectAllElements, removeCircularRefs, extractNestedParts, etc.)
 * are used internally. For browser/webview context.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function prepareDataForView(data: any, view: string): any {
    if (!data) {
        return data;
    }

    const elements = data.elements || [];
    const relationships = data.relationships || [];

    function collectAllElements(elementList: any[], collected: any[] = [], parentElement: any = null): any[] {
        elementList.forEach((el: any) => {
            if (parentElement && !el.parent) {
                el.parent = parentElement.name;
            }
            collected.push(el);
            if (el.children && el.children.length > 0) {
                collectAllElements(el.children, collected, el);
            }
        });
        return collected;
    }

    function removeCircularRefs(obj: any): any {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj.parentElement) {
            delete obj.parentElement;
        }
        if (obj.children && Array.isArray(obj.children)) {
            obj.children.forEach((child: any) => removeCircularRefs(child));
        }
        return obj;
    }

    const allElements = collectAllElements(elements);

    switch (view) {
        case 'ibd': {
            const ibdParts: any[] = [];
            const seenParts = new Set<string>();

            const extractNestedParts = (element: any, parentPath = '') => {
                if (!element || !element.children) return;
                element.children.forEach((child: any) => {
                    if (!child || !child.type) return;
                    const childTypeLower = child.type.toLowerCase();
                    if ((childTypeLower === 'part' || childTypeLower === 'part usage' ||
                        (childTypeLower.includes('part') && !childTypeLower.includes('def'))) &&
                        !seenParts.has(child.name)) {
                        const qualifiedName = parentPath ? parentPath + '.' + child.name : child.name;
                        ibdParts.push({
                            ...child,
                            containerId: element.name,
                            containerType: element.type,
                            qualifiedName: qualifiedName
                        });
                        seenParts.add(child.name);
                        extractNestedParts(child, qualifiedName);
                    }
                });
            };

            allElements.forEach((el: any) => {
                if (!el.type) return;
                const typeLower = el.type.toLowerCase();
                if ((typeLower === 'part' || typeLower === 'part usage' ||
                    (typeLower.includes('part') && !typeLower.includes('def'))) &&
                    !seenParts.has(el.name)) {
                    ibdParts.push({ ...el, qualifiedName: el.name });
                    seenParts.add(el.name);
                    extractNestedParts(el, el.name);
                }
            });

            const partDefs = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                return typeLower === 'part def' || typeLower === 'part definition';
            });
            partDefs.forEach((partDef: any) => extractNestedParts(partDef, ''));

            const ibdPorts: any[] = [];
            const processPortsFromPart = (part: any, partId: string) => {
                if (part.children) {
                    part.children.forEach((child: any) => {
                        if (child.type && child.type.toLowerCase().includes('port')) {
                            ibdPorts.push({
                                ...child,
                                id: child.id || child.name,
                                parentId: partId,
                                direction: child.direction ||
                                    (child.type.toLowerCase().includes('in') ? 'in' :
                                     child.type.toLowerCase().includes('out') ? 'out' : 'inout')
                            });
                        }
                    });
                }
            };
            ibdParts.forEach((part: any) => {
                const partId = part.id || part.name;
                processPortsFromPart(part, partId);
            });

            allElements.forEach((el: any) => {
                if (el.type && el.type.toLowerCase().includes('port')) {
                    const existingPort = ibdPorts.find((p: any) => p.name === el.name);
                    if (!existingPort) {
                        ibdPorts.push({
                            ...el,
                            id: el.id || el.name,
                            parentId: el.parentId || 'root',
                            direction: el.direction || 'inout'
                        });
                    }
                }
            });

            const ibdConnectors: any[] = [];
            const explicitConnectors = relationships.filter((rel: any) => rel.type && (
                rel.type.includes('connection') || rel.type.includes('flow') ||
                rel.type.includes('binding') || rel.type.includes('interface') ||
                rel.type.includes('allocation') || rel.type.includes('dependency')
            ));
            explicitConnectors.forEach((rel: any) => {
                ibdConnectors.push({ ...rel, sourceId: rel.source, targetId: rel.target });
            });

            ibdParts.forEach((part: any) => {
                const types = (part.typings && part.typings.length > 0)
                    ? part.typings : (part.typing ? [part.typing] : []);
                types.forEach((typeName: string) => {
                    if (typeName && typeName !== part.name) {
                        const typedElement = allElements.find((el: any) =>
                            el.name === typeName || el.id === typeName
                        );
                        if (typedElement) {
                            ibdConnectors.push({
                                source: part.name,
                                target: typedElement.name,
                                sourceId: part.name,
                                targetId: typedElement.name,
                                type: 'typing',
                                name: 'type'
                            });
                        }
                    }
                });
            });

            relationships
                .filter((rel: any) => rel.type && (
                    rel.type.includes('attribute') || rel.type.includes('property') ||
                    rel.type.includes('reference')
                ))
                .forEach((rel: any) => {
                    const sourceInParts = ibdParts.some((p: any) => p.name === rel.source || p.id === rel.source);
                    const targetInParts = ibdParts.some((p: any) => p.name === rel.target || p.id === rel.target);
                    if (sourceInParts && targetInParts) {
                        ibdConnectors.push({ ...rel, sourceId: rel.source, targetId: rel.target });
                    }
                });

            let focusPart: any = null;
            let focusedParts = ibdParts;

            const partsWithChildren = allElements.filter((el: any) => {
                if (!el.type || !el.children || el.children.length === 0) return false;
                const typeLower = el.type.toLowerCase();
                const isPartDef = typeLower.includes('part def');
                const isPartUsage = (typeLower === 'part' || typeLower === 'part usage' ||
                    (typeLower.includes('part') && !typeLower.includes('def')));
                if (!isPartDef && !isPartUsage) return false;
                return el.children.some((c: any) => c.type && c.type.toLowerCase().includes('part'));
            });

            if (partsWithChildren.length > 0) {
                partsWithChildren.sort((a: any, b: any) => {
                    const aPartCount = a.children.filter((c: any) => c.type && c.type.toLowerCase().includes('part')).length;
                    const bPartCount = b.children.filter((c: any) => c.type && c.type.toLowerCase().includes('part')).length;
                    return bPartCount - aPartCount;
                });

                focusedParts = [];
                const processedPartNames = new Set<string>();

                for (const currentFocusPart of partsWithChildren) {
                    if (processedPartNames.has(currentFocusPart.name)) continue;
                    processedPartNames.add(currentFocusPart.name);
                    focusPart = currentFocusPart;
                    const partChildren = currentFocusPart.children.filter((c: any) =>
                        c.type && c.type.toLowerCase().includes('part')
                    );

                    focusedParts.push({
                        name: currentFocusPart.name,
                        type: currentFocusPart.type,
                        id: currentFocusPart.id || currentFocusPart.name,
                        attributes: currentFocusPart.attributes || {},
                        children: currentFocusPart.children || []
                    });

                    for (const child of partChildren) {
                        if (processedPartNames.has(child.name)) continue;
                        processedPartNames.add(child.name);
                        let enrichedChild = ibdParts.find((p: any) => p.name === child.name);
                        if (!enrichedChild) {
                            enrichedChild = { ...child, qualifiedName: child.name };
                        }
                        try {
                            if (enrichedChild && enrichedChild.name) {
                                const partDef = allElements.find((el: any) =>
                                    el && el.type && el.name &&
                                    el.type.toLowerCase().includes('part def') &&
                                    el.name === (enrichedChild.typing || child.typing)
                                );
                                if (partDef && partDef.children) {
                                    enrichedChild = { ...enrichedChild, children: partDef.children };
                                }
                            }
                        } catch {
                            // Skip enrichment on error
                        }
                        focusedParts.push(enrichedChild);
                        ibdConnectors.push({
                            source: currentFocusPart.name,
                            target: child.name,
                            sourceId: currentFocusPart.name,
                            targetId: child.name,
                            type: 'composition',
                            name: 'contains'
                        });
                    }

                    if (currentFocusPart.children) {
                        currentFocusPart.children.forEach((child: any) => {
                            if (!child || !child.type) return;
                            const childType = child.type.toLowerCase();
                            if (childType === 'connection' || childType === 'connect' || childType === 'bind' || childType === 'binding') {
                                const from = child.attributes?.get?.('from') || child.attributes?.from;
                                const to = child.attributes?.get?.('to') || child.attributes?.to;
                                if (from && to) {
                                    ibdConnectors.push({
                                        source: from,
                                        target: to,
                                        sourceId: from,
                                        targetId: to,
                                        type: childType === 'bind' || childType === 'binding' ? 'binding' : 'connection',
                                        name: child.name || childType
                                    });
                                }
                            }
                        });
                    }
                }
            }

            return {
                ...data,
                elements: focusedParts,
                parts: focusedParts,
                ports: ibdPorts,
                connectors: ibdConnectors
            };
        }

        case 'activity': {
            if (data.activityDiagrams && data.activityDiagrams.length > 0) {
                return {
                    ...data,
                    diagrams: data.activityDiagrams.map((diagram: any) => {
                        const decisionsAsActions = (diagram.decisions || []).map((d: any) => ({
                            ...d,
                            id: d.id || d.name,
                            type: 'decision',
                            kind: 'decision'
                        }));

                        const allActions = [
                            ...(diagram.actions || []).map((a: any) => ({
                                ...a,
                                id: a.id || a.name,
                                parent: (a.parent === diagram.name) ? undefined : a.parent
                            })),
                            ...decisionsAsActions
                        ];

                        const actionIds = new Set(allActions.map((a: any) => a.id || a.name));
                        const flows = diagram.flows || [];
                        const flowNodeNames = new Set<string>();
                        const incomingFlowCount = new Map<string, number>();
                        const outgoingFlowCount = new Map<string, number>();

                        flows.forEach((f: any) => {
                            if (f.from) {
                                flowNodeNames.add(f.from);
                                outgoingFlowCount.set(f.from, (outgoingFlowCount.get(f.from) || 0) + 1);
                            }
                            if (f.to) {
                                flowNodeNames.add(f.to);
                                incomingFlowCount.set(f.to, (incomingFlowCount.get(f.to) || 0) + 1);
                            }
                        });

                        flowNodeNames.forEach((nodeName: string) => {
                            if (!actionIds.has(nodeName)) {
                                const incoming = incomingFlowCount.get(nodeName) || 0;
                                const outgoing = outgoingFlowCount.get(nodeName) || 0;
                                const nameLower = nodeName.toLowerCase();
                                let nodeType = 'action';
                                let nodeKind = 'action';

                                if (nameLower.includes('merge') || nameLower.includes('join') || nameLower.endsWith('check')) {
                                    nodeType = 'merge';
                                    nodeKind = 'merge';
                                } else if (nameLower.includes('fork')) {
                                    nodeType = 'fork';
                                    nodeKind = 'fork';
                                } else if (nameLower.includes('decision') || nameLower.includes('decide')) {
                                    nodeType = 'decision';
                                    nodeKind = 'decision';
                                } else if (incoming > 1) {
                                    nodeType = 'merge';
                                    nodeKind = 'merge';
                                } else if (outgoing > 1) {
                                    const hasGuards = flows.some((f: any) => f.from === nodeName && (f.guard || f.condition));
                                    if (hasGuards) {
                                        nodeType = 'decision';
                                        nodeKind = 'decision';
                                    } else {
                                        nodeType = 'fork';
                                        nodeKind = 'fork';
                                    }
                                }

                                allActions.push({
                                    name: nodeName,
                                    id: nodeName,
                                    type: nodeType,
                                    kind: nodeKind
                                });
                                actionIds.add(nodeName);
                            }
                        });

                        const cleanFlows = flows.filter((f: any) =>
                            f.from !== f.to &&
                            actionIds.has(f.from) &&
                            actionIds.has(f.to)
                        );

                        return {
                            name: diagram.name,
                            actions: allActions,
                            flows: cleanFlows,
                            decisions: diagram.decisions || [],
                            states: diagram.states || []
                        };
                    })
                };
            }

            const actionDefs = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                return typeLower === 'action' || typeLower === 'action def' || typeLower === 'action definition';
            });
            const activityActionDefs = actionDefs.filter((a: any) => a.children && a.children.length > 0);

            return {
                ...data,
                diagrams: activityActionDefs.map((actionDef: any) => {
                    const childActions = actionDef.children
                        .filter((c: any) => c.type && c.type.toLowerCase().includes('action'))
                        .map((c: any) => ({
                            name: c.name,
                            type: 'action',
                            kind: 'action',
                            id: c.name
                        }));

                    const flows: any[] = [];
                    for (let i = 0; i < childActions.length - 1; i++) {
                        flows.push({ from: childActions[i].name, to: childActions[i + 1].name });
                    }

                    if (childActions.length > 0) {
                        flows.unshift({ from: 'start', to: childActions[0].name });
                        flows.push({ from: childActions[childActions.length - 1].name, to: 'done' });
                        childActions.unshift({ name: 'start', type: 'initial', kind: 'initial', id: 'start' });
                        childActions.push({ name: 'done', type: 'final', kind: 'final', id: 'done' });
                    }

                    return {
                        name: actionDef.name,
                        actions: childActions,
                        flows,
                        decisions: [],
                        states: []
                    };
                })
            };
        }

        case 'state': {
            const stateElements = allElements.filter((el: any) => el.type && (
                el.type.includes('state') || el.type.includes('State')
            ));
            return {
                ...data,
                states: stateElements,
                transitions: relationships.filter((rel: any) =>
                    rel.type && rel.type.includes('transition')
                )
            };
        }

        case 'sequence': {
            if (data.sequenceDiagrams && data.sequenceDiagrams.length > 0) {
                return { ...data, sequenceDiagrams: data.sequenceDiagrams };
            }

            function collectParticipants(el: any): any[] {
                const parts: any[] = [];
                function walk(children: any[]) {
                    for (const c of children) {
                        if (!c.type) continue;
                        const t = c.type.toLowerCase();
                        if (t === 'actor' || t === 'actor usage' || t === 'actor def') {
                            if (!parts.find((p: any) => p.name === c.name)) {
                                parts.push({ name: c.name, type: 'actor' });
                            }
                        } else if (t === 'part' || t === 'part usage' || t === 'part def' ||
                            t === 'item' || t === 'item usage' || t === 'item def') {
                            if (!parts.find((p: any) => p.name === c.name)) {
                                parts.push({ name: c.name, type: c.typing || 'component' });
                            }
                        } else if (t === 'port' || t === 'port usage') {
                            if (!parts.find((p: any) => p.name === c.name)) {
                                parts.push({ name: c.name, type: 'port' });
                            }
                        }
                        if (c.children && c.children.length > 0) walk(c.children);
                    }
                }
                walk(el.children || []);
                if (parts.length === 0) parts.push({ name: 'system', type: 'system' });
                return parts;
            }

            function buildMessages(el: any, participants: any[]): any[] {
                const msgs: any[] = [];
                let occ = 1;
                function walk(children: any[]) {
                    for (const c of children) {
                        if (!c.type) continue;
                        const t = c.type.toLowerCase();
                        if (t === 'action' || t === 'action usage' || t === 'action def') {
                            const cName = (c.name || '').toLowerCase();
                            let from = participants[0]?.name || 'system';
                            let to = participants.length > 1 ? participants[1].name : (participants[0]?.name || 'system');
                            for (const p of participants) {
                                const pLower = p.name.toLowerCase();
                                if (cName.includes(pLower) || pLower.includes(cName)) {
                                    to = p.name;
                                    break;
                                }
                            }
                            const actorP = participants.find((p: any) => p.type === 'actor');
                            if (actorP) from = actorP.name;
                            msgs.push({ name: c.name, from, to, payload: c.name, occurrence: occ++ });
                            if (c.children && c.children.length > 0) walk(c.children);
                        }
                    }
                }
                walk(el.children || []);
                return msgs;
            }

            const seqCandidates = allElements.filter((el: any) => {
                if (!el.type || !el.children || el.children.length === 0) return false;
                const nameLower = (el.name || '').toLowerCase();
                const typeLower = el.type.toLowerCase();
                const hasSequenceName = /sequence|interaction|workflow|scenario|process/.test(nameLower);
                const isInteraction = typeLower.includes('interaction');
                if (!hasSequenceName && !isInteraction) return false;
                const hasParts = el.children.some((c: any) => c.type && c.type.toLowerCase().includes('part'));
                return hasParts;
            });

            const actionSeqCandidates = allElements.filter((el: any) => {
                if (!el.type || !el.children || el.children.length === 0) return false;
                const typeLower = el.type.toLowerCase();
                const isAction = typeLower === 'action def' || typeLower === 'action definition' ||
                    typeLower === 'action' || typeLower === 'action usage';
                if (!isAction) return false;
                const hasChildActions = el.children.some((c: any) => {
                    if (!c.type) return false;
                    const ct = c.type.toLowerCase();
                    return ct === 'action' || ct === 'action usage' || ct === 'action def';
                });
                return hasChildActions;
            });

            const allCandidatesMap = new Map<string, any>();
            for (const c of seqCandidates) allCandidatesMap.set(c.name, c);
            for (const c of actionSeqCandidates) {
                if (!allCandidatesMap.has(c.name)) allCandidatesMap.set(c.name, c);
            }
            const allSeqCandidates = Array.from(allCandidatesMap.values());

            if (allSeqCandidates.length > 0) {
                const synthesisedDiagrams = allSeqCandidates.map((candidate: any) => {
                    const participants = collectParticipants(candidate);
                    const messages = buildMessages(candidate, participants);
                    return { name: candidate.name, participants, messages };
                });
                return { ...data, sequenceDiagrams: synthesisedDiagrams };
            }

            return { ...data, sequenceDiagrams: [] };
        }

        case 'usecase': {
            const allActors = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                return typeLower === 'actor def' || typeLower === 'actor definition';
            });

            const actorsByName = new Map<string, any>();
            allActors.forEach((actor: any) => {
                const lowerName = actor.name.toLowerCase();
                if (!actorsByName.has(lowerName)) actorsByName.set(lowerName, actor);
            });
            const actors = Array.from(actorsByName.values());

            const allUseCases = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                if (typeLower === 'include use case') return false;
                return typeLower.includes('use case') || typeLower.includes('usecase') || typeLower.includes('UseCase');
            });

            const useCasesByName = new Map<string, any>();
            allUseCases.forEach((uc: any) => {
                const lowerName = uc.name.toLowerCase();
                const existing = useCasesByName.get(lowerName);
                const isDefinition = uc.type.toLowerCase().includes('def');
                if (!existing) {
                    useCasesByName.set(lowerName, uc);
                } else {
                    const existingIsDefinition = existing.type.toLowerCase().includes('def');
                    if (isDefinition && !existingIsDefinition) {
                        useCasesByName.set(lowerName, uc);
                    }
                }
            });
            const useCases = Array.from(useCasesByName.values());

            const actorTypeToName = new Map<string, string>();
            actors.forEach((actor: any) => actorTypeToName.set(actor.name, actor.name));

            function getObjectiveText(useCase: any): string {
                if (!useCase.children) return '';
                for (const child of useCase.children) {
                    if (child.type === 'objective') {
                        if (child.children) {
                            for (const docChild of child.children) {
                                if (docChild.type === 'doc' && docChild.name && docChild.name !== 'unnamed') {
                                    return docChild.name;
                                }
                            }
                        }
                        if (child.name && child.name !== 'unnamed') return child.name;
                    }
                }
                return '';
            }

            const useCaseRelationships: any[] = [];
            useCases.forEach((useCase: any) => {
                const objectiveText = getObjectiveText(useCase);
                if (useCase.children) {
                    useCase.children.forEach((child: any) => {
                        const childType = child.type ? child.type.toLowerCase() : '';
                        const isActorUsage = childType === 'actor usage' || childType === 'actor';
                        if (isActorUsage) {
                            const actorType = child.typing || child.name;
                            useCaseRelationships.push({
                                source: actorType,
                                target: useCase.name,
                                type: 'association',
                                label: objectiveText
                            });
                        }
                        const isIncludeUseCase = childType === 'include use case';
                        if (isIncludeUseCase) {
                            const includedUC = child.typing || child.name;
                            useCaseRelationships.push({
                                source: useCase.name,
                                target: includedUC,
                                type: 'include',
                                label: ''
                            });
                        }
                    });
                }
            });

            if (useCaseRelationships.length === 0 && actors.length > 0 && useCases.length > 0) {
                const primaryActor = actors[0];
                useCases.forEach((useCase: any) => {
                    const objectiveText = getObjectiveText(useCase);
                    useCaseRelationships.push({
                        source: primaryActor.name,
                        target: useCase.name,
                        type: 'association',
                        label: objectiveText
                    });
                });
            }

            const useCaseNames = new Set(useCases.map((uc: any) => uc.name));
            const allActions = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                return typeLower === 'action' || typeLower.includes('action');
            });

            const relatedActions = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                if (typeLower !== 'action' && !typeLower.includes('action')) return false;
                const specialization = el.attributes?.get?.('specialization') ||
                    (el.attributes instanceof Map ? el.attributes.get('specialization') : el.attributes?.specialization);
                if (specialization) {
                    let specName = String(specialization).replace(/^:>\s*/, '').trim();
                    if ((specName.startsWith("'") && specName.endsWith("'")) ||
                        (specName.startsWith('"') && specName.endsWith('"'))) {
                        specName = specName.slice(1, -1);
                    }
                    return useCaseNames.has(specName);
                }
                return false;
            });

            function collectChildActions(actions: any[]): any[] {
                const childActions: any[] = [];
                const collectRecursive = (elements: any[], parentAction: string) => {
                    for (const el of elements) {
                        if (el.type) {
                            const typeLower = el.type.toLowerCase();
                            if (typeLower === 'action' || typeLower.includes('action')) {
                                (el as any).parentAction = parentAction;
                                childActions.push(el);
                                if (el.children && el.children.length > 0) {
                                    collectRecursive(el.children, el.name);
                                }
                            }
                        }
                    }
                };
                for (const action of actions) {
                    if (action.children && action.children.length > 0) {
                        collectRecursive(action.children, action.name);
                    }
                }
                return childActions;
            }

            const nestedActions = collectChildActions(relatedActions);

            relatedActions.forEach((action: any) => {
                const specialization = action.attributes?.get?.('specialization') ||
                    (action.attributes instanceof Map ? action.attributes.get('specialization') : action.attributes?.specialization);
                if (specialization) {
                    let specName = String(specialization).replace(/^:>\s*/, '').trim();
                    if ((specName.startsWith("'") && specName.endsWith("'")) ||
                        (specName.startsWith('"') && specName.endsWith('"'))) {
                        specName = specName.slice(1, -1);
                    }
                    useCaseRelationships.push({
                        source: specName,
                        target: action.name,
                        type: 'realize',
                        label: ''
                    });
                    const directChildren = nestedActions.filter((na: any) => na.parentAction === action.name);
                    directChildren.forEach((child: any) => {
                        useCaseRelationships.push({
                            source: action.name,
                            target: child.name,
                            type: 'include',
                            label: ''
                        });
                    });
                }
            });

            nestedActions.forEach((action: any) => {
                const children = nestedActions.filter((na: any) => na.parentAction === action.name);
                children.forEach((child: any) => {
                    useCaseRelationships.push({
                        source: action.name,
                        target: child.name,
                        type: 'include',
                        label: ''
                    });
                });
            });

            relatedActions.push(...nestedActions);

            const actorUsages = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                return typeLower === 'actor usage' || typeLower === 'actor';
            });

            const seenActorNames = new Set(actors.map((a: any) => a.name.toLowerCase()));
            actorUsages.forEach((usage: any) => {
                const actorType = usage.typing || usage.name;
                const actorTypeLower = actorType.toLowerCase();
                if (!seenActorNames.has(actorTypeLower)) {
                    actors.push({
                        name: actorType,
                        type: 'actor def',
                        children: [],
                        attributes: new Map(),
                        relationships: []
                    });
                    seenActorNames.add(actorTypeLower);
                    actorTypeToName.set(actorType, actorType);
                }
            });

            useCaseRelationships.forEach((rel: any) => {
                const relSourceLower = rel.source.toLowerCase();
                if (rel.type === 'association' && !seenActorNames.has(relSourceLower)) {
                    actors.push({
                        name: rel.source,
                        type: 'actor def',
                        children: [],
                        attributes: new Map(),
                        relationships: []
                    });
                    seenActorNames.add(relSourceLower);
                    actorTypeToName.set(rel.source, rel.source);
                }
            });

            const requirements = allElements.filter((el: any) => {
                if (!el.type) return false;
                const typeLower = el.type.toLowerCase();
                return typeLower.includes('requirement');
            });

            const requirementRelationships: any[] = [];
            requirements.forEach((req: any) => {
                if (!req.children) return;
                req.children.forEach((child: any) => {
                    const childType = (child.type || '').toLowerCase().trim();
                    if (childType === 'stakeholder') {
                        const stakeholderType = child.typing || child.name;
                        const stakeholderTypeLower = stakeholderType.toLowerCase();
                        requirementRelationships.push({
                            source: req.name,
                            target: stakeholderType,
                            type: 'stakeholder',
                            label: ''
                        });
                        if (!seenActorNames.has(stakeholderTypeLower)) {
                            actors.push({
                                name: stakeholderType,
                                type: 'actor def',
                                children: [],
                                attributes: new Map(),
                                relationships: [],
                                isStakeholder: true
                            });
                            seenActorNames.add(stakeholderTypeLower);
                            actorTypeToName.set(stakeholderType, stakeholderType);
                        }
                    }
                });
            });

            useCaseRelationships.push(...requirementRelationships);

            return {
                ...data,
                actors,
                useCases,
                actions: relatedActions,
                requirements,
                relationships: useCaseRelationships
            };
        }

        case 'package': {
            const packageNodes = allElements.filter((el: any) => el.type && (
                el.type.toLowerCase() === 'package' || el.type.toLowerCase().includes('package')
            ));

            const enrichedPackages = packageNodes.map((pkg: any) => {
                const childCount = pkg.children ? pkg.children.length : 0;
                const childPackages = (pkg.children || []).filter((c: any) =>
                    c.type && c.type.toLowerCase().includes('package')
                );
                return {
                    ...pkg,
                    id: pkg.id || pkg.name,
                    elementCount: childCount,
                    childPackageIds: childPackages.map((c: any) => c.id || c.name)
                };
            });

            return {
                ...data,
                nodes: enrichedPackages,
                dependencies: []
            };
        }

        default:
            return data;
    }
}
