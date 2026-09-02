import { describe, expect, it } from "vitest";

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";

import { createGcodeApi } from "../model/steps/scriptApi";
import { SandboxEngine, serialiseLineState } from "../model/steps/quickjs/sandboxEngine";
import { createState } from "../model/gcode/state";
import { emptyMetadata } from "../model/gcode/metadata";
import { tokenise } from "../model/gcode/tokenise";
import type { LineContext } from "../model/steps/types";
import type { QuickJsModuleLike } from "../model/steps/quickjs/loader";

/**
 * The safety net for `vmStdlib.ts`'s hand-ported duplicate of `scriptApi.ts`/`tokenise.ts`: runs the
 * same battery of representative G-code lines through the real host `gcode` object and the real
 * ported copy evaluated inside a real QuickJS VM, and asserts every method agrees exactly. Any future
 * change to one copy that is not mirrored in the other fails here, not silently in a user's recipe.
 */

const LINES = [
	"G1 X10 Y20 E1.5 F1800",
	"G1 X10  Y20",
	"G0 X0 Y0",
	"G28",
	"M104 S210",
	"M291 P\"done; resuming\" S0",
	"G1 X1 F{move.speedFactor}",
	"; a full comment line",
	"",
	"G1 X10 Y20 E1 F1200 ; travel",
	"G1 E-1 F1800",
	"G92 E0",
];

/** The same battery of `gcode.*` calls, run against the host implementation, for comparison against
 *  what the VM script (below) computes via `log()`. */
function hostBattery(line: string) {
	const gcode = createGcodeApi();
	return {
		parse: gcode.parse(line),
		num_X: gcode.num(line, "X"),
		num_F: gcode.num(line, "F"),
		str_P: gcode.str(line, "P"),
		has_Y: gcode.has(line, "Y"),
		set_F: gcode.set(line, "F", 1234, 1),
		scale_F: gcode.scale(line, "F", 0.5, 2),
		offset_Z: gcode.offset(line, "Z", 0.1, 3),
		remove_Y: gcode.remove(line, "Y"),
		isMove: gcode.isMove(line),
		isExtrusion: gcode.isExtrusion(line, false),
		isExtrusionRel: gcode.isExtrusion(line, true),
		setComment_new: gcode.setComment(line, "new"),
		setComment_null: gcode.setComment(line, null),
		format: gcode.format(3.14159, 2),
		command: gcode.command(line),
	};
}

const VM_BATTERY_SCRIPT = `
log(JSON.stringify({
	parse: gcode.parse(line),
	num_X: gcode.num(line, "X"),
	num_F: gcode.num(line, "F"),
	str_P: gcode.str(line, "P"),
	has_Y: gcode.has(line, "Y"),
	set_F: gcode.set(line, "F", 1234, 1),
	scale_F: gcode.scale(line, "F", 0.5, 2),
	offset_Z: gcode.offset(line, "Z", 0.1, 3),
	remove_Y: gcode.remove(line, "Y"),
	isMove: gcode.isMove(line),
	isExtrusion: gcode.isExtrusion(line, false),
	isExtrusionRel: gcode.isExtrusion(line, true),
	setComment_new: gcode.setComment(line, "new"),
	setComment_null: gcode.setComment(line, null),
	format: gcode.format(3.14159, 2),
	command: gcode.command(line),
}));
return line;
`;

function ctxFor(line: string): LineContext {
	const state = createState();
	return { ...state, token: tokenise(line), meta: emptyMetadata(), totalLayers: null, progress: null };
}

describe("quickjs standard library parity with the host scriptApi", () => {
	it("agrees with the host gcode API on every method, for a representative battery of lines", async () => {
		const QuickJS = (await newQuickJSWASMModuleFromVariant(variant)) as unknown as QuickJsModuleLike;
		const engine = new SandboxEngine(QuickJS, VM_BATTERY_SCRIPT);
		try {
			for (const line of LINES) {
				const outcome = engine.runLine(line, serialiseLineState(ctxFor(line)));
				expect(outcome.logs).toHaveLength(1);
				const vmResult = JSON.parse(outcome.logs[0]) as unknown;
				expect(vmResult).toEqual(hostBattery(line));
			}
		} finally {
			engine.dispose();
		}
	});
});
