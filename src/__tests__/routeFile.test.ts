import { describe, expect, it } from "vitest";
import { sdPathFromRouteParams } from "../model/routeFile";

describe("sdPathFromRouteParams", () => {
	it("builds a full SD path from a numeric volume and a plain path", () => {
		expect(sdPathFromRouteParams({ volume: "1", path: "gcodes/foo.g" })).toBe("1:/gcodes/foo.g");
	});

	it("defaults to volume 0 when volume is missing", () => {
		expect(sdPathFromRouteParams({ path: "gcodes/foo.g" })).toBe("0:/gcodes/foo.g");
	});

	it("defaults to volume 0 when volume is present but not numeric", () => {
		expect(sdPathFromRouteParams({ volume: "not-a-number", path: "gcodes/foo.g" })).toBe("0:/gcodes/foo.g");
	});

	it("joins a catch-all path that Vue Router hands back as an array of segments", () => {
		expect(sdPathFromRouteParams({ volume: "0", path: ["gcodes", "sub", "foo.g"] })).toBe("0:/gcodes/sub/foo.g");
	});

	it("takes the first element when volume is (unexpectedly) an array", () => {
		expect(sdPathFromRouteParams({ volume: ["2", "3"], path: "foo.g" })).toBe("2:/foo.g");
	});

	it("returns empty when path is missing entirely (the plugin's bare route)", () => {
		expect(sdPathFromRouteParams({})).toBe("");
		expect(sdPathFromRouteParams({ volume: "0" })).toBe("");
	});

	it("returns empty when path is an empty string", () => {
		expect(sdPathFromRouteParams({ path: "" })).toBe("");
	});

	it("returns empty when path is an empty array", () => {
		expect(sdPathFromRouteParams({ path: [] })).toBe("");
	});
});
