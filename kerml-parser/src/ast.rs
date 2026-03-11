//! Abstract Syntax Tree (AST) for SysML v2
//!
//! This module defines the Rust structs that represent the parsed
//! SysML v2 semantic model.

use serde::{Deserialize, Serialize};

/// Source position information (line and character)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourcePosition {
    /// Line number (0-based)
    pub line: u32,
    /// Character position within the line (0-based)
    pub character: u32,
    /// Length of the token in characters
    pub length: u32,
}

impl SourcePosition {
    /// Converts this position to a single-line source range.
    pub fn to_range(&self) -> SourceRange {
        SourceRange {
            start_line: self.line,
            start_character: self.character,
            end_line: self.line,
            end_character: self.character + self.length,
        }
    }
}

/// Full source range (start and end position)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceRange {
    /// Start line (0-based)
    pub start_line: u32,
    /// Start character (0-based)
    pub start_character: u32,
    /// End line (0-based)
    pub end_line: u32,
    /// End character (0-based)
    pub end_character: u32,
}

/// Keyword that must never get a TYPE semantic range (parser sometimes misattributes it).
fn is_type_skip_keyword(s: &str) -> bool {
    s.trim() == "def"
}

/// For a qualified type ref (e.g. "ISQ::mass"), returns (namespace range, type range) so the first
/// segment is namespace and the last segment is type. Positions use the same byte-offset convention as the parser.
fn type_ref_segment_ranges(
    type_ref: &str,
    pos: &SourcePosition,
) -> (Option<SourceRange>, Option<SourceRange>) {
    if let Some(sep) = type_ref.find("::") {
        let first_len = sep as u32;
        let last_start = type_ref.rfind("::").map(|i| (i + 2) as u32).unwrap_or(0);
        let last_len = (type_ref.len() - (last_start as usize)) as u32;
        let namespace_range = SourceRange {
            start_line: pos.line,
            start_character: pos.character,
            end_line: pos.line,
            end_character: pos.character + first_len,
        };
        let type_range = SourceRange {
            start_line: pos.line,
            start_character: pos.character + last_start,
            end_line: pos.line,
            end_character: pos.character + last_start + last_len,
        };
        (Some(namespace_range), Some(type_range))
    } else {
        (None, Some(pos.to_range()))
    }
}

/// Root document node representing a complete SysML v2 file
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SysMLDocument {
    /// Top-level imports
    pub imports: Vec<Import>,
    /// Top-level package declarations
    pub packages: Vec<Package>,
}

/// Visibility modifier
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Visibility {
    Public,
    Private,
}

/// Import statement
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Import {
    /// Visibility (optional)
    pub visibility: Option<Visibility>,
    /// Imported namespace or element
    pub path: String,
    /// Whether this is a wildcard import (import X::*)
    pub wildcard: bool,
    /// Source position of the first segment of the path (the package/namespace being imported).
    /// Used for semantic highlighting so "SI" in "import SI::N" is classified as namespace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_first_segment_position: Option<SourcePosition>,
}

/// A package declaration
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Package {
    /// Package name (can include quotes for names with spaces)
    pub name: String,
    /// Source position of the package name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the package (from start to closing brace)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Whether this is a library package
    pub is_library: bool,
    /// Imports within this package
    pub imports: Vec<Import>,
    /// Package members (parts, actions, etc.)
    pub members: Vec<Member>,
}

/// Multiplicity specification
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Multiplicity {
    /// Fixed count [n]
    Fixed(u32),
    /// Unbounded [*]
    Unbounded,
    /// Range [n..m]
    Range(u32, u32),
}

/// A doc comment
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocComment {
    /// The comment text (without the "doc" keyword and comment markers)
    pub text: String,
}

/// A metadata annotation (e.g., @Layer(name = "02_SystemContext"))
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetadataAnnotation {
    /// The metadata name (e.g., "Layer")
    pub name: String,
    /// The metadata attributes (e.g., {"name": "02_SystemContext"})
    pub attributes: std::collections::HashMap<String, String>,
}

