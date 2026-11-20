import assert from "node:assert/strict";
import test from "node:test";

import { summarizeMiddleSpan } from "../extensions/keep-head-compaction.ts";

/**
 * Delegation tests (OpenSpec change pi-better-compact-parity).
 *
 * The middle summary must come from the host's own `compact()` function, so these
 * tests inject a fake for that call and assert exactly what the extension hands it
 * and what it does with the result. Nothing here drives the extension host.
 */

interface Capture {
	model: any;
	preparation: any;
	customInstructions: unknown;
	thinkingLevel: unknown;
	retry: unknown;
	env: unknown;
	signal: unknown;
}

function preparationFixture(overrides: Record<string, unknown> = {}) {
	return {
		firstKeptEntryId: "keep-1",
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "middle" }], timestamp: 0 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1234,
		previousSummary: undefined,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		...overrides,
	};
}

function fakeDeps(captured: Capture[], result?: unknown) {
	return {
		compact: async (...args: any[]) => {
			const [preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, , env, retry] =
				args;
			captured.push({
				preparation,
				model,
				customInstructions,
				signal,
				thinkingLevel,
				retry,
				env,
			});
			assert.ok(apiKey !== undefined, "credentials must be handed to the delegated call");
			return (
				result ?? {
					summary: "## Goal\nstub",
					firstKeptEntryId: "keep-1",
					tokensBefore: 1234,
					usage: { input: 10, output: 5 },
					details: { readFiles: [], modifiedFiles: [] },
				}
			);
		},
		resolveAuth: async () => ({ apiKey: "key", headers: {}, env: {} }),
		getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 30000 }),
	};
}

const modelFixture = () => ({ id: "m", provider: "p", api: "openai-completions", contextWindow: 200000, maxTokens: 68601, reasoning: true });

async function run(options: Record<string, unknown> = {}) {
	const captured: Capture[] = [];
	const args = {
		preparation: preparationFixture(),
		model: modelFixture(),
		signal: new AbortController().signal,
		thinkingLevel: "minimal",
		env: { HOME: "/root" },
		deps: fakeDeps(captured),
		...options,
	};
	const out = await summarizeMiddleSpan(args as never);
	return { captured, out, args };
}

test("hands customInstructions to the delegated summarizer verbatim", async () => {
	const { captured } = await run({ customInstructions: "focus on the migration bugs" });
	assert.equal(captured.length, 1, "exactly one delegated summarizer call");
	assert.equal(captured[0]!.customInstructions, "focus on the migration bugs");
});

test("passes no custom instructions when the event carried none", async () => {
	const { captured } = await run();
	assert.ok(
		captured[0]!.customInstructions === undefined || captured[0]!.customInstructions === null,
		"no instructions must be invented for automatic compaction",
	);
});

test("sends no output budget when maxTokens is unset", async () => {
	const { captured, args } = await run();
	const model = captured[0]!.model;
	assert.equal(model.maxTokens, 68601, "the model's own output limit governs");
	assert.equal(model, args.model, "the model is handed through untouched, not re-capped");
});

test("applies a configured maxTokens as an output budget via the model view", async () => {
	const { captured, args } = await run({ maxTokensCap: 4096 });
	assert.equal(captured[0]!.model.maxTokens, 4096);
	assert.equal((args.model as any).maxTokens, 68601, "the session model itself is not mutated");
});

test("feeds the stored middle summary, never the carried head, as previousSummary", async () => {
	const { captured } = await run({
		preparation: preparationFixture({ previousSummary: "<verbatim-conversation-start>HEAD</verbatim-conversation-start>\nold middle" }),
		prior: { priorMiddleSummary: "## Goal\nearlier middle only" },
	});
	const previous = captured[0]!.preparation.previousSummary;
	assert.equal(previous, "## Goal\nearlier middle only");
	assert.ok(!String(previous).includes("<verbatim-conversation-start>"), "head text must not reach the summarizer");
});

