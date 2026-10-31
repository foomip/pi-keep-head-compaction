import assert from "node:assert/strict";
import test from "node:test";

import {
	badgeColor,
	badgeSlug,
	formatPercent,
	parseCoverage,
	renderBadgeSvg,
} from "../scripts/coverage-badges.mjs";

const REPORT = [
	"ℹ start of coverage report",
	"ℹ -----------------------------------------------------------------",
	"ℹ file                     | line % | branch % | funcs % | lines",
	"ℹ -----------------------------------------------------------------",
	"ℹ extensions               |        |          |         | ",
	"ℹ  keep-head-compaction.ts |  46.36 |    93.85 |   47.06 | 219-232",
	"ℹ -----------------------------------------------------------------",
	"ℹ all files                |  46.36 |    93.85 |   47.06 | ",
	"ℹ -----------------------------------------------------------------",
	"ℹ end of coverage report",
].join("\n");

test("parseCoverage reads the all-files row of the node test runner report", () => {
	assert.deepEqual(parseCoverage(REPORT), {
		lines: 46.36,
		branches: 93.85,
		functions: 47.06,
	});
});

test("parseCoverage ignores file and directory rows", () => {
	const single = [
		"ℹ extensions               |  12.00 |  55.00 |  12.00 | ",
		"ℹ  keep-head-compaction.ts |  46.36 |  93.85 |  47.06 | 219-232",
		"ℹ all files                |  10 |    20 |   30 | ",
	].join("\n");
	assert.deepEqual(parseCoverage(single), {
		lines: 10,
		branches: 20,
		functions: 30,
	});
});

test("parseCoverage returns null when no report is present", () => {
	assert.equal(parseCoverage("ℹ pass 13\n"), null);
});

test("formatPercent drops a redundant fraction", () => {
	assert.equal(formatPercent(93.85), "93.9%");
	assert.equal(formatPercent(94), "94%");
	assert.equal(formatPercent(46.36), "46.4%");
});

test("badgeSlug keeps shield dynamic-json slugs filesystem safe", () => {
	assert.equal(badgeSlug("branch"), "branch-badge.json");
	assert.equal(badgeSlug("lines of source"), "lines-of-source-badge.json");
	assert.equal(badgeSlug("a/b c"), "a-b-c-badge.json");
});

test("badgeColor grades the percentage on a shields-compatible scale", () => {
	assert.equal(badgeColor(93.85), "brightgreen");
	assert.equal(badgeColor(85), "yellowgreen");
	assert.equal(badgeColor(70), "yellow");
	assert.equal(badgeColor(55), "orange");
	assert.equal(badgeColor(20), "red");
});

test("renderBadgeSvg emits a label/value badge with escaped text", () => {
	const svg = renderBadgeSvg({
		label: "coverage",
		message: "93.9%",
		color: "brightgreen",
	});
	assert.ok(svg.startsWith("<svg"));
	assert.ok(svg.includes(">coverage<"));
	assert.ok(svg.includes(">93.9%<"));
	assert.ok(svg.includes('fill="#555"'));
	assert.ok(svg.includes('fill="#4c1"'));
	assert.ok(svg.includes('transform="scale(.1)"'));
	assert.ok(renderBadgeSvg({ label: "a&b", message: "x", color: "red" }).includes("a&amp;b"));
});