/// A bind statement (e.g., "bind logical.port = physical.port { param = value }")
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindStatement {
    /// Logical port expression (e.g., "part1.can" or "'generate torque'.fuelCmd")
    pub logical: String,
    /// Physical port expression (e.g., "CAN0" or "part2.vin")
    pub physical: String,
    /// Optional parameters in the body (e.g., can_id_tx = 0x120)
    pub params: Vec<(String, String)>,
}

/// An allocate statement (e.g., "allocate torqueGenerator to powerTrain")
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AllocateStatement {
    /// Source (logical / requiring execution) - part name or "name ::> name"
    pub source: String,
    /// Target (physical / providing execution) - part name or "name ::> name"
    pub target: String,
}

/// A provides statement (e.g., "provides Execution = MCU;") inside a part usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProvidesStatement {
    /// Capability name (e.g., "Execution")
    pub capability: String,
    /// Optional execution kind (e.g., "MCU") when capability is execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_kind: Option<String>,
}

/// A requires statement (e.g., "requires Execution = MCU;") inside a part usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequiresStatement {
    /// Capability name (e.g., "Execution")
    pub capability: String,
    /// Optional execution kind (e.g., "MCU") when capability is execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_kind: Option<String>,
}

/// An in-statement (e.g., "in driveTorque :> ISQ::torque;") inside a port def or similar body
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InStatement {
    /// Item name (e.g., "driveTorque")
    pub name: String,
    /// Source position of the name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the in-statement
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Source position of the specialization (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specializes_position: Option<SourcePosition>,
    /// Type reference (after :)
    pub type_ref: Option<String>,
    /// Source position of the type reference (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
}

/// An end statement (e.g., "end axleMount: AxleMountIF;") inside an interface def body
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EndStatement {
    /// End name (e.g., "axleMount")
    pub name: String,
    /// Source position of the name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the end statement
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type reference (after ":")
    pub type_ref: Option<String>,
    /// Source position of the type reference (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
}

/// A member within a package or other container
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Member {
    /// Part definition
    PartDef(PartDef),
    /// Part usage
    PartUsage(PartUsage),
    /// Port definition
    PortDef(PortDef),
    /// Port usage
    PortUsage(PortUsage),
    /// Interface definition
    InterfaceDef(InterfaceDef),
    /// Connection usage
    ConnectionUsage(ConnectionUsage),
    /// Item definition
    ItemDef(ItemDef),
    /// Item usage
    ItemUsage(ItemUsage),
    /// Requirement definition
    RequirementDef(RequirementDef),
    /// Requirement usage
    RequirementUsage(RequirementUsage),
    /// Attribute definition
    AttributeDef(AttributeDef),
    /// Attribute usage
    AttributeUsage(AttributeUsage),
    /// Action definition
    ActionDef(ActionDef),
    /// Nested package
    Package(Package),
    /// Doc comment
    DocComment(DocComment),
    /// Bind statement (logical port to physical port)
    BindStatement(BindStatement),
    /// Allocate statement (deploy requiring to providing execution)
    AllocateStatement(AllocateStatement),
    /// Provides statement (part provides a capability)
    ProvidesStatement(ProvidesStatement),
    /// Requires statement (part requires a capability)
    RequiresStatement(RequiresStatement),
    /// In-statement (e.g., in/out item in port body)
    InStatement(InStatement),
    /// End statement (e.g., end item in interface def body)
    EndStatement(EndStatement),
    /// State definition
    StateDef(StateDef),
    /// Exhibit state (state usage in state machine)
    ExhibitState(ExhibitState),
    /// Transition statement (inside state machine; source/target for state diagram)
    TransitionStatement(TransitionStatement),
    /// Use case
    UseCase(UseCase),
    /// Actor definition/statement
    ActorDef(ActorDef),
}

/// Transition statement (e.g., "transition name first StateA then StateB { }")
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionStatement {
    /// Transition name (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Source state (from "first X"; if absent, the containing state)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Target state (from "then X")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
}

/// State definition (state def name or state name : Type { ... })
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    pub members: Vec<Member>,
}

