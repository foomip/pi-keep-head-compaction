import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import extension from "../extensions/keep-head-compaction.ts";

type CompactHandler = (
	event: unknown,
	ctx: unknown,
) => Promise<{ compaction?: { summary: string; firstKeptEntryId: string } } | undefined>;

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

function context(cwd: string, complete?: () => unknown) {
	const notified: string[] = [];
	return {
		notified,
		ctx: {
			cwd,
			model: { provider: "test", id: "test-model", contextWindow: 200000 },
			modelRegistry: {
				find: () => undefined,
				complete:
					complete ??
					(async () => {
						throw new Error("summarizer must not be called");
					}),
			},
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
	const { ctx } = context(cwd, () => ({
		content: [{ type: "text", text: "MIDDLE SUMMARY" }],
		usage: {},
	}));
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
	const kept = context(keptCwd, () => ({
		content: [{ type: "text", text: "MIDDLE SUMMARY" }],
		usage: {},
	}));
	const result = await captureHandler()(
		{ ...event([textMessage("m".repeat(200))]), branchEntries: [priorEntry] },
		kept.ctx,
	);
	assert.ok(result?.compaction);
	assert.match(result.compaction.summary, /OLD VERBATIM HEAD/);
});
