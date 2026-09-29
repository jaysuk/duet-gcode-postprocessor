#!/usr/bin/env node
/**
 * Print one version's section of CHANGELOG.md (the text under `## [x.y.z]` up to the next `## `)
 * for use as the GitHub Release body. Prints nothing and exits 1 when there is no such section, so
 * the release workflow can fall back to the generated Conventional-Commit changelog.
 *
 *   node scripts/changelog-section.mjs 1.3.0
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!version) {
	console.error("Usage: node scripts/changelog-section.mjs <version>");
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, "..", "CHANGELOG.md"), "utf8").split(/\r?\n/);
const heading = new RegExp(`^##\\s+\\[?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`);

const start = lines.findIndex((l) => heading.test(l));
if (start < 0) process.exit(1);

let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
if (end < 0) end = lines.length;

const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) process.exit(1);
process.stdout.write(body + "\n");