test("keeps a foreign previous summary when this extension has no marker", async () => {
	const { captured } = await run({
		preparation: preparationFixture({ previousSummary: "pi's own earlier summary" }),
	});
	assert.equal(captured[0]!.preparation.previousSummary, "pi's own earlier summary");
});

test("hands a split-turn preparation over untouched", async () => {
	const prefix = [{ role: "assistant", content: [{ type: "text", text: "prefix" }], timestamp: 0 }];
	const middle = [
		{ role: "user", content: [{ type: "text", text: "middle" }], timestamp: 0 },
		{ role: "assistant", content: [{ type: "text", text: "more" }], timestamp: 0 },
	];
	const { captured } = await run({
		preparation: preparationFixture({
			isSplitTurn: true,
			turnPrefixMessages: prefix,
			messagesToSummarize: middle,
		}),
	});
	const prep = captured[0]!.preparation;
	assert.equal(prep.isSplitTurn, true);
	assert.equal(prep.turnPrefixMessages.length, 1, "the turn prefix stays for the host to summarize");
	assert.deepEqual(
		prep.messagesToSummarize.map((m: any) => m.content[0]!.text),
		["middle", "more"],
		"the turn prefix is not folded into the middle span",
	);
});

test("unions prior cumulative file lists into the summarized span", async () => {
	const prep = preparationFixture({
		fileOps: { read: new Set(["b.ts"]), written: new Set(["c.ts"]), edited: new Set<string>() },
	});
	const { captured, out } = await run({
		preparation: prep,
		priorFileLists: { readFiles: ["a.ts", "b.ts"], modifiedFiles: ["z.ts"] },
	});
	const fileOps = captured[0]!.preparation.fileOps;
	assert.deepEqual([...fileOps.read].sort(), ["a.ts", "b.ts"]);
	assert.deepEqual([...fileOps.edited].sort(), ["c.ts", "z.ts"]);
	assert.deepEqual(out!.readFiles, ["a.ts", "b.ts"]);
	assert.deepEqual(out!.modifiedFiles, ["c.ts", "z.ts"]);
});

test("a version 1 marker carries no stored lists, so the span stands alone", async () => {
	const prep = preparationFixture({ fileOps: { read: new Set(["b.ts"]), written: new Set<string>(), edited: new Set(["a.ts"]) } });
	const { out } = await run({ preparation: prep });
	assert.deepEqual(out!.readFiles, ["b.ts"]);
	assert.deepEqual(out!.modifiedFiles, ["a.ts"]);
});

test("hands the host retry settings to the delegated call", async () => {
	const { captured } = await run();
	assert.deepEqual(captured[0]!.retry, {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: 30000,
	});
});

test("stands down when the delegated call throws (measured host failure path)", async () => {
	const captured: Capture[] = [];
	const deps = {
		...fakeDeps(captured),
		compact: async () => {
			throw new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
		},
	};
	const out = await summarizeMiddleSpan({
		preparation: preparationFixture(),
		model: modelFixture(),
		signal: new AbortController().signal,
		thinkingLevel: "minimal",
		env: {},
		deps,
	} as never);
	assert.equal(out, undefined, "a failed summarization stands down to default compaction");
});

test("retries belong to the host, so the extension calls the delegate once", async () => {
	let attempts = 0;
	const deps = {
		...fakeDeps([]),
		compact: async () => {
			attempts += 1;
			throw new Error("Summarization failed: terminated");
		},
	};
	const out = await summarizeMiddleSpan({
		preparation: preparationFixture(),
		model: modelFixture(),
		signal: new AbortController().signal,
		thinkingLevel: "minimal",
		env: {},
		deps,
	} as never);
	assert.equal(attempts, 1, "no second guess at retry on top of the host retry policy");
	assert.equal(out, undefined, "an exhausted delegated call stands down to default compaction");
});
