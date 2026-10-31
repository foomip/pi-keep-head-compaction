#!/usr/bin/env node
// Runs the test suite with coverage, then writes shields.io dynamic-json badge
// documents (plus decorative SVGs for pull-request diffs) into --out.
//
// The badge JSON lives on an orphan branch of this repository so the README can
// show a live coverage number without a third-party coverage service.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** @typedef {{lines: number, branches: number, functions: number}} Coverage */

const PALETTE = {
	brightgreen: "#4c1",
	yellowgreen: "#97ca00",
	yellow: "#dfb31e",
	orange: "#fe7d37",
	red: "#e05d44",
	grey: "#555",
	lightgrey: "#9f9f9f",
};

/**
 * Parse the `all files` row of `node --test --experimental-test-coverage`.
 * @param {string} output combined stdout+stderr of the test runner
 * @returns {Coverage | null}
 */
export function parseCoverage(output) {
	const row = output
		.split("\n")
		.map((line) => line.replace(/^[^\w]*ℹ\s?/, "").trim())
		.find((line) => line.startsWith("all files"));
	if (!row) return null;
	const numbers = row
		.split("|")
		.slice(1)
		.map((cell) => Number.parseFloat(cell.trim()));
	if (numbers.length < 3 || numbers.slice(0, 3).some((n) => !Number.isFinite(n))) {
		return null;
	}
	const [lines, branches, functions] = /** @type {[number, number, number]} */ (
		numbers
	);
	return { lines, branches, functions };
}

/**
 * One decimal place, trailing zero dropped: 93.85 -> "93.9%", 94 -> "94%".
 * @param {number} value
 * @returns {string}
 */
export function formatPercent(value) {
	const rounded = Math.round(value * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * File name for a shields dynamic-json badge: `badgeSlug("lines of source")`
 * -> `lines-of-source-badge.json`.
 * @param {string} slug
 * @returns {string}
 */
export function badgeSlug(slug) {
	return `${slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-badge.json`;
}

/**
 * Shields-style grading so the badge colour tracks the number.
 * @param {number} value
 * @returns {string}
 */
export function badgeColor(value) {
	if (value >= 90) return "brightgreen";
	if (value >= 80) return "yellowgreen";
	if (value >= 70) return "yellow";
	if (value >= 50) return "orange";
	return "red";
}

/**
 * Minimal flat-badge SVG (used for the PR comment; shields re-renders the real
 * badge from the JSON document).
 * @param {{label: string, message: string, color: string}} badge
 * @returns {string}
 */
export function renderBadgeSvg({ label, message, color }) {
	const fill = color.startsWith("#") ? color : (PALETTE[color] ?? PALETTE.grey);
	const width = (text) => 4 * text.length + 10;
	const left = width(label);
	const right = width(message);
	const total = left + right;
	const escape = (text) =>
		text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escape(label)}: ${escape(message)}">`,
		`<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
		`<rect rx="3" width="${total}" height="20" fill="#555"/><rect rx="3" x="${left}" width="${right}" height="20" fill="${fill}"/>`,
		`<rect rx="3" width="${total}" height="20" fill="url(#s)"/>`,
		`<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110" text-rendering="geometricPrecision">`,
		`<text aria-hidden="true" x="${(left / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${escape(label)}</text>`,
		`<text x="${(left / 2) * 10}" y="140" transform="scale(.1)">${escape(label)}</text>`,
		`<text aria-hidden="true" x="${(left + right / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${escape(message)}</text>`,
		`<text x="${(left + right / 2) * 10}" y="140" transform="scale(.1)">${escape(message)}</text>`,
		"</g></svg>",
	].join("");
}

/**
 * @param {Coverage} coverage
 * @returns {{label: string, slug: string, value: number}[]}
 */
export function badgeDefinitions(coverage) {
	return [
		{ label: "branch coverage", slug: "branch", value: coverage.branches },
		{ label: "line coverage", slug: "lines", value: coverage.lines },
		{ label: "function coverage", slug: "functions", value: coverage.functions },
	];
}

function parseArgv(argv) {
	const options = { out: "badges", coverageDir: ".coverage-tmp" };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--out") options.out = argv[++i];
		else if (arg === "--coverage-dir") options.coverageDir = argv[++i];
		else if (arg === "--skip-tests") options.skipTests = true;
	}
	return options;
}

function main() {
	const options = parseArgv(process.argv.slice(2));
	let output;
	if (options.skipTests) {
		output = fs.readFileSync(options.coverageDir, "utf8");
	} else {
		try {
			output = execFileSync(
				process.execPath,
				[
					"--test",
					"--experimental-test-coverage",
					"--test-coverage-exclude=test/**",
					// Tooling is covered by its own unit tests; the published badge
					// measures the shipped extension only.
					"--test-coverage-exclude=scripts/**",
					`--test-coverage-exclude=${options.coverageDir}/**`,
					"--test-coverage-exclude=**/node_modules/**",
					...fs
						.readdirSync("test")
						.filter((file) => file.endsWith(".test.ts"))
						.map((file) => path.join("test", file)),
				],
				{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			);
		} catch (error) {
			// A failing suite must not publish a stale badge number.
			process.stdout.write(error.stdout ?? "");
			process.stderr.write(error.stderr ?? "");
			process.exit(typeof error.status === "number" ? error.status : 1);
		}
	}
	fs.mkdirSync(options.out, { recursive: true });
	fs.mkdirSync(path.dirname(path.resolve(options.coverageDir)), { recursive: true });
	fs.writeFileSync(options.coverageDir, output);

	const coverage = parseCoverage(output);
	if (!coverage) {
		console.error("No coverage report found in the test runner output.");
		process.exit(1);
	}

	for (const { label, slug, value } of badgeDefinitions(coverage)) {
		const document = {
			schemaVersion: 1,
			label,
			message: formatPercent(value),
			color: badgeColor(value),
		};
		const file = badgeSlug(slug);
		fs.writeFileSync(path.join(options.out, file), `${JSON.stringify(document, null, 2)}\n`);
		fs.writeFileSync(
			path.join(options.out, `${file.replace(".json", "")}.svg`),
			renderBadgeSvg(document),
		);
		console.log(`${label}: ${document.message} (${document.color})`);
	}
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
	main();
}
