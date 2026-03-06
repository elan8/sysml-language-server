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
 * Structure matches convertDTOElementsToJSON output.
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
    const VIEW_IDS = ["elk", "tree", "package", "graph", "hierarchy", "ibd", "activity", "state", "sequence", "usecase"];
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
        assert.strictEqual((0, prepareData_1.prepareDataForView)(null, "elk"), null);
    });
    it("ibd view produces parts and connectors", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "ibd");
        assert.ok(Array.isArray(result.parts), "ibd should have parts array");
        assert.ok(Array.isArray(result.connectors), "ibd should have connectors array");
        assert.ok(Array.isArray(result.ports), "ibd should have ports array");
    });
    it("package view produces nodes", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "package");
        assert.ok(Array.isArray(result.nodes), "package should have nodes array");
        assert.ok(Array.isArray(result.dependencies), "package should have dependencies array");
    });
    it("activity view produces diagrams", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "activity");
        assert.ok(Array.isArray(result.diagrams), "activity should have diagrams array");
    });
    it("state view produces states and transitions", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "state");
        assert.ok(Array.isArray(result.states), "state should have states array");
        assert.ok(Array.isArray(result.transitions), "state should have transitions array");
    });
    it("sequence view produces sequenceDiagrams", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "sequence");
        assert.ok(Array.isArray(result.sequenceDiagrams), "sequence should have sequenceDiagrams array");
    });
    it("usecase view produces actors and useCases", () => {
        const data = createMockData();
        const result = (0, prepareData_1.prepareDataForView)(data, "usecase");
        assert.ok(Array.isArray(result.actors), "usecase should have actors array");
        assert.ok(Array.isArray(result.useCases), "usecase should have useCases array");
        assert.ok(Array.isArray(result.relationships), "usecase should have relationships array");
    });
    it("handles empty elements", () => {
        const data = createMockData({ elements: [], relationships: [] });
        const result = (0, prepareData_1.prepareDataForView)(data, "elk");
        assert.ok(result != null);
        assert.ok(Array.isArray(result.elements));
        assert.strictEqual(result.elements.length, 0);
    });
});
//# sourceMappingURL=prepareData.test.js.map