/// Exhibit state (exhibit state name { ... })
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExhibitState {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    pub members: Vec<Member>,
}

/// Use case (use case name { ... })
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UseCase {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    pub members: Vec<Member>,
}

/// Actor (actor name : Type or actor :>> name)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActorDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref: Option<String>,
    pub members: Vec<Member>,
}

/// A part definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartDef {
    /// Part name
    pub name: String,
    /// Source position of the part name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the part def
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Whether this is abstract
    pub is_abstract: bool,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Source position of the specialization (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specializes_position: Option<SourcePosition>,
    /// Type reference (after :)
    pub type_ref: Option<String>,
    /// Source position of the type reference (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
    /// Multiplicity
    pub multiplicity: Option<Multiplicity>,
    /// Whether ordered
    pub ordered: bool,
    /// Metadata annotations (e.g., @Layer(name = "02_SystemContext"))
    pub metadata: Vec<MetadataAnnotation>,
    /// Members (nested features)
    pub members: Vec<Member>,
}

/// A part usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartUsage {
    /// Part name (optional for anonymous parts)
    pub name: Option<String>,
    /// Source position of the part name (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the part usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Source position of the specialization (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specializes_position: Option<SourcePosition>,
    /// Type reference (after :)
    pub type_ref: Option<String>,
    /// Source position of the type reference (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
    /// Multiplicity
    pub multiplicity: Option<Multiplicity>,
    /// Whether ordered
    pub ordered: bool,
    /// Redefines clause
    pub redefines: Option<String>,
    /// Subsets clause
    pub subsets: Option<String>,
    /// Default value expression
    pub value: Option<Expression>,
    /// Metadata annotations (e.g., @Layer(name = "02_SystemContext"))
    pub metadata: Vec<MetadataAnnotation>,
    /// Members (nested features)
    pub members: Vec<Member>,
}

/// An attribute definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttributeDef {
    /// Attribute name
    pub name: String,
    /// Visibility
    pub visibility: Option<Visibility>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Source position of the specialization (if present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specializes_position: Option<SourcePosition>,
    /// Type reference (after :)
    pub type_ref: Option<String>,
    /// Multiplicity
    pub multiplicity: Option<Multiplicity>,
    /// Redefines clause
    pub redefines: Option<String>,
    /// Default value
    pub default_value: Option<Expression>,
    /// Members
    pub members: Vec<Member>,
    /// Source position of the attribute name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Source position of the type reference (if present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
    /// Source position of the default value (if present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value_position: Option<SourcePosition>,
    /// Full source range of the attribute def
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
}

/// An attribute usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttributeUsage {
    /// Attribute name
    pub name: String,
    /// Source position of the attribute name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Visibility
    pub visibility: Option<Visibility>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Type reference (after :)
    pub type_ref: Option<String>,
    /// Multiplicity
    pub multiplicity: Option<Multiplicity>,
    /// Redefines clause
    pub redefines: Option<String>,
    /// Subsets clause
    pub subsets: Option<String>,
    /// Value expression
    pub value: Option<Expression>,
    /// Members
    pub members: Vec<Member>,
    /// Full source range of the attribute usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
}

/// Port definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortDef {
    /// Port name
    pub name: String,
    /// Source position of the port name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the port def
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Source position of the specialization (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specializes_position: Option<SourcePosition>,
    /// Type reference (after :)
    pub type_ref: Option<String>,
    /// Source position of the type reference (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
    /// Metadata annotations (e.g., @Tag(value = "x"))
    #[serde(default)]
    pub metadata: Vec<MetadataAnnotation>,
    /// Members
    pub members: Vec<Member>,
}

