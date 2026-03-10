/**
 * Shared constants for the visualizer webview.
 * View IDs match SysML v2 specification (Clause 8.2.3): frameless-view types.
 */
export declare const MIN_CANVAS_ZOOM = 0.04;
export declare const MAX_CANVAS_ZOOM = 5;
export declare const MIN_SYSML_ZOOM = 0.04;
export declare const MAX_SYSML_ZOOM = 5;
export declare const STRUCTURAL_VIEWS: Set<string>;
/** Views enabled for the current release. Disabled: action-flow-view, state-transition-view, sequence-view */
export declare const ENABLED_VIEWS: Set<string>;
export declare const ORIENTATION_LABELS: Record<string, string>;
export declare const STATE_LAYOUT_LABELS: Record<string, string>;
export declare const STATE_LAYOUT_ICONS: Record<string, string>;
export declare const VIEW_OPTIONS: Record<string, {
    label: string;
}>;
/**
 * General View palette - Option C semantic (align with SysML pillars).
 * Structural: greens/teals | Behavior: ambers | Requirements: soft blues.
 */
export declare const GENERAL_VIEW_PALETTE: {
    readonly structural: {
        readonly part: "#2D8A6E";
        readonly port: "#0E7C7B";
        readonly attribute: "#4A9B7F";
        readonly item: "#5A9B6E";
        readonly interface: "#7BAA7D";
    };
    readonly behavior: {
        readonly action: "#D4A02C";
        readonly state: "#B85C38";
        readonly calc: "#C9A227";
    };
    readonly requirements: {
        readonly requirement: "#5B8FC4";
        readonly useCase: "#6B9BD1";
    };
    readonly other: {
        readonly allocation: "#9CA3AF";
        readonly constraint: "#E07C5A";
        readonly default: "var(--vscode-panel-border)";
    };
};
export declare const GENERAL_VIEW_TYPE_COLORS: Record<string, string>;
//# sourceMappingURL=constants.d.ts.map