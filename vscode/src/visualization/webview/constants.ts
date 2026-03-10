/**
 * Shared constants for the visualizer webview.
 * View IDs match SysML v2 specification (Clause 8.2.3): frameless-view types.
 */

export const MIN_CANVAS_ZOOM = 0.04;
export const MAX_CANVAS_ZOOM = 5;
export const MIN_SYSML_ZOOM = 0.04;
export const MAX_SYSML_ZOOM = 5;

export const STRUCTURAL_VIEWS = new Set(['general-view']);

/** Views enabled for the current release. Disabled: action-flow-view, state-transition-view, sequence-view */
export const ENABLED_VIEWS = new Set(['general-view', 'interconnection-view']);

export const ORIENTATION_LABELS: Record<string, string> = {
    horizontal: 'Horizontal',
    linear: 'Linear (Top-Down)',
};

export const STATE_LAYOUT_LABELS: Record<string, string> = {
    horizontal: 'Left → Right',
    vertical: 'Top → Down',
    force: 'Auto-arrange',
};

export const STATE_LAYOUT_ICONS: Record<string, string> = {
    horizontal: '→',
    vertical: '↓',
    force: '⚡',
};

export const VIEW_OPTIONS: Record<string, { label: string }> = {
    'general-view': { label: 'General View' },
    'interconnection-view': { label: 'Interconnection View' },
    // Disabled for next release: action-flow-view, state-transition-view, sequence-view
};

/**
 * General View palette - Option C semantic (align with SysML pillars).
 * Structural: greens/teals | Behavior: ambers | Requirements: soft blues.
 */
export const GENERAL_VIEW_PALETTE = {
    structural: {
        part: '#2D8A6E',
        port: '#0E7C7B',
        attribute: '#4A9B7F',
        item: '#5A9B6E',
        interface: '#7BAA7D',
    },
    behavior: {
        action: '#D4A02C',
        state: '#B85C38',
        calc: '#C9A227',
    },
    requirements: {
        requirement: '#5B8FC4',
        useCase: '#6B9BD1',
    },
    other: {
        allocation: '#9CA3AF',
        constraint: '#E07C5A',
        default: 'var(--vscode-panel-border)',
    },
} as const;

export const GENERAL_VIEW_TYPE_COLORS: Record<string, string> = {
    'part def': GENERAL_VIEW_PALETTE.structural.part,
    part: GENERAL_VIEW_PALETTE.structural.part,
    'port def': GENERAL_VIEW_PALETTE.structural.port,
    port: GENERAL_VIEW_PALETTE.structural.port,
    'attribute def': GENERAL_VIEW_PALETTE.structural.attribute,
    attribute: GENERAL_VIEW_PALETTE.structural.attribute,
    'action def': GENERAL_VIEW_PALETTE.behavior.action,
    action: GENERAL_VIEW_PALETTE.behavior.action,
    'state def': GENERAL_VIEW_PALETTE.behavior.state,
    state: GENERAL_VIEW_PALETTE.behavior.state,
    'interface def': GENERAL_VIEW_PALETTE.structural.interface,
    interface: GENERAL_VIEW_PALETTE.structural.interface,
    'requirement def': GENERAL_VIEW_PALETTE.requirements.requirement,
    requirement: GENERAL_VIEW_PALETTE.requirements.requirement,
    'use case def': GENERAL_VIEW_PALETTE.requirements.useCase,
    'use case': GENERAL_VIEW_PALETTE.requirements.useCase,
    verification: GENERAL_VIEW_PALETTE.behavior.calc,
    analysis: GENERAL_VIEW_PALETTE.behavior.action,
    allocation: GENERAL_VIEW_PALETTE.other.allocation,
    'allocation def': GENERAL_VIEW_PALETTE.other.allocation,
    'item def': GENERAL_VIEW_PALETTE.structural.item,
    item: GENERAL_VIEW_PALETTE.structural.item,
    'calc def': GENERAL_VIEW_PALETTE.behavior.calc,
    calc: GENERAL_VIEW_PALETTE.behavior.calc,
    'constraint def': GENERAL_VIEW_PALETTE.other.constraint,
    constraint: GENERAL_VIEW_PALETTE.other.constraint,
    'enumeration def': GENERAL_VIEW_PALETTE.behavior.calc,
    enumeration: GENERAL_VIEW_PALETTE.behavior.calc,
    'metadata def': '#8B7355',
    metadata: '#8B7355',
    'occurrence def': GENERAL_VIEW_PALETTE.structural.item,
    occurrence: GENERAL_VIEW_PALETTE.structural.item,
    package: '#6B7280',
    default: GENERAL_VIEW_PALETTE.other.default,
};
