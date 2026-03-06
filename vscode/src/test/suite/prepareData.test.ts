import * as assert from "assert";
import { prepareDataForView } from "../../visualization/prepareData";

/**
 * Minimal mock data in the format produced by modelFetcher / fetchModelData.
 * Structure matches convertDTOElementsToJSON output.
 */
const createMockData = (overrides: Partial<{
    elements: unknown[];
    relationships: unknown[];
    sequenceDiagrams: unknown[];
    activityDiagrams: unknown[];
}> = {}) => ({
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
            const result = prepareDataForView(data, viewId);
            assert.ok(result != null, `prepareDataForView for "${viewId}" should return non-null`);
            assert.ok(result !== undefined, `prepareDataForView for "${viewId}" should return defined`);
        });
    });

    it("returns data unchanged for unknown view (pass-through)", () => {
        const data = createMockData();
        const result = prepareDataForView(data, "unknown");
        assert.strictEqual(result, data, "Unknown view should return data unchanged");
    });

    it("returns null/undefined for null input", () => {
        assert.strictEqual(prepareDataForView(null, "general-view"), null);
    });

    it("interconnection-view produces parts and connectors", () => {
        const data = createMockData();
        const result = prepareDataForView(data, "interconnection-view");
        assert.ok(Array.isArray(result.parts), "interconnection-view should have parts array");
        assert.ok(Array.isArray(result.connectors), "interconnection-view should have connectors array");
        assert.ok(Array.isArray(result.ports), "interconnection-view should have ports array");
    });

    it("action-flow-view produces diagrams", () => {
        const data = createMockData();
        const result = prepareDataForView(data, "action-flow-view");
        assert.ok(Array.isArray(result.diagrams), "action-flow-view should have diagrams array");
    });

    it("state-transition-view produces states and transitions", () => {
        const data = createMockData();
        const result = prepareDataForView(data, "state-transition-view");
        assert.ok(Array.isArray(result.states), "state-transition-view should have states array");
        assert.ok(Array.isArray(result.transitions), "state-transition-view should have transitions array");
    });

    it("sequence-view produces sequenceDiagrams", () => {
        const data = createMockData();
        const result = prepareDataForView(data, "sequence-view");
        assert.ok(Array.isArray(result.sequenceDiagrams), "sequence-view should have sequenceDiagrams array");
    });

    it("handles empty elements", () => {
        const data = createMockData({ elements: [], relationships: [] });
        const result = prepareDataForView(data, "general-view");
        assert.ok(result != null);
        assert.ok(Array.isArray(result.elements));
        assert.strictEqual(result.elements.length, 0);
    });
});
