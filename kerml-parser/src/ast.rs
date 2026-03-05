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
    /// Call statement
    Call(Call),
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

/// Collects all source ranges where a type reference appears in the document.
/// Used by the language server to classify those spans as "type" for semantic highlighting.
pub fn collect_type_ref_ranges(doc: &SysMLDocument) -> Vec<SourceRange> {
    let mut out = Vec::new();
    for pkg in &doc.packages {
        collect_type_ref_ranges_members(&pkg.members, &mut out);
    }
    out
}

fn collect_type_ref_ranges_members(members: &[Member], out: &mut Vec<SourceRange>) {
    for m in members {
        match m {
            Member::AttributeDef(a) => {
                if let Some(ref pos) = a.type_ref_position {
                    out.push(pos.to_range());
                }
                collect_type_ref_ranges_members(&a.members, out);
            }
            Member::PartDef(p) => {
                if let Some(ref pos) = p.type_ref_position {
                    out.push(pos.to_range());
                }
                collect_type_ref_ranges_members(&p.members, out);
            }
            Member::PartUsage(p) => {
                if let Some(ref pos) = p.type_ref_position {
                    out.push(pos.to_range());
                }
                collect_type_ref_ranges_members(&p.members, out);
            }
            Member::PortDef(p) => {
                if let Some(ref pos) = p.type_ref_position {
                    out.push(pos.to_range());
                }
                collect_type_ref_ranges_members(&p.members, out);
            }
            Member::PortUsage(p) => {
                if let Some(ref pos) = p.type_ref_position {
                    out.push(pos.to_range());
                }
                collect_type_ref_ranges_members(&p.members, out);
            }
            Member::InterfaceDef(i) => {
                collect_type_ref_ranges_members(&i.members, out);
            }
            Member::ItemDef(i) => {
                collect_type_ref_ranges_members(&i.members, out);
            }
            Member::ItemUsage(_) => {
                // ItemUsage has no nested members
            }
            Member::RequirementDef(r) => {
                collect_type_ref_ranges_members(&r.members, out);
            }
            Member::RequirementUsage(r) => {
                collect_type_ref_ranges_members(&r.members, out);
            }
            Member::ActionDef(_) => {
                // ActionDef has body (statements), not members; skip for type ref collection
            }
            Member::Package(p) => {
                collect_type_ref_ranges_members(&p.members, out);
            }
            _ => {}
        }
    }
}