/// Port usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortUsage {
    /// Port name (optional)
    pub name: Option<String>,
    /// Source position of the port name (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the port usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type reference
    pub type_ref: Option<String>,
    /// Source position of the type reference (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
    /// Metadata annotations (e.g., @Tag(value = "x"))
    #[serde(default)]
    pub metadata: Vec<MetadataAnnotation>,
    /// Members
    pub members: Vec<Member>,
}

/// Interface definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterfaceDef {
    /// Interface name
    pub name: String,
    /// Source position of the interface name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the interface def
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Metadata annotations (e.g., @Tag(value = "x"))
    #[serde(default)]
    pub metadata: Vec<MetadataAnnotation>,
    /// Members
    pub members: Vec<Member>,
}

/// Connection usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionUsage {
    /// Connection name (optional)
    pub name: Option<String>,
    /// Source position of the connection name (when present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the connection usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Source port
    pub source: String,
    /// Target port
    pub target: String,
}

/// Item definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemDef {
    /// Item name
    pub name: String,
    /// Source position of the item name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the item def
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Metadata annotations (e.g. @DacKind("Message") for DAC round-trip)
    #[serde(default)]
    pub metadata: Vec<MetadataAnnotation>,
    /// Members
    pub members: Vec<Member>,
}

/// Item flow direction
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ItemDirection {
    In,
    Out,
    /// Bidirectional (inout)
    Inout,
}

/// Item usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemUsage {
    /// Direction (in/out)
    pub direction: ItemDirection,
    /// Item name
    pub name: String,
    /// Source position of the item name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the item usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type reference
    pub type_ref: Option<String>,
    /// Source position of the type reference (for semantic highlighting)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_ref_position: Option<SourcePosition>,
    /// Multiplicity
    pub multiplicity: Option<Multiplicity>,
}

/// Requirement definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequirementDef {
    /// Requirement name
    pub name: String,
    /// Source position of the requirement name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the requirement def
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type specialization (after :>)
    pub specializes: Option<String>,
    /// Members
    pub members: Vec<Member>,
}

/// Requirement usage
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequirementUsage {
    /// Requirement name
    pub name: String,
    /// Source position of the requirement name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the requirement usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Type reference
    pub type_ref: Option<String>,
    /// Redefines clause
    pub redefines: Option<String>,
    /// Members
    pub members: Vec<Member>,
}

/// An action definition
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionDef {
    /// Action name
    pub name: String,
    /// Source position of the action name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_position: Option<SourcePosition>,
    /// Full source range of the action def
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    /// Action body (statements)
    pub body: Vec<Statement>,
}

/// A statement within an action
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Statement {
    /// Assignment statement
    Assignment(Assignment),
    /// Call statement (including perform action ref)
    Call(Call),
    /// Perform action (explicit "perform action X" or "perform X")
    PerformAction(PerformAction),
}

/// Perform action statement (e.g., "perform action doSomething" or "perform doSomething")
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PerformAction {
    /// Action reference (the invoked action name)
    pub action_ref: String,
}

/// An assignment statement
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Assignment {
    /// Left-hand side (target)
    pub target: String,
    /// Right-hand side (expression)
    pub expression: Expression,
}

/// A call statement
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    /// Function/action name
    pub name: String,
    /// Arguments
    pub arguments: Vec<Expression>,
}

/// An expression
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Expression {
    /// Literal value
    Literal(Literal),
    /// Variable reference
    Variable(String),
    /// Function call
    FunctionCall(Call),
    /// Value with unit (e.g., 1750 [kg])
    ValueWithUnit { value: Box<Expression>, unit: String },
    /// Qualified name (e.g., ISQ::mass)
    QualifiedName(Vec<String>),
    /// Index expression (e.g., frontWheel#(1))
    Index { target: String, index: Box<Expression> },
}

/// A literal value
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Literal {
    /// Integer literal
    Integer(i64),
    /// Float literal
    Float(f64),
    /// String literal
    String(String),
    /// Boolean literal
    Boolean(bool),
}

