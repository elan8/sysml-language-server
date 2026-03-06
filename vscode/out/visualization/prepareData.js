"use strict";
/**
 * prepareDataForView - Transforms generic model data into view-specific structures.
 * Helper functions (collectAllElements, removeCircularRefs, extractNestedParts, etc.)
 * are used internally. For browser/webview context.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareDataForView = prepareDataForView;
/* eslint-disable @typescript-eslint/no-explicit-any */
function prepareDataForView(data, view) {
    if (!data) {
        return data;
    }
    const elements = data.elements || [];
    const relationships = data.relationships || [];
    function collectAllElements(elementList, collected = [], parentElement = null) {
        elementList.forEach((el) => {
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
    function removeCircularRefs(obj) {
        if (!obj || typeof obj !== 'object')
            return obj;
        if (obj.parentElement) {
            delete obj.parentElement;
        }
        if (obj.children && Array.isArray(obj.children)) {
            obj.children.forEach((child) => removeCircularRefs(child));
        }
        return obj;
    }
    const allElements = collectAllElements(elements);
    switch (view) {
        case 'general-view':
            return data;
        case 'interconnection-view': {
            const ibdParts = [];
            const seenParts = new Set();
            const extractNestedParts = (element, parentPath = '') => {
                if (!element || !element.children)
                    return;
                element.children.forEach((child) => {
                    if (!child || !child.type)
                        return;
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
            allElements.forEach((el) => {
                if (!el.type)
                    return;
                const typeLower = el.type.toLowerCase();
                if ((typeLower === 'part' || typeLower === 'part usage' ||
                    (typeLower.includes('part') && !typeLower.includes('def'))) &&
                    !seenParts.has(el.name)) {
                    ibdParts.push({ ...el, qualifiedName: el.name });
                    seenParts.add(el.name);
                    extractNestedParts(el, el.name);
                }
            });
            const partDefs = allElements.filter((el) => {
                if (!el.type)
                    return false;
                const typeLower = el.type.toLowerCase();
                return typeLower === 'part def' || typeLower === 'part definition';
            });
            partDefs.forEach((partDef) => extractNestedParts(partDef, ''));
            const ibdPorts = [];
            const processPortsFromPart = (part, partId) => {
                if (part.children) {
                    part.children.forEach((child) => {
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
            ibdParts.forEach((part) => {
                const partId = part.id || part.name;
                processPortsFromPart(part, partId);
            });
            allElements.forEach((el) => {
                if (el.type && el.type.toLowerCase().includes('port')) {
                    const existingPort = ibdPorts.find((p) => p.name === el.name);
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
            const ibdConnectors = [];
            const explicitConnectors = relationships.filter((rel) => rel.type && (rel.type.includes('connection') || rel.type.includes('flow') ||
                rel.type.includes('binding') || rel.type.includes('interface') ||
                rel.type.includes('allocation') || rel.type.includes('dependency')));
            explicitConnectors.forEach((rel) => {
                ibdConnectors.push({ ...rel, sourceId: rel.source, targetId: rel.target });
            });
            ibdParts.forEach((part) => {
                const types = (part.typings && part.typings.length > 0)
                    ? part.typings : (part.typing ? [part.typing] : []);
                types.forEach((typeName) => {
                    if (typeName && typeName !== part.name) {
                        const typedElement = allElements.find((el) => el.name === typeName || el.id === typeName);
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
                .filter((rel) => rel.type && (rel.type.includes('attribute') || rel.type.includes('property') ||
                rel.type.includes('reference')))
                .forEach((rel) => {
                const sourceInParts = ibdParts.some((p) => p.name === rel.source || p.id === rel.source);
                const targetInParts = ibdParts.some((p) => p.name === rel.target || p.id === rel.target);
                if (sourceInParts && targetInParts) {
                    ibdConnectors.push({ ...rel, sourceId: rel.source, targetId: rel.target });
                }
            });
            let focusPart = null;
            let focusedParts = ibdParts;
            const partsWithChildren = allElements.filter((el) => {
                if (!el.type || !el.children || el.children.length === 0)
                    return false;
                const typeLower = el.type.toLowerCase();
                const isPartDef = typeLower.includes('part def');
                const isPartUsage = (typeLower === 'part' || typeLower === 'part usage' ||
                    (typeLower.includes('part') && !typeLower.includes('def')));
                if (!isPartDef && !isPartUsage)
                    return false;
                return el.children.some((c) => c.type && c.type.toLowerCase().includes('part'));
            });
            if (partsWithChildren.length > 0) {
                partsWithChildren.sort((a, b) => {
                    const aPartCount = a.children.filter((c) => c.type && c.type.toLowerCase().includes('part')).length;
                    const bPartCount = b.children.filter((c) => c.type && c.type.toLowerCase().includes('part')).length;
                    return bPartCount - aPartCount;
                });
                focusedParts = [];
                const processedPartNames = new Set();
                for (const currentFocusPart of partsWithChildren) {
                    if (processedPartNames.has(currentFocusPart.name))
                        continue;
                    processedPartNames.add(currentFocusPart.name);
                    focusPart = currentFocusPart;
                    const partChildren = currentFocusPart.children.filter((c) => c.type && c.type.toLowerCase().includes('part'));
                    focusedParts.push({
                        name: currentFocusPart.name,
                        type: currentFocusPart.type,
                        id: currentFocusPart.id || currentFocusPart.name,
                        attributes: currentFocusPart.attributes || {},
                        children: currentFocusPart.children || []
                    });
                    for (const child of partChildren) {
                        if (processedPartNames.has(child.name))
                            continue;
                        processedPartNames.add(child.name);
                        let enrichedChild = ibdParts.find((p) => p.name === child.name);
                        if (!enrichedChild) {
                            enrichedChild = { ...child, qualifiedName: child.name };
                        }
                        try {
                            if (enrichedChild && enrichedChild.name) {
                                const partDef = allElements.find((el) => el && el.type && el.name &&
                                    el.type.toLowerCase().includes('part def') &&
                                    el.name === (enrichedChild.typing || child.typing));
                                if (partDef && partDef.children) {
                                    enrichedChild = { ...enrichedChild, children: partDef.children };
                                }
                            }
                        }
                        catch {
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
                        currentFocusPart.children.forEach((child) => {
                            if (!child || !child.type)
                                return;
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
        case 'action-flow-view': {
            if (data.activityDiagrams && data.activityDiagrams.length > 0) {
                return {
                    ...data,
                    diagrams: data.activityDiagrams.map((diagram) => {
                        const decisionsAsActions = (diagram.decisions || []).map((d) => ({
                            ...d,
                            id: d.id || d.name,
                            type: 'decision',
                            kind: 'decision'
                        }));
                        const allActions = [
                            ...(diagram.actions || []).map((a) => ({
                                ...a,
                                id: a.id || a.name,
                                parent: (a.parent === diagram.name) ? undefined : a.parent
                            })),
                            ...decisionsAsActions
                        ];
                        const actionIds = new Set(allActions.map((a) => a.id || a.name));
                        const flows = diagram.flows || [];
                        const flowNodeNames = new Set();
                        const incomingFlowCount = new Map();
                        const outgoingFlowCount = new Map();
                        flows.forEach((f) => {
                            if (f.from) {
                                flowNodeNames.add(f.from);
                                outgoingFlowCount.set(f.from, (outgoingFlowCount.get(f.from) || 0) + 1);
                            }
                            if (f.to) {
                                flowNodeNames.add(f.to);
                                incomingFlowCount.set(f.to, (incomingFlowCount.get(f.to) || 0) + 1);
                            }
                        });
                        flowNodeNames.forEach((nodeName) => {
                            if (!actionIds.has(nodeName)) {
                                const incoming = incomingFlowCount.get(nodeName) || 0;
                                const outgoing = outgoingFlowCount.get(nodeName) || 0;
                                const nameLower = nodeName.toLowerCase();
                                let nodeType = 'action';
                                let nodeKind = 'action';
                                if (nameLower.includes('merge') || nameLower.includes('join') || nameLower.endsWith('check')) {
                                    nodeType = 'merge';
                                    nodeKind = 'merge';
                                }
                                else if (nameLower.includes('fork')) {
                                    nodeType = 'fork';
                                    nodeKind = 'fork';
                                }
                                else if (nameLower.includes('decision') || nameLower.includes('decide')) {
                                    nodeType = 'decision';
                                    nodeKind = 'decision';
                                }
                                else if (incoming > 1) {
                                    nodeType = 'merge';
                                    nodeKind = 'merge';
                                }
                                else if (outgoing > 1) {
                                    const hasGuards = flows.some((f) => f.from === nodeName && (f.guard || f.condition));
                                    if (hasGuards) {
                                        nodeType = 'decision';
                                        nodeKind = 'decision';
                                    }
                                    else {
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
                        const cleanFlows = flows.filter((f) => f.from !== f.to &&
                            actionIds.has(f.from) &&
                            actionIds.has(f.to));
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
            const actionDefs = allElements.filter((el) => {
                if (!el.type)
                    return false;
                const typeLower = el.type.toLowerCase();
                return typeLower === 'action' || typeLower === 'action def' || typeLower === 'action definition';
            });
            const activityActionDefs = actionDefs.filter((a) => a.children && a.children.length > 0);
            return {
                ...data,
                diagrams: activityActionDefs.map((actionDef) => {
                    const childActions = actionDef.children
                        .filter((c) => c.type && c.type.toLowerCase().includes('action'))
                        .map((c) => ({
                        name: c.name,
                        type: 'action',
                        kind: 'action',
                        id: c.name
                    }));
                    const flows = [];
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
        case 'state-transition-view': {
            const stateElements = allElements.filter((el) => el.type && (el.type.includes('state') || el.type.includes('State')));
            return {
                ...data,
                states: stateElements,
                transitions: relationships.filter((rel) => rel.type && rel.type.includes('transition'))
            };
        }
        case 'sequence-view': {
            if (data.sequenceDiagrams && data.sequenceDiagrams.length > 0) {
                return { ...data, sequenceDiagrams: data.sequenceDiagrams };
            }
            function collectParticipants(el) {
                const parts = [];
                function walk(children) {
                    for (const c of children) {
                        if (!c.type)
                            continue;
                        const t = c.type.toLowerCase();
                        if (t === 'actor' || t === 'actor usage' || t === 'actor def') {
                            if (!parts.find((p) => p.name === c.name)) {
                                parts.push({ name: c.name, type: 'actor' });
                            }
                        }
                        else if (t === 'part' || t === 'part usage' || t === 'part def' ||
                            t === 'item' || t === 'item usage' || t === 'item def') {
                            if (!parts.find((p) => p.name === c.name)) {
                                parts.push({ name: c.name, type: c.typing || 'component' });
                            }
                        }
                        else if (t === 'port' || t === 'port usage') {
                            if (!parts.find((p) => p.name === c.name)) {
                                parts.push({ name: c.name, type: 'port' });
                            }
                        }
                        if (c.children && c.children.length > 0)
                            walk(c.children);
                    }
                }
                walk(el.children || []);
                if (parts.length === 0)
                    parts.push({ name: 'system', type: 'system' });
                return parts;
            }
            function buildMessages(el, participants) {
                const msgs = [];
                let occ = 1;
                function walk(children) {
                    for (const c of children) {
                        if (!c.type)
                            continue;
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
                            const actorP = participants.find((p) => p.type === 'actor');
                            if (actorP)
                                from = actorP.name;
                            msgs.push({ name: c.name, from, to, payload: c.name, occurrence: occ++ });
                            if (c.children && c.children.length > 0)
                                walk(c.children);
                        }
                    }
                }
                walk(el.children || []);
                return msgs;
            }
            const seqCandidates = allElements.filter((el) => {
                if (!el.type || !el.children || el.children.length === 0)
                    return false;
                const nameLower = (el.name || '').toLowerCase();
                const typeLower = el.type.toLowerCase();
                const hasSequenceName = /sequence|interaction|workflow|scenario|process/.test(nameLower);
                const isInteraction = typeLower.includes('interaction');
                if (!hasSequenceName && !isInteraction)
                    return false;
                const hasParts = el.children.some((c) => c.type && c.type.toLowerCase().includes('part'));
                return hasParts;
            });
            const actionSeqCandidates = allElements.filter((el) => {
                if (!el.type || !el.children || el.children.length === 0)
                    return false;
                const typeLower = el.type.toLowerCase();
                const isAction = typeLower === 'action def' || typeLower === 'action definition' ||
                    typeLower === 'action' || typeLower === 'action usage';
                if (!isAction)
                    return false;
                const hasChildActions = el.children.some((c) => {
                    if (!c.type)
                        return false;
                    const ct = c.type.toLowerCase();
                    return ct === 'action' || ct === 'action usage' || ct === 'action def';
                });
                return hasChildActions;
            });
            const allCandidatesMap = new Map();
            for (const c of seqCandidates)
                allCandidatesMap.set(c.name, c);
            for (const c of actionSeqCandidates) {
                if (!allCandidatesMap.has(c.name))
                    allCandidatesMap.set(c.name, c);
            }
            const allSeqCandidates = Array.from(allCandidatesMap.values());
            if (allSeqCandidates.length > 0) {
                const synthesisedDiagrams = allSeqCandidates.map((candidate) => {
                    const participants = collectParticipants(candidate);
                    const messages = buildMessages(candidate, participants);
                    return { name: candidate.name, participants, messages };
                });
                return { ...data, sequenceDiagrams: synthesisedDiagrams };
            }
            return { ...data, sequenceDiagrams: [] };
        }
        default:
            return data;
    }
}
//# sourceMappingURL=prepareData.js.map