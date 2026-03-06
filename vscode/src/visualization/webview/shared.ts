/**
 * Shared helpers for the visualizer webview.
 * Runs in browser context - document, window, d3 are globals.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function cloneElements(elements: any): any[] {
    if (!elements) {
        return [];
    }
    try {
        return JSON.parse(JSON.stringify(elements));
    } catch (error) {
        if (typeof console !== 'undefined' && console.warn) {
            console.warn('Failed to clone elements, falling back to reference copy', error);
        }
        return elements;
    }
}

export function normalizeAttributes(attributes: any): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    if (!attributes) {
        return properties;
    }
    if (typeof attributes.forEach === 'function') {
        attributes.forEach((value: unknown, key: string) => {
            if (!DANGEROUS_KEYS.has(key)) {
                properties[key] = value;
            }
        });
    } else {
        for (const key of Object.keys(attributes)) {
            if (!DANGEROUS_KEYS.has(key)) {
                properties[key] = attributes[key];
            }
        }
    }
    return properties;
}

export function getElementProperties(element: any): Record<string, unknown> {
    if (element?.properties) {
        return element.properties;
    }
    return normalizeAttributes(element?.attributes);
}

export function formatStereotype(type: string | null | undefined): string {
    if (!type) {
        return '';
    }
    return '<<' + String(type).trim() + '>>';
}

export function normalizeTypeForDisplay(type: string | null | undefined): string {
    if (!type) {
        return '';
    }
    const normalized = String(type).trim().toLowerCase();
    if (!normalized) {
        return '';
    }
    const suffixReplacements = [' def', ' definition'];
    for (const suffix of suffixReplacements) {
        if (normalized.endsWith(suffix)) {
            const stripped = normalized.slice(0, -suffix.length).trim();
            if (stripped.length > 0) {
                return stripped;
            }
        }
    }
    return normalized;
}

export function buildElementDisplayLabel(element: any): string {
    if (!element) {
        return '';
    }
    const normalizedType = normalizeTypeForDisplay(element.type);
    const stereotype = normalizedType ? formatStereotype(normalizedType) : '';
    const displayName = element.name || 'Unnamed';
    return stereotype ? stereotype + ' ' + displayName : displayName;
}

export function isLibraryValidated(element: any): boolean {
    if (!element?.attributes) {
        return false;
    }
    const attrs = element.attributes;
    if (typeof attrs.get === 'function') {
        return attrs.get('isStandardType') === true || attrs.get('isStandardElement') === true;
    }
    return attrs.isStandardType === true || attrs.isStandardElement === true;
}

export function getNodeColor(element: any): string {
    if (isLibraryValidated(element)) {
        return 'var(--vscode-charts-green)';
    }
    return 'var(--vscode-charts-blue)';
}

export function getNodeBorderStyle(element: any): string {
    if (isLibraryValidated(element)) {
        return '2px';
    }
    return '1px';
}

const typeColors: Record<string, string> = {
    'part def': '#4EC9B0',
    'part': '#4EC9B0',
    'port def': '#C586C0',
    'port': '#C586C0',
    'attribute def': '#9CDCFE',
    'attribute': '#9CDCFE',
    'action def': '#DCDCAA',
    'action': '#DCDCAA',
    'state def': '#CE9178',
    'state': '#CE9178',
    'interface def': '#D7BA7D',
    'interface': '#D7BA7D',
    'requirement def': '#B5CEA8',
    'requirement': '#B5CEA8',
    'use case def': '#569CD6',
    'use case': '#569CD6',
    'verification': '#C586C0',
    'analysis': '#DCDCAA',
    'allocation': '#D4D4D4',
    'item def': '#6A9955',
    'item': '#6A9955',
    'calc def': '#DCDCAA',
    'calc': '#DCDCAA',
    'constraint def': '#F14C4C',
    'constraint': '#F14C4C',
    'default': 'var(--vscode-panel-border)'
};

export function getTypeColor(type: string | null | undefined): string {
    const t = (type || '').toLowerCase();
    if (typeColors[t]) return typeColors[t];
    for (const key in typeColors) {
        if (key !== 'default' && t.includes(key)) return typeColors[key];
    }
    return typeColors['default'];
}

export function isActorElement(elementOrType: any): boolean {
    const typeValue = typeof elementOrType === 'string'
        ? elementOrType
        : (elementOrType?.type);
    if (!typeValue) {
        return false;
    }
    return String(typeValue).toLowerCase().includes('actor');
}

/**
 * Render D3 actor stick figure glyph. Requires d3 as global.
 */
export function renderActorGlyph(
    container: any,
    clickHandler?: (event: any) => void,
    dblClickHandler?: (event: any) => void
): any {
    const actorGroup = container.append('g')
        .attr('class', 'actor-icon')
        .attr('transform', 'translate(0,-4)');

    actorGroup.append('circle')
        .attr('cx', 0)
        .attr('cy', -6)
        .attr('r', 6)
        .style('fill', 'none')
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', 2);

    actorGroup.append('line')
        .attr('x1', 0)
        .attr('y1', 0)
        .attr('x2', 0)
        .attr('y2', 18)
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', 2);

    actorGroup.append('line')
        .attr('x1', -10)
        .attr('y1', 4)
        .attr('x2', 10)
        .attr('y2', 4)
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', 2);

    actorGroup.append('line')
        .attr('x1', 0)
        .attr('y1', 18)
        .attr('x2', -10)
        .attr('y2', 32)
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', 2);

    actorGroup.append('line')
        .attr('x1', 0)
        .attr('y1', 18)
        .attr('x2', 10)
        .attr('y2', 32)
        .style('stroke', 'var(--vscode-charts-blue)')
        .style('stroke-width', 2);

    if (clickHandler) {
        actorGroup.on('click', clickHandler);
    }
    if (dblClickHandler) {
        actorGroup.on('dblclick', dblClickHandler);
    }

    return actorGroup;
}

export function quickHash(obj: any): string {
    const str = JSON.stringify(obj);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
}
