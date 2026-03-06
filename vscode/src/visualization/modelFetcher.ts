import * as vscode from 'vscode';
import type { LspModelProvider } from '../providers/lspModelProvider';
import type { SysMLElementDTO } from '../providers/sysmlModelTypes';

export interface FetchModelParams {
    documentUri: string;
    fileUris: vscode.Uri[];
    lspModelProvider: LspModelProvider;
    currentView: string;
    pendingPackageName?: string;
}

export interface UpdateMessage {
    command: 'update';
    elements: unknown[];
    relationships: unknown[];
    sequenceDiagrams: unknown[];
    activityDiagrams: unknown[];
    currentView: string;
    pendingPackageName?: string;
}

/**
 * Hash content for change detection. Used to skip re-parsing when document
 * content has not changed.
 */
export function hashContent(content: string): string {
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
export function convertDTOElementsToJSON(elements: SysMLElementDTO[], parentName?: string): unknown[] {
    const filtered = parentName
        ? elements.filter(el => !(el.type === 'package' && el.name === parentName))
        : elements;

    return filtered.map(el => {
        const attrs = el.attributes ?? {};
        const rels = el.relationships ?? [];

        const attrType =
            (attrs['partType'] as string | undefined) ??
            (attrs['portType'] as string | undefined) ??
            (attrs['actorType'] as string | undefined);
        const typingTargets: string[] = attrType
            ? attrType.split(',').map(s => s.trim()).filter(Boolean)
            : rels.filter(r => r.type === 'typing').map(r => r.target);
        const typing: string | undefined = typingTargets[0] ?? undefined;

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
export function mergeElementDTOs(elements: SysMLElementDTO[]): SysMLElementDTO[] {
    const mergedMap = new Map<string, SysMLElementDTO>();
    const result: SysMLElementDTO[] = [];

    for (const el of elements) {
        const key = `${el.type}::${el.name}`;
        if (el.type === 'package' && mergedMap.has(key)) {
            const existing = mergedMap.get(key) ?? el;
            const childKeys = new Set(
                (existing.children ?? []).map(c => `${c.type}::${c.name}`),
            );
            for (const child of el.children ?? []) {
                const ck = `${child.type}::${child.name}`;
                if (!childKeys.has(ck)) {
                    existing.children = existing.children ?? [];
                    existing.children.push(child);
                    childKeys.add(ck);
                }
            }
            const relKeys = new Set(
                (existing.relationships ?? []).map(r => `${r.type}::${r.source}::${r.target}`),
            );
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
        } else if (el.type === 'package') {
            const clone: SysMLElementDTO = {
                ...el,
                children: [...(el.children ?? [])],
                relationships: [...(el.relationships ?? [])],
                attributes: { ...(el.attributes ?? {}) },
            };
            mergedMap.set(key, clone);
            result.push(clone);
        } else {
            result.push(el);
        }
    }

    return result;
}

/**
 * Fetch model data from the LSP provider and convert it to the webview update message format.
 */
export async function fetchModelData(params: FetchModelParams): Promise<UpdateMessage | null> {
    const {
        documentUri,
        fileUris,
        lspModelProvider,
        currentView,
        pendingPackageName,
    } = params;

    const urisToQuery = fileUris.length > 0
        ? fileUris.map(u => u.toString())
        : [documentUri];

    const scopes: ('elements' | 'relationships' | 'sequenceDiagrams' | 'activityDiagrams')[] =
        ['elements', 'relationships', 'sequenceDiagrams', 'activityDiagrams'];

    const results = await Promise.all(
        urisToQuery.map(uri => lspModelProvider.getModel(uri, scopes)),
    );

    const allElements: SysMLElementDTO[] = [];
    const allRelationships: unknown[] = [];
    const allSequenceDiagrams: unknown[] = [];
    const allActivityDiagrams: unknown[] = [];

    for (const result of results) {
        if (result.elements) allElements.push(...result.elements);
        if (result.relationships) allRelationships.push(...(result.relationships as unknown[]));
        if (result.sequenceDiagrams) allSequenceDiagrams.push(...(result.sequenceDiagrams as unknown[]));
        if (result.activityDiagrams) allActivityDiagrams.push(...(result.activityDiagrams as unknown[]));
    }

    const mergedElements = mergeElementDTOs(allElements);
    const jsonElements = convertDTOElementsToJSON(mergedElements);

    const msg: UpdateMessage = {
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
