//! DTOs and conversion helpers for sysml/model and related responses.

use serde::Serialize;
use tower_lsp::lsp_types::Range;

use crate::ibd;
use crate::model;
use crate::semantic_model;

#[derive(Debug, Serialize)]
pub struct PositionDto {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Serialize)]
pub struct RangeDto {
    pub start: PositionDto,
    pub end: PositionDto,
}

#[derive(Debug, Serialize)]
pub struct RelationshipDto {
    #[serde(rename = "type")]
    pub rel_type: String,
    pub source: String,
    pub target: String,
    pub name: Option<String>,
}

/// Graph node for frontend (qualified name as id).
#[derive(Debug, Serialize)]
pub struct GraphNodeDto {
    pub id: String,
    #[serde(rename = "type")]
    pub element_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "parentId")]
    pub parent_id: Option<String>,
    pub range: RangeDto,
    pub attributes: std::collections::HashMap<String, serde_json::Value>,
}

/// Graph edge (source/target are node ids).
#[derive(Debug, Serialize)]
pub struct GraphEdgeDto {
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub rel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SysmlGraphDto {
    pub nodes: Vec<GraphNodeDto>,
    pub edges: Vec<GraphEdgeDto>,
}

#[derive(Debug, Serialize)]
pub struct SysmlElementDto {
    #[serde(rename = "type")]
    pub element_type: String,
    pub name: String,
    pub range: RangeDto,
    pub children: Vec<SysmlElementDto>,
    pub attributes: std::collections::HashMap<String, serde_json::Value>,
    pub relationships: Vec<RelationshipDto>,
    pub errors: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct SysmlModelStatsDto {
    #[serde(rename = "totalElements")]
    pub total_elements: u32,
    #[serde(rename = "resolvedElements")]
    pub resolved_elements: u32,
    #[serde(rename = "unresolvedElements")]
    pub unresolved_elements: u32,
    #[serde(rename = "parseTimeMs")]
    pub parse_time_ms: u32,
    #[serde(rename = "modelBuildTimeMs")]
    pub model_build_time_ms: u32,
    #[serde(rename = "parseCached")]
    pub parse_cached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysmlModelResultDto {
    pub version: u32,
    pub graph: Option<SysmlGraphDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_diagrams: Option<Vec<model::ActivityDiagramDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence_diagrams: Option<Vec<model::SequenceDiagramDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ibd: Option<ibd::IbdDataDto>,
    pub stats: Option<SysmlModelStatsDto>,
}

#[derive(Debug, Serialize)]
pub struct SysmlServerStatsDto {
    pub uptime: u64,
    pub memory: SysmlServerMemoryDto,
    pub caches: SysmlServerCachesDto,
}

#[derive(Debug, Serialize)]
pub struct SysmlServerMemoryDto {
    /// Resident set size in MB (best-effort). Currently 0 when not available.
    pub rss: u64,
}

#[derive(Debug, Serialize)]
pub struct SysmlServerCachesDto {
    pub documents: usize,
    #[serde(rename = "symbolTables")]
    pub symbol_tables: usize,
    #[serde(rename = "semanticTokens")]
    pub semantic_tokens: usize,
}

#[derive(Debug, Serialize)]
pub struct SysmlClearCacheResultDto {
    pub documents: usize,
    #[serde(rename = "symbolTables")]
    pub symbol_tables: usize,
    #[serde(rename = "semanticTokens")]
    pub semantic_tokens: usize,
}

pub fn range_to_dto(r: Range) -> RangeDto {
    RangeDto {
        start: PositionDto {
            line: r.start.line,
            character: r.start.character,
        },
        end: PositionDto {
            line: r.end.line,
            character: r.end.character,
        },
    }
}

