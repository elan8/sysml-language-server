"use strict";
/**
 * Debug dump of graph data from sysml/model for General View verification.
 * Writes a JSON file and a human-readable summary to the workspace root.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dumpGraphForGeneralView = dumpGraphForGeneralView;
const fs = __importStar(require("fs"));
async function dumpGraphForGeneralView(graph, outPath) {
    if (!graph) {
        fs.writeFileSync(outPath, "No graph data received from server.\n", "utf-8");
        return;
    }
    const nodes = graph.nodes ?? [];
    const edges = graph.edges ?? [];
    const getType = (e) => (e.type || e.rel_type || "").toLowerCase();
    const nodeType = (n) => (n?.type ?? "").toLowerCase();
    const isPartDef = (n) => n && nodeType(n).includes("part def");
    const isPartUsage = (n) => n && (nodeType(n) === "part" || nodeType(n).includes("part usage"));
    const isPartOrPartDef = (n) => isPartDef(n) || isPartUsage(n);
    const partNodes = nodes.filter((n) => isPartOrPartDef(n));
    const containsEdges = edges.filter((e) => getType(e) === "contains");
    const typingEdges = edges.filter((e) => getType(e) === "typing");
    const partContainsEdges = containsEdges.filter((e) => {
        const src = nodes.find((n) => n.id === e.source);
        const tgt = nodes.find((n) => n.id === e.target);
        return src && tgt && isPartOrPartDef(src) && isPartOrPartDef(tgt);
    });
    const partTypingEdges = typingEdges.filter((e) => {
        const src = nodes.find((n) => n.id === e.source);
        const tgt = nodes.find((n) => n.id === e.target);
        return src && tgt && isPartOrPartDef(src) && isPartOrPartDef(tgt);
    });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    let report = "Graph dump for General View verification\n";
    report += "==========================================\n\n";
    report += `Total nodes: ${nodes.length}\n`;
    report += `Total edges: ${edges.length}\n`;
    report += `Contains edges: ${containsEdges.length}\n`;
    report += `Typing edges: ${typingEdges.length}\n\n`;
    report += `Part/PartDef nodes: ${partNodes.length}\n`;
    report += `Contains edges (part↔partDef only): ${partContainsEdges.length}\n`;
    report += `Typing edges (part↔partDef only): ${partTypingEdges.length}\n\n`;
    report += "--- Part/PartDef nodes (id, type, name) ---\n";
    partNodes.forEach((n) => {
        report += `  ${n.id} | type="${n.type}" | ${n.name}\n`;
    });
    report += "\n--- Contains edges (part↔partDef) ---\n";
    partContainsEdges.forEach((e) => {
        const src = nodeById.get(e.source);
        const tgt = nodeById.get(e.target);
        report += `  ${e.source} -> ${e.target}\n`;
        report += `    (${src?.type} "${src?.name}" -> ${tgt?.type} "${tgt?.name}")\n`;
    });
    report += "\n--- Typing edges (part↔partDef) ---\n";
    partTypingEdges.forEach((e) => {
        const src = nodeById.get(e.source);
        const tgt = nodeById.get(e.target);
        report += `  ${e.source} -> ${e.target}\n`;
        report += `    (${src?.type} "${src?.name}" -> ${tgt?.type} "${tgt?.name}")\n`;
    });
    report += "\n--- All contains edges (first 5) ---\n";
    containsEdges.slice(0, 5).forEach((e) => {
        report += `  ${e.source} -> ${e.target} (type: ${e.type || e.rel_type})\n`;
    });
    report += "\n--- All typing edges (first 5) ---\n";
    typingEdges.slice(0, 5).forEach((e) => {
        report += `  ${e.source} -> ${e.target} (type: ${e.type || e.rel_type})\n`;
    });
    const jsonPath = outPath.replace(/\.txt$/, ".json");
    fs.writeFileSync(jsonPath, JSON.stringify({ nodes, edges }, null, 2), "utf-8");
    fs.writeFileSync(outPath, report, "utf-8");
}
//# sourceMappingURL=graphDump.js.map