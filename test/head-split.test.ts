import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { formatCompactionNotice, splitHead } from "../extensions/keep-head-compaction.ts";

/** Eight characters of text = 2 estimated tokens (chars/4 heuristic). */
function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function span(count: number) {
	return Array.from({ length: count }, (_, i) => userMessage(`msg-000${i}`));
}

test("a span smaller than the head budget is preserved whole", () => {
	const messages = span(5);
	const { head, middle } = splitHead(messages, 100);
	assert.equal(head.length, 5);
	assert.equal(middle.length, 0);
});

test("an empty span yields empty head and middle", () => {
	const { head, middle } = splitHead([], 22000);
	assert.equal(head.length, 0);
	assert.equal(middle.length, 0);
});

test("a zero head budget preserves no messages", () => {
	const messages = span(5);
	const { head, middle } = splitHead(messages, 0);
	assert.equal(head.length, 0);
	assert.equal(middle.length, 5);
});

test("the head cuts at the first message that crosses the budget", () => {
	const messages = span(5);
	const { head, middle } = splitHead(messages, 4);
	assert.equal(head.length, 2);
	assert.equal(middle.length, 3);
});

test("a span exactly equal to the head budget is preserved whole", () => {
	const messages = span(5);
	const total = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
	assert.equal(total, 10);
	const { head, middle } = splitHead(messages, total);
	assert.equal(head.length, 5);
	assert.equal(middle.length, 0);
});

test("a freshly carved head notice names the message count", () => {
	assert.equal(
		formatCompactionNotice({
			role: "parent",
			headTokens: 22000,
			tailTokens: 18000,
			headMessages: 28,
			middleCount: 63,
		}),
		"keep-head-compaction: parent profile: 22000h/18000t — preserving head=28 messages + tail=18000t verbatim, summarizing 63 middle messages",
	);
});

test("a carried head notice names the retained size, not zero messages", () => {
	const notice = formatCompactionNotice({
		role: "parent",
		headTokens: 22000,
		tailTokens: 18000,
		headMessages: 0,
		retainedHeadChars: 58053,
		middleCount: 130,
	});
	assert.equal(
		notice,
		"keep-head-compaction: parent profile: 22000h/18000t — preserving head=58053 chars carried from the earlier compaction + tail=18000t verbatim, summarizing 130 middle messages",
	);
	assert.doesNotMatch(notice, /preserving 0 head/);
});

test("the notice names the resolved role and budgets", () => {
	const notice = formatCompactionNotice({
		role: "subagent",
		headTokens: 12000,
		tailTokens: 2000,
		headMessages: 6,
		middleCount: 12,
	});
	assert.match(notice, /^keep-head-compaction: subagent profile: 12000h\/2000t — /);
});
