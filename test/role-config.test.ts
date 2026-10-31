import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	detectSessionRole,
	loadConfig,
	parseConfigObject,
	resolveRoleConfig,
} from "../extensions/keep-head-compaction.ts";

const BASE = {
	headTokens: 20000,
	tailTokens: 20000,
	maxTokens: 8192,
	minMiddleTokens: 500,
};

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withProjectConfig(config: unknown): string {
	const project = tempDir("keep-head-config-");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "keep-head-compaction.json"),
		JSON.stringify(config),
	);
	return project;
}

test("a full subagent block is parsed with every key", () => {
	const config = parseConfigObject({
		headTokens: 20000,
		subagent: {
			headTokens: 12000,
			tailTokens: 6000,
			model: "google/gemini-2.5-flash",
			maxTokens: 2048,
			minMiddleTokens: 100,
		},
	});

	assert.deepEqual(config.subagent, {
		headTokens: 12000,
		tailTokens: 6000,
		model: "google/gemini-2.5-flash",
		maxTokens: 2048,
		minMiddleTokens: 100,
	});
});

test("a partial subagent block keeps only the keys it names", () => {
	const config = parseConfigObject({ subagent: { headTokens: 12000 } });

	assert.deepEqual(config.subagent, { headTokens: 12000 });
});

test("an invalid subagent value degrades to absent", () => {
	const config = parseConfigObject({ headTokens: 20000, subagent: { headTokens: "lots" } });

	assert.equal(config.subagent?.headTokens, undefined);
	assert.deepEqual(resolveRoleConfig(config, "subagent", {}), { ...BASE, model: undefined });
});

test("a non-object subagent block is ignored", () => {
	assert.equal(parseConfigObject({ subagent: "nope" }).subagent, undefined);
	assert.equal(parseConfigObject({ subagent: [1, 2] }).subagent, undefined);
	assert.equal(parseConfigObject({ subagent: 7 }).subagent, undefined);
});

test("an absent subagent block stays absent", () => {
	assert.equal(parseConfigObject({ headTokens: 20000 }).subagent, undefined);
});

test("role detection reads only PI_SUBAGENT_CHILD=1", () => {
	assert.equal(detectSessionRole({ PI_SUBAGENT_CHILD: "1" }), "subagent");
	assert.equal(detectSessionRole({}), "parent");
	assert.equal(detectSessionRole({ PI_SUBAGENT_CHILD: "0" }), "parent");
	assert.equal(detectSessionRole({ PI_SUBAGENT_CHILD: "true" }), "parent");
});

test("a child resolves the override while a parent ignores it", () => {
	const config = parseConfigObject({
		headTokens: 20000,
		tailTokens: 20000,
		subagent: { headTokens: 12000, tailTokens: 6000 },
	});

	const child = resolveRoleConfig(config, "subagent", {});
	assert.equal(child.headTokens, 12000);
	assert.equal(child.tailTokens, 6000);
	assert.equal(child.maxTokens, BASE.maxTokens);

	const parent = resolveRoleConfig(config, "parent", {});
	assert.equal(parent.headTokens, 20000);
	assert.equal(parent.tailTokens, 20000);
});

test("partial overrides inherit the base keys", () => {
	const config = parseConfigObject({
		headTokens: 20000,
		tailTokens: 18000,
		maxTokens: 4096,
		subagent: { headTokens: 12000 },
	});

	const child = resolveRoleConfig(config, "subagent", {});
	assert.equal(child.headTokens, 12000);
	assert.equal(child.tailTokens, 18000);
	assert.equal(child.maxTokens, 4096);
	assert.equal(child.minMiddleTokens, BASE.minMiddleTokens);
});

test("PI_KEEP_HEAD_TOKENS wins for both roles", () => {
	const config = parseConfigObject({ subagent: { headTokens: 12000 } });
	const env = { PI_KEEP_HEAD_TOKENS: "7777" };

	assert.equal(resolveRoleConfig(config, "subagent", env).headTokens, 7777);
	assert.equal(resolveRoleConfig(config, "parent", env).headTokens, 7777);
});

test("no subagent block resolves identically to the base for both roles", () => {
	const config = parseConfigObject({ headTokens: 19000, tailTokens: 9000, maxTokens: 2048 });

	assert.deepEqual(
		resolveRoleConfig(config, "subagent", {}),
		resolveRoleConfig(config, "parent", {}),
	);
});

test("headTokens 0 survives as the documented opt-out", () => {
	const config = parseConfigObject({ subagent: { headTokens: 0 } });
	const child = resolveRoleConfig(config, "subagent", {});

	assert.equal(child.headTokens, 0);
	assert.equal(child.tailTokens, BASE.tailTokens);
});

test("loadConfig merges project over global and keeps the nested block", () => {
	const home = tempDir("keep-head-home-");
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".pi", "agent", "keep-head-compaction.json"),
		JSON.stringify({ headTokens: 15000, tailTokens: 15000, subagent: { tailTokens: 5000 } }),
	);
	const project = withProjectConfig({
		headTokens: 10000,
		subagent: { headTokens: 12000 },
	});

	const config = loadConfig(project, { HOME: home });
	assert.equal(config.headTokens, 10000);
	assert.equal(config.tailTokens, 15000);
	assert.equal(config.subagent?.headTokens, 12000);
	assert.equal(config.subagent?.tailTokens, 5000);
});

test("the README example resolves through the config loader", () => {
	const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
		.map((match) => match[1])
		.filter((text) => text.includes('"subagent"'));
	assert.equal(blocks.length, 1, "README must contain exactly one subagent example block");

	const project = withProjectConfig(JSON.parse(blocks[0]));
	const config = loadConfig(project, { HOME: tempDir("keep-head-empty-home-") });

	const child = resolveRoleConfig(config, "subagent", {});
	assert.equal(child.headTokens, 12000);
	assert.equal(child.tailTokens, 6000);

	const parent = resolveRoleConfig(config, "parent", {});
	assert.equal(parent.headTokens, 20000);
	assert.equal(parent.tailTokens, 20000);
});
