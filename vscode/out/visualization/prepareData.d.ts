/**
 * prepareDataForView - Transforms generic model data into view-specific structures.
 * Helper functions (collectAllElements, removeCircularRefs, extractNestedParts, etc.)
 * are used internally. For browser/webview context.
 */
/**
 * Build a tree of elements from graph (nodes + edges).
 * Used when data has graph instead of elements for views that need tree structure.
 */
export declare function graphToElementTree(graph: any): any[];
export declare function prepareDataForView(data: any, view: string): any;
//# sourceMappingURL=prepareData.d.ts.map