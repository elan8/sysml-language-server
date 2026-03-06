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
  textDocument: { uri: string };
  scope?: Array<"elements" | "relationships" | "stats" | "sequenceDiagrams" | "activityDiagrams">;
}

export interface SysMLModelResult {
  version: number;
  elements?: SysMLElementDTO[];
  relationships?: RelationshipDTO[];
  sequenceDiagrams?: SequenceDiagramDTO[];
  activityDiagrams?: ActivityDiagramDTO[];
  stats?: SysMLModelStatsDTO;
}

// ---------------------------------------------------------------------------
// Sequence Diagrams (optional - our server returns empty if not implemented)
// ---------------------------------------------------------------------------

export interface SequenceDiagramDTO {
  name: string;
  participants: ParticipantDTO[];
  messages: MessageDTO[];
  range: RangeDTO;
}

export interface ParticipantDTO {
  name: string;
  type: string;
  range: RangeDTO;
}

export interface MessageDTO {
  name: string;
  from: string;
  to: string;
  payload: string;
  occurrence: number;
  range: RangeDTO;
}

// ---------------------------------------------------------------------------
// Activity Diagrams (optional - our server returns empty if not implemented)
// ---------------------------------------------------------------------------

export interface ActivityDiagramDTO {
  name: string;
  actions: ActivityActionDTO[];
  decisions: DecisionNodeDTO[];
  flows: ControlFlowDTO[];
  states: ActivityStateDTO[];
  range: RangeDTO;
}

export interface ActivityActionDTO {
  name: string;
  type: string;
  kind?: string;
  inputs?: string[];
  outputs?: string[];
  condition?: string;
  subActions?: ActivityActionDTO[];
  isDefinition?: boolean;
  range?: RangeDTO;
  parent?: string;
  children?: string[];
}

export interface DecisionNodeDTO {
  name: string;
  condition: string;
  branches: { condition: string; target: string }[];
  range: RangeDTO;
}

export interface ControlFlowDTO {
  from: string;
  to: string;
  condition?: string;
  guard?: string;
  range: RangeDTO;
}

export interface ActivityStateDTO {
  name: string;
  type: "initial" | "final" | "intermediate";
  entryActions?: string[];
  exitActions?: string[];
  doActivity?: string;
  range: RangeDTO;
}

