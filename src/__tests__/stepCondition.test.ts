import { describe, expect, it } from "vitest";

import { emptyMetadata } from "../model/gcode/metadata";
import {
	describeStepConditions, stepConditionsMet, testStepCondition, type StepCondition,
} from "../model/stepCondition";

describe("testStepCondition", () => {
	it("matches a known typed field (slicer) case-insensitively", () => {
		const meta = { ...emptyMetadata(), slicer: "PrusaSlicer" as const };
		expect(testStepCondition({ key: "slicer", op: "eq", value: "prusaslicer" }, meta)).toBe(true);
	});

	it("treats \"unknown\" slicer as absent, not a real value to match against", () => {
		const meta = emptyMetadata(); // slicer: "unknown"
		expect(testStepCondition({ key: "slicer", op: "exists" }, meta)).toBe(false);
		expect(testStepCondition({ key: "slicer", op: "eq", value: "unknown" }, meta)).toBe(false);
	});

	it("matches a numeric typed field with gt/lt/gte/lte", () => {
		const meta = { ...emptyMetadata(), totalLayers: 250 };
		expect(testStepCondition({ key: "totalLayers", op: "gt", value: 200 }, meta)).toBe(true);
		expect(testStepCondition({ key: "totalLayers", op: "lt", value: 200 }, meta)).toBe(false);
		expect(testStepCondition({ key: "totalLayers", op: "gte", value: 250 }, meta)).toBe(true);
		expect(testStepCondition({ key: "totalLayers", op: "lte", value: 250 }, meta)).toBe(true);
	});

	it("falls back to meta.values for an arbitrary key, normalised the same way values already are", () => {
		const meta = emptyMetadata();
		meta.values.set("filament_type", "PETG");
		expect(testStepCondition({ key: "Filament Type", op: "eq", value: "petg" }, meta)).toBe(true);
		expect(testStepCondition({ key: "filament_type", op: "eq", value: "PLA" }, meta)).toBe(false);
	});

	it("reads a numeric-looking meta.values entry as a number for gt/lt", () => {
		const meta = emptyMetadata();
		meta.values.set("max_volumetric_speed", "15");
		expect(testStepCondition({ key: "max_volumetric_speed", op: "gt", value: 10 }, meta)).toBe(true);
	});

	it("exists/notExists on an arbitrary key", () => {
		const meta = emptyMetadata();
		meta.values.set("filament_type", "PETG");
		expect(testStepCondition({ key: "filament_type", op: "exists" }, meta)).toBe(true);
		expect(testStepCondition({ key: "nozzle_diameter", op: "exists" }, meta)).toBe(false);
		expect(testStepCondition({ key: "nozzle_diameter", op: "notExists" }, meta)).toBe(true);
	});

	it("contains is a case-insensitive substring test", () => {
		const meta = emptyMetadata();
		meta.values.set("notes", "Printed with a hardened nozzle");
		expect(testStepCondition({ key: "notes", op: "contains", value: "HARDENED" }, meta)).toBe(true);
		expect(testStepCondition({ key: "notes", op: "contains", value: "brass" }, meta)).toBe(false);
	});

	it("neq is true for a key that is not set at all", () => {
		const meta = emptyMetadata();
		expect(testStepCondition({ key: "filament_type", op: "neq", value: "PETG" }, meta)).toBe(true);
	});

	it("gt/lt/eq are false, not throwing, when the key resolves to a non-numeric string", () => {
		const meta = emptyMetadata();
		meta.values.set("filament_type", "PETG");
		expect(testStepCondition({ key: "filament_type", op: "gt", value: 10 }, meta)).toBe(false);
	});
});

describe("stepConditionsMet", () => {
	it("is true with no conditions at all — always run", () => {
		expect(stepConditionsMet(undefined, emptyMetadata())).toBe(true);
		expect(stepConditionsMet([], emptyMetadata())).toBe(true);
	});

	it("requires every condition to hold (AND)", () => {
		const meta = { ...emptyMetadata(), slicer: "PrusaSlicer" as const, totalLayers: 250 };
		const conditions: Array<StepCondition> = [
			{ key: "slicer", op: "eq", value: "PrusaSlicer" },
			{ key: "totalLayers", op: "gt", value: 200 },
		];
		expect(stepConditionsMet(conditions, meta)).toBe(true);
		expect(stepConditionsMet([...conditions, { key: "totalLayers", op: "gt", value: 300 }], meta)).toBe(false);
	});
});

describe("describeStepConditions", () => {
	it("renders a readable summary for the skipped-step report", () => {
		const conditions: Array<StepCondition> = [
			{ key: "filament_type", op: "eq", value: "PETG" },
			{ key: "totalLayers", op: "gt", value: 200 },
		];
		expect(describeStepConditions(conditions)).toBe("filament_type = PETG and totalLayers > 200");
	});

	it("renders exists/notExists without a value", () => {
		expect(describeStepConditions([{ key: "filament_type", op: "exists" }])).toBe("filament_type is set");
	});
});
