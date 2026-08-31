import { describe, expect, it } from "vitest";

import { checkMacros } from "../dwc/macroCheck";
import { FakeGateway } from "./helpers";

describe("checkMacros", () => {
	it("reports nothing when the macro exists", async () => {
		const gateway = new FakeGateway({ "0:/macros/timelapse.g": "M400" });
		const results = await checkMacros(gateway, [{ path: "0:/macros/timelapse.g", count: 1, firstLine: 5 }]);
		expect(results).toEqual([]);
	});

	it("reports an error naming the path and the line when the macro is missing", async () => {
		const gateway = new FakeGateway();
		const results = await checkMacros(gateway, [{ path: "0:/macros/timelapse.g", count: 1, firstLine: 5 }]);
		expect(results).toHaveLength(1);
		expect(results[0].level).toBe("error");
		expect(results[0].detail).toContain("0:/macros/timelapse.g");
		expect(results[0].detail).toContain("line 5");
	});

	it("mentions the repeat count when a missing macro is called more than once", async () => {
		const gateway = new FakeGateway();
		const results = await checkMacros(gateway, [{ path: "0:/macros/x.g", count: 3, firstLine: 2 }]);
		expect(results[0].detail).toContain("3 times");
	});

	it("resolves a relative path against the volume root before checking", async () => {
		const gateway = new FakeGateway({ "0:/macros/foo.g": "M400" });
		const results = await checkMacros(gateway, [{ path: "macros/foo.g", count: 1, firstLine: 1 }]);
		expect(results).toEqual([]);
	});

	it("reports a missing relative path using the resolved location", async () => {
		const gateway = new FakeGateway();
		const results = await checkMacros(gateway, [{ path: "macros/foo.g", count: 1, firstLine: 1 }]);
		expect(results[0].detail).toContain("0:/macros/foo.g");
	});

	it("treats a failed lookup as inconclusive, not as missing", async () => {
		const gateway = new FakeGateway();
		gateway.sizeOf = async () => { throw new Error("disconnected"); };
		const results = await checkMacros(gateway, [{ path: "0:/macros/timelapse.g", count: 1, firstLine: 5 }]);
		expect(results).toEqual([]);
	});

	it("checks every distinct reference independently", async () => {
		const gateway = new FakeGateway({ "0:/macros/a.g": "M400" });
		const results = await checkMacros(gateway, [
			{ path: "0:/macros/a.g", count: 1, firstLine: 1 },
			{ path: "0:/macros/b.g", count: 1, firstLine: 2 },
		]);
		expect(results).toHaveLength(1);
		expect(results[0].detail).toContain("0:/macros/b.g");
	});

	it("returns nothing for an empty reference list", async () => {
		expect(await checkMacros(new FakeGateway(), [])).toEqual([]);
	});
});
