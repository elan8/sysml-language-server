export interface PositionDTO {
    line: number;
    character: number;
}
export interface RangeDTO {
    start: PositionDTO;
    end: PositionDTO;
}
export interface RelationshipDTO {
    type: string;
    source: string;
    target: string;
    name?: string;
}
export interface SysMLElementDTO {
    type: string;
    name: string;
    range: RangeDTO;
    children: SysMLElementDTO[];
    attributes: Record<string, unknown>;
    relationships: RelationshipDTO[];
    errors?: string[];
}
export interface SysMLModelStatsDTO {
    totalElements: number;
    resolvedElements: number;
    unresolvedElements: number;
    parseTimeMs: number;
    modelBuildTimeMs: number;
    parseCached: boolean;
}
export interface SysMLModelParams {
    textDocument: {
        uri: string;
    };
    scope?: Array<"elements" | "relationships" | "stats">;
}
export interface SysMLModelResult {
    version: number;
    elements?: SysMLElementDTO[];
    relationships?: RelationshipDTO[];
    stats?: SysMLModelStatsDTO;
}
//# sourceMappingURL=sysmlModelTypes.d.ts.map