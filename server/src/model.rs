//! Activity and sequence diagram extraction for sysml/model response.

use kerml_parser::ast::{ActionDef, SourceRange, Statement, SysMLDocument};
use serde::Serialize;

/// Position DTO for JSON (matches vscode sysmlModelTypes)
#[derive(Debug, Clone, Serialize)]
pub struct PositionDto {
    pub line: u32,
    pub character: u32,
}

/// Range DTO for JSON
#[derive(Debug, Clone, Serialize)]
pub struct RangeDto {
    pub start: PositionDto,
    pub end: PositionDto,
}

fn source_range_to_dto(r: &SourceRange) -> RangeDto {
    RangeDto {
        start: PositionDto {
            line: r.start_line,
            character: r.start_character,
        },
        end: PositionDto {
            line: r.end_line,
            character: r.end_character,
        },
    }
}

fn default_range_dto() -> RangeDto {
    RangeDto {
        start: PositionDto { line: 0, character: 0 },
        end: PositionDto { line: 0, character: 0 },
    }
}

// ---------------------------------------------------------------------------
// Activity diagrams
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDiagramDto {
    pub name: String,
    pub actions: Vec<ActivityActionDto>,
    pub decisions: Vec<DecisionNodeDto>,
    pub flows: Vec<ControlFlowDto>,
    pub states: Vec<ActivityStateDto>,
    pub range: RangeDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityActionDto {
    pub name: String,
    #[serde(rename = "type")]
    pub action_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<RangeDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionNodeDto {
    pub name: String,
    pub condition: String,
    pub branches: Vec<BranchDto>,
    pub range: RangeDto,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchDto {
    pub condition: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlFlowDto {
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guard: Option<String>,
    pub range: RangeDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStateDto {
    pub name: String,
    #[serde(rename = "type")]
    pub state_type: String,
    pub range: RangeDto,
}

// ---------------------------------------------------------------------------
// Sequence diagrams
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDiagramDto {
    pub name: String,
    pub participants: Vec<ParticipantDto>,
    pub messages: Vec<MessageDto>,
    pub range: RangeDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantDto {
    pub name: String,
    #[serde(rename = "type")]
    pub participant_type: String,
    pub range: RangeDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub name: String,
    pub from: String,
    pub to: String,
    pub payload: String,
    pub occurrence: u32,
    pub range: RangeDto,
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

fn collect_action_defs(members: &[kerml_parser::ast::Member]) -> Vec<&ActionDef> {
    use kerml_parser::ast::Member as M;
    let mut out = Vec::new();
    for m in members {
        match m {
            M::ActionDef(a) => out.push(a),
            M::Package(p) => out.extend(collect_action_defs(&p.members)),
            M::PartDef(p) => out.extend(collect_action_defs(&p.members)),
            M::PartUsage(p) => out.extend(collect_action_defs(&p.members)),
            M::AttributeDef(a) => out.extend(collect_action_defs(&a.members)),
            M::AttributeUsage(a) => out.extend(collect_action_defs(&a.members)),
            M::InterfaceDef(i) => out.extend(collect_action_defs(&i.members)),
            M::ItemDef(i) => out.extend(collect_action_defs(&i.members)),
            M::RequirementDef(r) => out.extend(collect_action_defs(&r.members)),
            M::RequirementUsage(r) => out.extend(collect_action_defs(&r.members)),
            M::StateDef(s) => out.extend(collect_action_defs(&s.members)),
            M::ExhibitState(s) => out.extend(collect_action_defs(&s.members)),
            M::UseCase(u) => out.extend(collect_action_defs(&u.members)),
            M::ActorDef(a) => out.extend(collect_action_defs(&a.members)),
            _ => {}
        }
    }
    out
}

/// Extracts activity diagrams from ActionDef nodes.
/// Each ActionDef becomes one ActivityDiagramDto; body statements (Call, Assignment)
/// become actions; consecutive actions are connected by implicit flows.
pub fn extract_activity_diagrams(doc: &SysMLDocument) -> Vec<ActivityDiagramDto> {
    let mut out = Vec::new();
    for pkg in &doc.packages {
        for action in collect_action_defs(&pkg.members) {
            out.push(extract_activity_from_action(action));
        }
    }
    out
}

fn extract_activity_from_action(action: &ActionDef) -> ActivityDiagramDto {
    let mut actions = Vec::new();
    let mut flows = Vec::new();
    let mut prev_name: Option<String> = None;

    for (i, stmt) in action.body.iter().enumerate() {
        let (name, range_opt) = match stmt {
            Statement::Call(c) => (c.name.clone(), None),
            Statement::Assignment(a) => {
                if let kerml_parser::ast::Expression::FunctionCall(call) = &a.expression {
                    (call.name.clone(), None)
                } else {
                    (a.target.clone(), None)
                }
            }
            Statement::PerformAction(p) => (p.action_ref.clone(), None),
        };
        let action_name = if name.is_empty() {
            format!("action_{}", i)
        } else {
            name.clone()
        };

        let range_dto = range_opt.map(source_range_to_dto);
        actions.push(ActivityActionDto {
            name: action_name.clone(),
            action_type: "action".to_string(),
            kind: None,
            range: range_dto,
        });

        if let Some(ref prev) = prev_name {
            flows.push(ControlFlowDto {
                from: prev.clone(),
                to: action_name.clone(),
                condition: None,
                guard: None,
                range: default_range_dto(),
            });
        }
        prev_name = Some(action_name);
    }

    // Add initial and final states for non-empty diagrams
    let mut states = Vec::new();
    if !actions.is_empty() {
        states.push(ActivityStateDto {
            name: "initial".to_string(),
            state_type: "initial".to_string(),
            range: default_range_dto(),
        });
        states.push(ActivityStateDto {
            name: "final".to_string(),
            state_type: "final".to_string(),
            range: default_range_dto(),
        });
    }

    let range = action
        .range
        .as_ref()
        .map(source_range_to_dto)
        .unwrap_or_else(default_range_dto);

    ActivityDiagramDto {
        name: action.name.clone(),
        actions,
        decisions: vec![],
        flows,
        states,
        range,
    }
}

/// Extracts sequence diagrams from the document.
/// Currently creates one diagram per ActionDef with messages from Call statements.
/// Participants are derived from unique names in calls (minimal heuristics).
pub fn extract_sequence_diagrams(doc: &SysMLDocument) -> Vec<SequenceDiagramDto> {
    let mut out = Vec::new();
    for pkg in &doc.packages {
        for action in collect_action_defs(&pkg.members) {
            out.push(extract_sequence_from_action(action));
        }
    }
    out
}

fn extract_sequence_from_action(action: &ActionDef) -> SequenceDiagramDto {
    let mut participants = std::collections::HashSet::new();
    let mut messages = Vec::new();

    for (occ, stmt) in action.body.iter().enumerate() {
        if let Statement::PerformAction(p) = stmt {
            participants.insert("self".to_string());
            messages.push(MessageDto {
                name: p.action_ref.clone(),
                from: "self".to_string(),
                to: "self".to_string(),
                payload: String::new(),
                occurrence: occ as u32,
                range: default_range_dto(),
            });
            continue;
        }
        if let Statement::Call(c) = stmt {
            // Heuristic: "receiver::message" or "obj.method" => participant = receiver/obj
            let (from, to, msg_name) = if let Some(sep) = c.name.find("::") {
                let (left, right) = c.name.split_at(sep);
                (
                    left.trim().to_string(),
                    left.trim().to_string(),
                    right.trim_start_matches(':').trim_start().to_string(),
                )
            } else if let Some(dot) = c.name.find('.') {
                let (left, right) = c.name.split_at(dot);
                (left.trim().to_string(), left.trim().to_string(), right.trim_start_matches('.').trim_start().to_string())
            } else {
                ("self".to_string(), "self".to_string(), c.name.clone())
            };

            let msg_name = if msg_name.is_empty() { c.name.clone() } else { msg_name };
            participants.insert(from.clone());
            participants.insert(to.clone());

            messages.push(MessageDto {
                name: msg_name,
                from: from.clone(),
                to: to.clone(),
                payload: c.arguments.iter().map(expr_to_str).collect::<Vec<_>>().join(", "),
                occurrence: occ as u32,
                range: default_range_dto(),
            });
        }
    }

    let participants_vec: Vec<ParticipantDto> = participants
        .into_iter()
        .map(|name| ParticipantDto {
            name: name.clone(),
            participant_type: "participant".to_string(),
            range: default_range_dto(),
        })
        .collect();

    let range = action
        .range
        .as_ref()
        .map(source_range_to_dto)
        .unwrap_or_else(default_range_dto);

    SequenceDiagramDto {
        name: action.name.clone(),
        participants: participants_vec,
        messages,
        range,
    }
}

fn expr_to_str(e: &kerml_parser::ast::Expression) -> String {
    use kerml_parser::ast::Expression;
    match e {
        Expression::Variable(s) => s.clone(),
        Expression::Literal(kerml_parser::ast::Literal::String(s)) => s.clone(),
        Expression::Literal(kerml_parser::ast::Literal::Integer(n)) => n.to_string(),
        Expression::Literal(kerml_parser::ast::Literal::Float(x)) => x.to_string(),
        Expression::Literal(kerml_parser::ast::Literal::Boolean(b)) => b.to_string(),
        Expression::FunctionCall(c) => c.name.clone(),
        Expression::QualifiedName(parts) => parts.join("::"),
        Expression::ValueWithUnit { value, unit } => format!("{} [{}]", expr_to_str(value), unit),
        Expression::Index { target, index } => format!("{}#({})", target, expr_to_str(index)),
    }
}
