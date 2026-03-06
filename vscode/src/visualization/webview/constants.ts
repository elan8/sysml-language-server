/**
 * Shared constants for the visualizer webview.
 */

export const MIN_CANVAS_ZOOM = 0.04;
export const MAX_CANVAS_ZOOM = 5;
export const MIN_SYSML_ZOOM = 0.04;
export const MAX_SYSML_ZOOM = 5;

export const STRUCTURAL_VIEWS = new Set(['elk', 'hierarchy']);

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

export const USECASE_LAYOUT_LABELS = STATE_LAYOUT_LABELS;
export const USECASE_LAYOUT_ICONS = STATE_LAYOUT_ICONS;

export const VIEW_OPTIONS: Record<string, { label: string }> = {
    tree: { label: '▲ Tree View' },
    elk: { label: '◆ General View' },
    graph: { label: '● Graph View' },
    hierarchy: { label: '■ Hierarchy View' },
    sequence: { label: '⇄ Sequence View' },
    ibd: { label: '▦ Interconnection View' },
    activity: { label: '▶ Action Flow View' },
    state: { label: '⌘ State Transition View' },
    usecase: { label: '◎ Case View' },
    package: { label: '▤ Package View' },
};