/// Semantic role of an identifier for LSP semantic token highlighting.
/// Maps to standard LSP SemanticTokenType so the editor can style namespaces, types, classes, etc. distinctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticRole {
    /// Type reference (e.g. after `:` or `:>`)
    Type,
    /// Package name (namespace)
    Namespace,
    /// Definition name that acts as a type/class (part def, item def)
    Class,
    /// Interface definition name
    Interface,
    /// Property/feature name (attribute, port)
    Property,
    /// Action/behavior name (action def)
    Function,
}

/// Collects source ranges with their semantic role for AST-driven semantic highlighting.
/// Returns (range, role) so the server can map roles to LSP token types and override lexer heuristics.
pub fn collect_semantic_ranges(doc: &SysMLDocument) -> Vec<(SourceRange, SemanticRole)> {
    let mut out = Vec::new();
    for imp in &doc.imports {
        if let Some(ref pos) = imp.path_first_segment_position {
            out.push((pos.to_range(), SemanticRole::Namespace));
        }
    }
    for pkg in &doc.packages {
        if let Some(ref pos) = pkg.name_position {
            out.push((pos.to_range(), SemanticRole::Namespace));
        }
        for imp in &pkg.imports {
            if let Some(ref pos) = imp.path_first_segment_position {
                out.push((pos.to_range(), SemanticRole::Namespace));
            }
        }
        collect_semantic_ranges_members(&pkg.members, &mut out);
    }
    out
}

