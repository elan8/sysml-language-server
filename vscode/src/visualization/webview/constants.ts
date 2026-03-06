/**
 * Shared constants for the visualizer webview.
 * View IDs match SysML v2 specification (Clause 8.2.3): frameless-view types.
 */

export const MIN_CANVAS_ZOOM = 0.04;
export const MAX_CANVAS_ZOOM = 5;
export const MIN_SYSML_ZOOM = 0.04;
export const MAX_SYSML_ZOOM = 5;

export const STRUCTURAL_VIEWS = new Set(['general-view']);

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
    'action-flow-view': { label: 'Action Flow View' },
    'state-transition-view': { label: 'State Transition View' },
    'sequence-view': { label: 'Sequence View' },
};
