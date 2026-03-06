"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashContent = hashContent;
exports.convertDTOElementsToJSON = convertDTOElementsToJSON;
exports.mergeElementDTOs = mergeElementDTOs;
exports.fetchModelData = fetchModelData;
/**
 * Hash content for change detection. Used to skip re-parsing when document
 * content has not changed.
 */
function hashContent(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
}
/**
 * Convert LSP DTO elements into the JSON shape the webview expects.
 */
function convertDTOElementsToJSON(elements, parentName) {
    const filtered = parentName
        ? elements.filter(el => !(el.type === 'package' && el.name === parentName))
        : elements;
    return filtered.map(el => {
        const attrs = el.attributes ?? {};
        const rels = el.relationships ?? [];
        const attrType = attrs['partType'] ??
            attrs['portType'];
        const typingTargets = attrType
            ? attrType.split(',').map(s => s.trim()).filter(Boolean)
            : rels.filter(r => r.type === 'typing').map(r => r.target);
        const typing = typingTargets[0] ?? undefined;
        return {
            name: el.name,
            type: el.type,
            id: el.name,
            attributes: attrs,
            properties: {},
            typing,
            typings: typingTargets,
            children: convertDTOElementsToJSON(el.children ?? [], el.name),
            relationships: rels.map(r => ({
                type: r.type,
                source: r.source,
                target: r.target,
            })),
        };
    });
}
/**
 * Merge same-named package DTOs so that packages declared across
 * multiple files appear as a single node with combined children.
 */
function mergeElementDTOs(elements) {
    const mergedMap = new Map();
    const result = [];
    for (const el of elements) {
        const key = `${el.type}::${el.name}`;
        if (el.type === 'package' && mergedMap.has(key)) {
            const existing = mergedMap.get(key) ?? el;
            const childKeys = new Set((existing.children ?? []).map(c => `${c.type}::${c.name}`));
            for (const child of el.children ?? []) {
                const ck = `${child.type}::${child.name}`;
                if (!childKeys.has(ck)) {
                    existing.children = existing.children ?? [];
                    existing.children.push(child);
                    childKeys.add(ck);
                }
            }
            const relKeys = new Set((existing.relationships ?? []).map(r => `${r.type}::${r.source}::${r.target}`));
            for (const rel of el.relationships ?? []) {
                const rk = `${rel.type}::${rel.source}::${rel.target}`;
                if (!relKeys.has(rk)) {
                    existing.relationships = existing.relationships ?? [];
                    existing.relationships.push(rel);
                    relKeys.add(rk);
                }
            }
            if (el.attributes) {
                existing.attributes = existing.attributes ?? {};
                for (const [k, v] of Object.entries(el.attributes)) {
                    if (!(k in existing.attributes)) {
                        existing.attributes[k] = v;
                    }
                }
            }
        }
        else if (el.type === 'package') {
            const clone = {
                ...el,
                children: [...(el.children ?? [])],
                relationships: [...(el.relationships ?? [])],
                attributes: { ...(el.attributes ?? {}) },
            };
            mergedMap.set(key, clone);
            result.push(clone);
        }
        else {
            result.push(el);
        }
    }
    return result;
}
/**
 * Fetch model data from the LSP provider and convert it to the webview update message format.
 */
async function fetchModelData(params) {
    const { documentUri, fileUris, lspModelProvider, currentView, pendingPackageName, } = params;
    const urisToQuery = fileUris.length > 0
        ? fileUris.map(u => u.toString())
        : [documentUri];
    const scopes = ['elements', 'relationships', 'sequenceDiagrams', 'activityDiagrams'];
    const results = await Promise.all(urisToQuery.map(uri => lspModelProvider.getModel(uri, scopes)));
    const allElements = [];
    const allRelationships = [];
    const allSequenceDiagrams = [];
    const allActivityDiagrams = [];
    for (const result of results) {
        if (result.elements)
            allElements.push(...result.elements);
        if (result.relationships)
            allRelationships.push(...result.relationships);
        if (result.sequenceDiagrams)
            allSequenceDiagrams.push(...result.sequenceDiagrams);
        if (result.activityDiagrams)
            allActivityDiagrams.push(...result.activityDiagrams);
    }
    const mergedElements = mergeElementDTOs(allElements);
    const jsonElements = convertDTOElementsToJSON(mergedElements);
    const msg = {
        command: 'update',
        elements: jsonElements,
        relationships: allRelationships,
        sequenceDiagrams: allSequenceDiagrams,
        activityDiagrams: allActivityDiagrams,
        currentView,
    };
    if (pendingPackageName) {
        msg.pendingPackageName = pendingPackageName;
    }
    return msg;
}
//# sourceMappingURL=modelFetcher.js.map