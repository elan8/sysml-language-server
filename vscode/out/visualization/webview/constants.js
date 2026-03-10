"use strict";
/**
 * Shared constants for the visualizer webview.
 * View IDs match SysML v2 specification (Clause 8.2.3): frameless-view types.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENERAL_VIEW_TYPE_COLORS = exports.GENERAL_VIEW_PALETTE = exports.VIEW_OPTIONS = exports.STATE_LAYOUT_ICONS = exports.STATE_LAYOUT_LABELS = exports.ORIENTATION_LABELS = exports.ENABLED_VIEWS = exports.STRUCTURAL_VIEWS = exports.MAX_SYSML_ZOOM = exports.MIN_SYSML_ZOOM = exports.MAX_CANVAS_ZOOM = exports.MIN_CANVAS_ZOOM = void 0;
exports.MIN_CANVAS_ZOOM = 0.04;
exports.MAX_CANVAS_ZOOM = 5;
exports.MIN_SYSML_ZOOM = 0.04;
exports.MAX_SYSML_ZOOM = 5;
exports.STRUCTURAL_VIEWS = new Set(['general-view']);
/** Views enabled for the current release. Disabled: interconnection-view (routing quality), action-flow-view, state-transition-view, sequence-view */
exports.ENABLED_VIEWS = new Set(['general-view']);
exports.ORIENTATION_LABELS = {
    horizontal: 'Horizontal',
    linear: 'Linear (Top-Down)',
};
exports.STATE_LAYOUT_LABELS = {
    horizontal: 'Left → Right',
    vertical: 'Top → Down',
    force: 'Auto-arrange',
};
exports.STATE_LAYOUT_ICONS = {
    horizontal: '→',
    vertical: '↓',
    force: '⚡',
};
exports.VIEW_OPTIONS = {
    'general-view': { label: 'General View' },
    'interconnection-view': { label: 'Interconnection View' },
    // Disabled for next release: action-flow-view, state-transition-view, sequence-view
};
/**
 * General View palette - Option C semantic (align with SysML pillars).
 * Structural: greens/teals | Behavior: ambers | Requirements: soft blues.
 */
exports.GENERAL_VIEW_PALETTE = {
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
};
exports.GENERAL_VIEW_TYPE_COLORS = {
    'part def': exports.GENERAL_VIEW_PALETTE.structural.part,
    part: exports.GENERAL_VIEW_PALETTE.structural.part,
    'port def': exports.GENERAL_VIEW_PALETTE.structural.port,
    port: exports.GENERAL_VIEW_PALETTE.structural.port,
    'attribute def': exports.GENERAL_VIEW_PALETTE.structural.attribute,
    attribute: exports.GENERAL_VIEW_PALETTE.structural.attribute,
    'action def': exports.GENERAL_VIEW_PALETTE.behavior.action,
    action: exports.GENERAL_VIEW_PALETTE.behavior.action,
    'state def': exports.GENERAL_VIEW_PALETTE.behavior.state,
    state: exports.GENERAL_VIEW_PALETTE.behavior.state,
    'interface def': exports.GENERAL_VIEW_PALETTE.structural.interface,
    interface: exports.GENERAL_VIEW_PALETTE.structural.interface,
    'requirement def': exports.GENERAL_VIEW_PALETTE.requirements.requirement,
    requirement: exports.GENERAL_VIEW_PALETTE.requirements.requirement,
    'use case def': exports.GENERAL_VIEW_PALETTE.requirements.useCase,
    'use case': exports.GENERAL_VIEW_PALETTE.requirements.useCase,
    verification: exports.GENERAL_VIEW_PALETTE.behavior.calc,
    analysis: exports.GENERAL_VIEW_PALETTE.behavior.action,
    allocation: exports.GENERAL_VIEW_PALETTE.other.allocation,
    'allocation def': exports.GENERAL_VIEW_PALETTE.other.allocation,
    'item def': exports.GENERAL_VIEW_PALETTE.structural.item,
    item: exports.GENERAL_VIEW_PALETTE.structural.item,
    'calc def': exports.GENERAL_VIEW_PALETTE.behavior.calc,
    calc: exports.GENERAL_VIEW_PALETTE.behavior.calc,
    'constraint def': exports.GENERAL_VIEW_PALETTE.other.constraint,
    constraint: exports.GENERAL_VIEW_PALETTE.other.constraint,
    'enumeration def': exports.GENERAL_VIEW_PALETTE.behavior.calc,
    enumeration: exports.GENERAL_VIEW_PALETTE.behavior.calc,
    'metadata def': '#8B7355',
    metadata: '#8B7355',
    'occurrence def': exports.GENERAL_VIEW_PALETTE.structural.item,
    occurrence: exports.GENERAL_VIEW_PALETTE.structural.item,
    package: '#6B7280',
    default: exports.GENERAL_VIEW_PALETTE.other.default,
};
//# sourceMappingURL=constants.js.map