fn collect_semantic_ranges_members(members: &[Member], out: &mut Vec<(SourceRange, SemanticRole)>) {
    for m in members {
        match m {
            Member::PartDef(p) => {
                if let Some(ref pos) = p.name_position {
                    out.push((pos.to_range(), SemanticRole::Class));
                }
                if let (Some(ref spec), Some(ref pos)) = (&p.specializes, &p.specializes_position) {
                    if !is_type_skip_keyword(spec) {
                        let (ns_range, type_range) = type_ref_segment_ranges(spec, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                if let (Some(ref ty), Some(ref pos)) = (&p.type_ref, &p.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                collect_semantic_ranges_members(&p.members, out);
            }
            Member::PartUsage(p) => {
                if let Some(ref pos) = p.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                if let (Some(ref spec), Some(ref pos)) = (&p.specializes, &p.specializes_position) {
                    if !is_type_skip_keyword(spec) {
                        let (ns_range, type_range) = type_ref_segment_ranges(spec, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                if let (Some(ref ty), Some(ref pos)) = (&p.type_ref, &p.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                collect_semantic_ranges_members(&p.members, out);
            }
            Member::AttributeDef(a) => {
                if let Some(ref pos) = a.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                if let (Some(ref ty), Some(ref pos)) = (&a.type_ref, &a.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                if let (Some(ref spec), Some(ref pos)) = (&a.specializes, &a.specializes_position) {
                    if !is_type_skip_keyword(spec) {
                        let (ns_range, type_range) = type_ref_segment_ranges(spec, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                collect_semantic_ranges_members(&a.members, out);
            }
            Member::AttributeUsage(a) => {
                if let Some(ref pos) = a.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                collect_semantic_ranges_members(&a.members, out);
            }
            Member::PortDef(p) => {
                if !is_type_skip_keyword(&p.name) {
                    if let Some(ref pos) = p.name_position {
                        out.push((pos.to_range(), SemanticRole::Type));
                    }
                }
                if let (Some(ref spec), Some(ref pos)) = (&p.specializes, &p.specializes_position) {
                    if !is_type_skip_keyword(spec) {
                        let (ns_range, type_range) = type_ref_segment_ranges(spec, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                if let (Some(ref ty), Some(ref pos)) = (&p.type_ref, &p.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                collect_semantic_ranges_members(&p.members, out);
            }
            Member::PortUsage(p) => {
                if let Some(ref pos) = p.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                if let (Some(ref ty), Some(ref pos)) = (&p.type_ref, &p.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                collect_semantic_ranges_members(&p.members, out);
            }
            Member::InterfaceDef(i) => {
                if let Some(ref pos) = i.name_position {
                    out.push((pos.to_range(), SemanticRole::Interface));
                }
                collect_semantic_ranges_members(&i.members, out);
            }
            Member::InStatement(i) => {
                if let Some(ref pos) = i.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                if let (Some(ref spec), Some(ref pos)) = (&i.specializes, &i.specializes_position) {
                    if !is_type_skip_keyword(spec) {
                        let (ns_range, type_range) = type_ref_segment_ranges(spec, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
                if let (Some(ref ty), Some(ref pos)) = (&i.type_ref, &i.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
            }
            Member::EndStatement(e) => {
                if let Some(ref pos) = e.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                if let (Some(ref ty), Some(ref pos)) = (&e.type_ref, &e.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
            }
            Member::ConnectionUsage(c) => {
                if let Some(ref pos) = c.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
            }
            Member::ItemDef(i) => {
                if let Some(ref pos) = i.name_position {
                    out.push((pos.to_range(), SemanticRole::Class));
                }
                collect_semantic_ranges_members(&i.members, out);
            }
            Member::ItemUsage(i) => {
                if let Some(ref pos) = i.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                if let (Some(ref ty), Some(ref pos)) = (&i.type_ref, &i.type_ref_position) {
                    if !is_type_skip_keyword(ty) {
                        let (ns_range, type_range) = type_ref_segment_ranges(ty, pos);
                        if let Some(r) = ns_range {
                            out.push((r, SemanticRole::Namespace));
                        }
                        if let Some(r) = type_range {
                            out.push((r, SemanticRole::Type));
                        }
                    }
                }
            }
            Member::RequirementDef(r) => {
                if let Some(ref pos) = r.name_position {
                    out.push((pos.to_range(), SemanticRole::Class));
                }
                collect_semantic_ranges_members(&r.members, out);
            }
            Member::RequirementUsage(r) => {
                if let Some(ref pos) = r.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                collect_semantic_ranges_members(&r.members, out);
            }
            Member::ActionDef(a) => {
                if let Some(ref pos) = a.name_position {
                    out.push((pos.to_range(), SemanticRole::Function));
                }
            }
            Member::Package(p) => {
                if let Some(ref pos) = p.name_position {
                    out.push((pos.to_range(), SemanticRole::Namespace));
                }
                collect_semantic_ranges_members(&p.members, out);
            }
            Member::StateDef(s) => {
                if let Some(ref pos) = s.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                collect_semantic_ranges_members(&s.members, out);
            }
            Member::ExhibitState(s) => {
                if let Some(ref pos) = s.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                collect_semantic_ranges_members(&s.members, out);
            }
            Member::UseCase(u) => {
                if let Some(ref pos) = u.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                collect_semantic_ranges_members(&u.members, out);
            }
            Member::ActorDef(a) => {
                if let Some(ref pos) = a.name_position {
                    out.push((pos.to_range(), SemanticRole::Property));
                }
                collect_semantic_ranges_members(&a.members, out);
            }
            Member::TransitionStatement(t) => {
                if let Some(ref r) = t.range {
                    out.push((r.clone(), SemanticRole::Property));
                }
            }
            _ => {}
        }
    }
}

/// Collects all source ranges where a type reference appears in the document.
/// Used by the language server to classify those spans as "type" for semantic highlighting.
/// Prefer `collect_semantic_ranges` for full AST-driven highlighting (includes types and more).
pub fn collect_type_ref_ranges(doc: &SysMLDocument) -> Vec<SourceRange> {
    collect_semantic_ranges(doc)
        .into_iter()
        .filter(|(_, role)| *role == SemanticRole::Type)
        .map(|(r, _)| r)
        .collect()
}








