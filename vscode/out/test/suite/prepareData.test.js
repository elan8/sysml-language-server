"use strict";
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
const assert = __importStar(require("assert"));
const prepareData_1 = require("../../visualization/prepareData");
/**
 * Minimal mock data in the format produced by modelFetcher / fetchModelData.
 * With graph: nodes + edges (preferred). Without: elements + relationships (legacy).
 */
const createMockData = (overrides = {}) => ({
    elements: [
        {
            name: "SurveillanceDrone",
            type: "package",
            id: "SurveillanceDrone",
            attributes: {},
            properties: {},
            typing: undefined,
            typings: [],
            children: [
                {
                    name: "Propulsion",
                    type: "part def",
                    id: "Propulsion",
                    children: [
                        {
                            name: "propulsionUnit1",
                            type: "part",
                            id: "propulsionUnit1",
                            typing: "PropulsionUnit",
                            typings: ["PropulsionUnit"],
                            children: [],
                            relationships: []
                        }
                    ],
                    relationships: []
                },
                {
                    name: "PatrolOverwatch",
                    type: "use case def",
                    id: "PatrolOverwatch",
                    children: [],
                    relationships: []
                },
                {
                    name: "Operator",
                    type: "item def",
                    id: "Operator",
                    children: [],
                    relationships: []
                },
                {
                    name: "FlightModeStateMachine",
                    type: "state def",
                    id: "FlightModeStateMachine",
                    children: [
                        { name: "manual", type: "state", id: "manual", children: [], relationships: [] }
                    ],
                    relationships: []
                }
            ],
            relationships: [
                { type: "typing", source: "propulsionUnit1", target: "PropulsionUnit" }
            ]
        }
    ],
    relationships: [
        { type: "specializes", source: "A", target: "B" },
        { type: "connection", source: "X", target: "Y" }
    ],
    sequenceDiagrams: [
        {
            name: "Seq1",
            participants: [{ name: "Actor1", type: "actor" }],
            messages: [{ name: "msg1", from: "Actor1", to: "System", payload: "data", occurrence: 1 }]
        }
    ],
    activityDiagrams: [
        {
            name: "Act1",
            actions: [{ name: "start", type: "initial", kind: "initial", id: "start" }],
            flows: [{ from: "start", to: "done" }],
            decisions: []
        }
    ],
    ...overrides
});
describe("prepareDataForView", () => {
    const VIEW_IDS = ["general-view", "interconnection-view", "action-flow-view", "state-transition-view", "sequence-view"];
    VIEW_IDS.forEach((viewId) => {
        it(`returns non-null for view "${viewId}"`, () => {
            const data = createMockData();
            const result = (0, prepareData_1.prepareDataForView)(data, viewId);
            assert.ok(result != null, `prepareDataForView for "${viewId}" should return non-null`);
            assert.ok(result !== undefined, `prepareDataForView for "${viewId}" should return defined`);
        });
    });
    it("returns data unchanged for unknown view (pass-through)", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "unknown");
        assert.strictEqual(result, data, "Unknown view should return data unchanged");
    });
    it("returns null/undefined for null input", () => {
        assert.strictEqual((0, prepareData_1.prepareDataForView)(null, "general-view"), null);
    });
    it("interconnection-view produces parts and connectors", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "interconnection-view");
        assert.ok(Array.isArray(result.parts), "interconnection-view should have parts array");
        assert.ok(Array.isArray(result.connectors), "interconnection-view should have connectors array");
        assert.ok(Array.isArray(result.ports), "interconnection-view should have ports array");
    });
    it("action-flow-view produces diagrams", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "action-flow-view");
        assert.ok(Array.isArray(result.diagrams), "action-flow-view should have diagrams array");
    });
    it("state-transition-view produces states and transitions", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "state-transition-view");
        assert.ok(Array.isArray(result.states), "state-transition-view should have states array");
        assert.ok(Array.isArray(result.transitions), "state-transition-view should have transitions array");
    });
    it("sequence-view produces sequenceDiagrams", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "sequence-view");
        assert.ok(Array.isArray(result.sequenceDiagrams), "sequence-view should have sequenceDiagrams array");
    });
    it("handles empty elements", () => {
        const data = createMockData({ elements: [], relationships: [] });
        const result = (0, prepareData_1.prepareDataForView)(data, "general-view");
        assert.ok(result != null);
        assert.ok(Array.isArray(result.elements));
        assert.strictEqual(result.elements.length, 0);
    });
    it("handles graph input and produces elements for views", () => {
        const graphData = {
            graph: {
                nodes: [
                    { id: "pkg1", name: "pkg1", type: "package", range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, attributes: {} },
                    { id: "pkg1::el1", name: "el1", type: "part def", parentId: "pkg1", range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, attributes: {} },
                ],
                edges: [
                    { source: "pkg1", target: "pkg1::el1", type: "contains" },
                    { source: "pkg1::el1", target: "Other", type: "typing" },
                ],
            },
        };
        const result = (0, prepareData_1.prepareDataForView)(graphData, "interconnection-view");
        assert.ok(Array.isArray(result.parts));
        assert.ok(Array.isArray(result.connectors));
    });
    it("graphToElementTree builds tree from contains edges", () => {
        const graph = {
            nodes: [
                { id: "root", name: "root", type: "package", range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, attributes: {} },
                { id: "root::child", name: "child", type: "part", parentId: "root", range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, attributes: {} },
            ],
            edges: [{ source: "root", target: "root::child", type: "contains" }],
        };
        const roots = (0, prepareData_1.graphToElementTree)(graph);
        assert.strictEqual(roots.length, 1);
        assert.strictEqual(roots[0].name, "root");
        assert.strictEqual(roots[0].children?.length, 1);
        assert.strictEqual(roots[0].children[0].name, "child");
    });
});
//# sourceMappingURL=prepareData.test.js.map