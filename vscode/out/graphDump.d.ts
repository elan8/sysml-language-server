/**
 * Debug dump of graph data from sysml/model for General View verification.
 * Writes a JSON file and a human-readable summary to the workspace root.
 */
import type { SysMLGraphDTO } from "./providers/sysmlModelTypes";
export declare function dumpGraphForGeneralView(graph: SysMLGraphDTO | undefined, outPath: string): Promise<void>;
//# sourceMappingURL=graphDump.d.ts.map