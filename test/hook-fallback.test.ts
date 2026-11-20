import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import extension, { setDelegationDepsFactoryForTests } from "../extensions/keep-head-compaction.ts";

type CompactHandler = (
	event: unknown,
	ctx: unknown,
) => Promise<
		| { compaction?: { summary: string; firstKeptEntryId: string; details?: unknown; usage?: unknown } }
		| undefined
	>;

/** Capture the registered handler from a stubbed extension host. */
function captureHandler(): CompactHandler {
	let handler: CompactHandler | undefined;
	extension({
		on: (name: string, fn: CompactHandler) => {
			if (name === "session_before_compact") handler = fn;
		},
	} as never);
	assert.ok(handler, "session_before_compact handler is registered");
	return handler;
}

/** Project config wins over the global one, so the host's real config cannot leak in. */
function projectWith(config: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-head-hook-"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "keep-head-compaction.json"), JSON.stringify(config));
	return dir;
}

function textMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function event(messages: unknown[] = [textMessage("x".repeat(400))]) {
	return {
		preparation: {
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			firstKeptEntryId: "kept-1",
			isSplitTurn: false,
			tokensBefore: 1234,
			fileOps: {},
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

/**
 * The extension now delegates middle summarization to the host's own compact(),
 * so the stub lives in the delegation deps: passing a summary text stands in for
 * the host summarizer, and passing none means the summarizer must never be called.
 */
function context(cwd: string, summary?: string) {
	const notified: string[] = [];
	const calls: any[] = [];
	setDelegationDepsFactoryForTests(() => ({
		compact: async (preparation: { firstKeptEntryId: string; tokensBefore: number }) => {
			calls.push(preparation);
			if (summary === undefined) throw new Error("summarizer must not be called");
			return {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: { input: 1, output: 1 },
			};
		},
		resolveAuth: async () => ({ apiKey: "test-key", headers: {} }),
		getRetrySettings: () => undefined,
	}));
	return {
		notified,
		calls,
		ctx: {
			cwd,
			model: { provider: "test", id: "test-model", contextWindow: 200000 },
			modelRegistry: { find: () => undefined },
			ui: { notify: (message: string) => notified.push(message) },
		},
	};
}

test("a zero head budget stands down to default compaction", async () => {
	const cwd = projectWith({ headTokens: 0, minMiddleTokens: 10 });
	const { ctx, notified } = context(cwd);
	assert.equal(await captureHandler()(event(), ctx), undefined);
	assert.deepEqual(notified, []);
});

test("a subagent with headTokens 0 stands down while the parent keeps its head", async () => {
	const cwd = projectWith({ headTokens: 100, minMiddleTokens: 10, subagent: { headTokens: 0 } });
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const { ctx } = context(cwd);
		assert.equal(await captureHandler()(event(), ctx), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
	const { ctx } = context(cwd, "MIDDLE SUMMARY");
	const result = await captureHandler()(
		event([textMessage("h".repeat(400)), textMessage("m".repeat(200))]),
		ctx,
	);
	assert.ok(result?.compaction, "the parent still compacts");
	assert.match(result.compaction.summary, /<verbatim-conversation-start>/);
	assert.match(result.compaction.summary, /## Compacted middle history/);
});

test("a zero head budget stands down even after an earlier head-keeping compaction", async () => {
	const priorEntry = {
		type: "compaction",
		id: "prior-compaction",
		details: {
			kind: "pi-keep-head-compaction",
			version: 1,
			headText: "OLD VERBATIM HEAD",
			priorMiddleSummary: "old middle",
		},
	};
	const cwd = projectWith({ headTokens: 0, minMiddleTokens: 10 });
	const { ctx, notified } = context(cwd);

	assert.equal(
		await captureHandler()(
			{ ...event([textMessage("m".repeat(200))]), branchEntries: [priorEntry] },
			ctx,
		),
		undefined,
	);
	assert.deepEqual(notified, [], "a stand-down never reaches the summarizer");

	const keptCwd = projectWith({ headTokens: 100, minMiddleTokens: 10 });
	const kept = context(keptCwd, "MIDDLE SUMMARY");
	const result = await captureHandler()(
		{ ...event([textMessage("m".repeat(200))]), branchEntries: [priorEntry] },
		kept.ctx,
	);
	assert.ok(result?.compaction);
	assert.match(result.compaction.summary, /OLD VERBATIM HEAD/);
});


test("the span handed to the host excludes the verbatim head and keeps the split-turn prefix", async () => {
	const cwd = projectWith({ headTokens: 1, minMiddleTokens: 10 });
	const { ctx, calls } = context(cwd, "MIDDLE SUMMARY");
	const prefix = { role: "assistant", content: [{ type: "text", text: "p".repeat(300) }], timestamp: 0 };
	const base = event([textMessage("h".repeat(400)), textMessage("m".repeat(300))]);
	const result = await captureHandler()(
		{
			...base,
			preparation: { ...base.preparation, isSplitTurn: true, turnPrefixMessages: [prefix] },
		},
		ctx,
	);
	assert.ok(result?.compaction, "a split-turn compaction is still produced");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].messagesToSummarize.length, 1, "only the middle span is summarized");
	assert.equal(calls[0].turnPrefixMessages.length, 1, "the prefix stays for the host's own path");
});

test("a second compaction re-emits the head unchanged and grows the cumulative file lists", async () => {
	const priorEntry = {
		type: "compaction",
		id: "prior-compaction",
		details: {
			kind: "pi-keep-head-compaction",
			version: 2,
			headText: "OLD VERBATIM HEAD",
			priorMiddleSummary: "old middle",
			readFiles: ["earlier.ts"],
			modifiedFiles: ["old-change.ts"],
		},
	};
	const cwd = projectWith({ headTokens: 100, minMiddleTokens: 10 });
	const { ctx, calls } = context(cwd, "NEW MIDDLE");
	const base = event([textMessage("m".repeat(300))]);
	const result = await captureHandler()(
		{
			...base,
			branchEntries: [priorEntry],
			preparation: {
				...base.preparation,
				fileOps: { read: new Set(["later.ts"]), written: new Set(["new-change.ts"]), edited: new Set() },
			},
		},
		ctx,
	);
	const details = result?.compaction?.details as Record<string, unknown>;
	assert.equal(details.headText, "OLD VERBATIM HEAD", "the head is re-emitted byte-identically");
	assert.equal(details.version, 2);
	assert.deepEqual(details.readFiles, ["earlier.ts", "later.ts"]);
	assert.deepEqual(details.modifiedFiles, ["new-change.ts", "old-change.ts"]);
	assert.deepEqual([...calls[0].fileOps.read].sort(), ["earlier.ts", "later.ts"]);
	assert.deepEqual([...calls[0].fileOps.edited].sort(), ["new-change.ts", "old-change.ts"]);
});

test("a version 1 marker still carries the head, with file lists from the current span only", async () => {
	const priorEntry = {
		type: "compaction",
		id: "v1-compaction",
		details: { kind: "pi-keep-head-compaction", version: 1, headText: "V1 HEAD", priorMiddleSummary: "v1 middle" },
	};
	const cwd = projectWith({ headTokens: 100, minMiddleTokens: 10 });
	const { ctx } = context(cwd, "NEW MIDDLE");
	const base = event([textMessage("m".repeat(300))]);
	const result = await captureHandler()(
		{
			...base,
			branchEntries: [priorEntry],
			preparation: {
				...base.preparation,
				fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set(["b.ts"]) },
			},
		},
		ctx,
	);
	const details = result?.compaction?.details as Record<string, unknown>;
	assert.equal(details.headText, "V1 HEAD");
	assert.equal(details.version, 2, "the new entry is written at version 2");
	assert.deepEqual(details.readFiles, ["a.ts"]);
	assert.deepEqual(details.modifiedFiles, ["b.ts"]);
});

test("manual /compact instructions survive this extension", async () => {
	const cwd = projectWith({ headTokens: 100, minMiddleTokens: 10 });
	const { ctx } = context(cwd);
	const seen: unknown[] = [];
	setDelegationDepsFactoryForTests(() => ({
		compact: async (preparation: unknown, _model: unknown, _key: unknown, _headers: unknown, instructions: unknown) => {
			seen.push(instructions);
			return { summary: "MIDDLE", firstKeptEntryId: "kept-1", tokensBefore: 1 };
		},
		resolveAuth: async () => ({ apiKey: "k", headers: {} }),
		getRetrySettings: () => undefined,
	}));
	const result = await captureHandler()(
		{ ...event([textMessage("h".repeat(400)), textMessage("m".repeat(300))]), customInstructions: "focus on migrations" },
		ctx,
	);
	assert.ok(result?.compaction);
	assert.deepEqual(seen, ["focus on migrations"]);
});


test("the host's split-turn separator survives into the emitted summary", async () => {
	const cwd = projectWith({ headTokens: 100, minMiddleTokens: 10 });
	const { ctx } = context(cwd);
	setDelegationDepsFactoryForTests(() => ({
		compact: async (preparation: { firstKeptEntryId: string }) => ({
			summary:
				"## Goal\nmiddle\n\n---\n\n**Turn Context (split turn):**\n\nprefix summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
		}),
		resolveAuth: async () => ({ apiKey: "k", headers: {} }),
		getRetrySettings: () => undefined,
	}));
	const base = event([textMessage("h".repeat(400)), textMessage("m".repeat(300))]);
	const prefix = { role: "assistant", content: [{ type: "text", text: "p".repeat(300) }], timestamp: 0 };
	const result = await captureHandler()(
		{ ...base, preparation: { ...base.preparation, isSplitTurn: true, turnPrefixMessages: [prefix] } },
		ctx,
	);
	assert.match(result!.compaction!.summary, /\*\*Turn Context \(split turn\):\*\*/);
	assert.match(result!.compaction!.summary, /<verbatim-conversation-start>/);
});

afterEach(() => setDelegationDepsFactoryForTests());
