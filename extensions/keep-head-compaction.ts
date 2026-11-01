/**
 * pi-keep-head-compaction
 *
 * Custom compaction for the Pi coding agent that preserves BOTH ends of the
 * conversation when compaction fires:
 *
 *   - the first `headTokens` tokens of the session, verbatim, and
 *   - the last `tailTokens` tokens, verbatim (pi's kept tail, re-cut with
 *     pi's own cut-point logic when it differs from the session setting).
 *
 * If the model's context window cannot fit head + tail + reserve, both
 * budgets are scaled down proportionally while keeping their ratio.
 *
 * Only the middle span is summarized. The head is carried verbatim inside the
 * compaction entry's summary text (pi's cut-point model has a single
 * retention boundary, so this is the only way to retain both ends), and is
 * re-emitted unchanged on every subsequent compaction via the entry's
 * `details` field — repeated compactions never re-summarize or duplicate it.
 *
 * Configuration (optional), project overrides global, env overrides the head budget:
 *   - project:  <project>/.pi/keep-head-compaction.json
 *   - global:   ~/.pi/agent/keep-head-compaction.json
 *   - env:      PI_KEEP_HEAD_TOKENS=20000
 *
 * Config keys:
 *   - headTokens:       tokens of session start preserved verbatim (default 20000;
 *                       legacy alias: keepHeadTokens)
 *   - tailTokens:       tokens of session end preserved verbatim (default 20000;
 *                       overrides compaction.keepRecentTokens when they differ)
 *   - model:            summarizer override as "provider/model-id" (default: the
 *                       model the session is currently using)
 *   - maxTokens:        output budget for the middle summary (default 8192)
 *   - minMiddleTokens:  stand down and let default compaction run when the middle
 *                       span is smaller than this (default 500)
 *   - subagent:         optional object with any subset of the keys above;
 *                       shallow-merged over the base config only in sessions
 *                       hosted by a subagent runner (PI_SUBAGENT_CHILD=1)
 *
 * PI_KEEP_HEAD_TOKENS overrides the resolved head budget for both roles.
 *
 * When head + tail + reserveTokens exceed the model's context window, both
 * budgets are scaled down proportionally (same head:tail ratio) to fit; an
 * unknown context window uses the configured values as-is.
 *
 * If the span to summarize is too small to leave a meaningful middle (no
 * compression would happen), the extension stands down and pi's default
 * compaction runs instead.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	estimateTokens,
	findCutPoint,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// Host types not re-exported from the package root; derive them from the API surface.
type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type SessionEntry = Parameters<typeof findCutPoint>[0][number];

interface FileOpsLike {
	read?: Iterable<string>;
	written?: Iterable<string>;
	edited?: Iterable<string>;
}

const DETAILS_KIND = "pi-keep-head-compaction";
const DETAILS_VERSION = 1;
const DEFAULT_KEEP_HEAD_TOKENS = 20000;
/** Below this much middle content, stand down and let default compaction run. */
const MIN_MIDDLE_TOKENS = 500;

interface RoleOverrides {
	headTokens?: number;
	tailTokens?: number;
	model?: string;
	maxTokens?: number;
	minMiddleTokens?: number;
}

interface ExtensionConfig {
	headTokens: number;
	tailTokens: number;
	model?: string;
	maxTokens: number;
	minMiddleTokens: number;
	subagent?: RoleOverrides;
}

type SessionRole = "parent" | "subagent";
type ConfigEnv = Record<string, string | undefined>;

function parseNonNegativeInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
}

function parseModelOverride(value: unknown): string | undefined {
	return typeof value === "string" && value.includes("/") ? value : undefined;
}

/** Parse the nested `subagent` block; invalid values degrade to absent. */
function parseRoleOverrides(value: unknown): RoleOverrides | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const overrides: RoleOverrides = {};
	const headTokens = parseNonNegativeInteger(raw.headTokens);
	if (headTokens !== undefined) overrides.headTokens = headTokens;
	const tailTokens = parseNonNegativeInteger(raw.tailTokens);
	if (tailTokens !== undefined) overrides.tailTokens = tailTokens;
	const model = parseModelOverride(raw.model);
	if (model !== undefined) overrides.model = model;
	const maxTokens = parseNonNegativeInteger(raw.maxTokens);
	if (maxTokens !== undefined) overrides.maxTokens = maxTokens;
	const minMiddleTokens = parseNonNegativeInteger(raw.minMiddleTokens);
	if (minMiddleTokens !== undefined) overrides.minMiddleTokens = minMiddleTokens;
	return overrides;
}

/** Validate one raw config object (already merged across config layers). */
export function parseConfigObject(raw: unknown): ExtensionConfig {
	const merged =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? (raw as Record<string, unknown> & { keepHeadTokens?: unknown })
			: {};
	const subagent = parseRoleOverrides(merged.subagent);
	return {
		headTokens:
			parseNonNegativeInteger(merged.headTokens) ??
			parseNonNegativeInteger(merged.keepHeadTokens) ??
			DEFAULT_KEEP_HEAD_TOKENS,
		tailTokens: parseNonNegativeInteger(merged.tailTokens) ?? DEFAULT_KEEP_HEAD_TOKENS,
		model: parseModelOverride(merged.model),
		maxTokens: parseNonNegativeInteger(merged.maxTokens) ?? 8192,
		minMiddleTokens: parseNonNegativeInteger(merged.minMiddleTokens) ?? MIN_MIDDLE_TOKENS,
		...(subagent !== undefined ? { subagent } : {}),
	};
}

/** The only role signal: a runner-hosted child process (never session lineage). */
export function detectSessionRole(env: ConfigEnv = process.env): SessionRole {
	return env.PI_SUBAGENT_CHILD === "1" ? "subagent" : "parent";
}

/** Shallow-merge the role block over the base config, then apply the env override. */
export function resolveRoleConfig(
	config: ExtensionConfig,
	role: SessionRole,
	env: ConfigEnv = process.env,
): ExtensionConfig {
	const overrides = role === "subagent" ? config.subagent : undefined;
	const merged = {
		headTokens: overrides?.headTokens ?? config.headTokens,
		tailTokens: overrides?.tailTokens ?? config.tailTokens,
		model: overrides?.model ?? config.model,
		maxTokens: overrides?.maxTokens ?? config.maxTokens,
		minMiddleTokens: overrides?.minMiddleTokens ?? config.minMiddleTokens,
	};
	const envRaw = env.PI_KEEP_HEAD_TOKENS;
	const envValue = envRaw !== undefined ? Number.parseInt(envRaw, 10) : Number.NaN;
	const headTokens =
		Number.isSafeInteger(envValue) && envValue >= 0 ? envValue : merged.headTokens;
	return { ...merged, headTokens };
}

interface MarkerDetails {
	kind: string;
	version: number;
	headText: string;
	priorMiddleSummary: string;
}

function readJsonConfig(configPath: string): Record<string, unknown> {
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Project config wins over global, including nested `subagent` keys. */
export function loadConfig(cwd: string, env: ConfigEnv = process.env): ExtensionConfig {
	const project = readJsonConfig(path.join(cwd, ".pi", "keep-head-compaction.json"));
	const home = readJsonConfig(
		path.join(env.HOME ?? "", ".pi", "agent", "keep-head-compaction.json"),
	);
	const merged: Record<string, unknown> = { ...home, ...project };
	const homeSubagent = home.subagent;
	const projectSubagent = project.subagent;
	if (homeSubagent !== undefined || projectSubagent !== undefined) {
		merged.subagent = {
			...(typeof homeSubagent === "object" &&
			homeSubagent !== null &&
			!Array.isArray(homeSubagent)
				? homeSubagent
				: {}),
			...(typeof projectSubagent === "object" &&
			projectSubagent !== null &&
			!Array.isArray(projectSubagent)
				? projectSubagent
				: {}),
		};
	}
	return parseConfigObject(merged);
}

/**
 * Shrink head/tail proportionally when both cannot fit alongside the response
 * reserve. Unknown or zero context window uses the requested values as-is.
 */
function scaleBudgets(
	headTokens: number,
	tailTokens: number,
	contextWindow: number,
	reserveTokens: number,
): { headTokens: number; tailTokens: number } {
	if (!contextWindow || contextWindow <= 0) return { headTokens, tailTokens };
	const available = contextWindow - Math.max(0, reserveTokens);
	if (headTokens + tailTokens <= available) return { headTokens, tailTokens };
	if (available <= 0) return { headTokens: 0, tailTokens: 0 };
	const ratio = headTokens / (headTokens + tailTokens);
	const scaledHead = Math.floor(available * ratio);
	return { headTokens: scaledHead, tailTokens: available - scaledHead };
}

/**
 * Split leading messages into a verbatim head of ~keepHeadTokens tokens.
 *
 * The head ends at the message that crosses the budget. A span that never
 * crosses the budget is the entire head (empty middle), and a zero budget
 * preserves nothing — both are deliberate outcomes, never silent head loss.
 */
export function splitHead(
	messages: AgentMessage[],
	keepHeadTokens: number,
): { head: AgentMessage[]; middle: AgentMessage[] } {
	if (!Number.isFinite(keepHeadTokens) || keepHeadTokens <= 0) {
		return { head: [], middle: [...messages] };
	}
	let headTokens = 0;
	let cut = 0;
	for (const message of messages) {
		headTokens += estimateTokens(message);
		cut += 1;
		if (headTokens >= keepHeadTokens) break;
	}
	return { head: messages.slice(0, cut), middle: messages.slice(cut) };
}

export interface CompactionNotice {
	role: SessionRole;
	headTokens: number;
	tailTokens: number;
	/** Messages newly carved as head in this run; 0 when the head is carried. */
	headMessages: number;
	/** Size of the head text re-emitted unchanged from an earlier compaction entry. */
	retainedHeadChars?: number;
	middleCount: number;
}

/** One line naming exactly what was kept verbatim and what was summarized. */
export function formatCompactionNotice(notice: CompactionNotice): string {
	const head =
		notice.retainedHeadChars !== undefined
			? `head=${notice.retainedHeadChars} chars carried from the earlier compaction`
			: `head=${notice.headMessages} messages`;
	return `keep-head-compaction: ${notice.role} profile: ${notice.headTokens}h/${notice.tailTokens}t — preserving ${head} + tail=${notice.tailTokens}t verbatim, summarizing ${notice.middleCount} middle messages`;
}

/** Find the most recent compaction entry produced by this extension. */
function findPriorMarker(branchEntries: SessionEntry[]): MarkerDetails | undefined {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i] as { type?: string; details?: unknown };
		if (entry.type !== "compaction" || entry.details === undefined) continue;
		const details = entry.details as Partial<MarkerDetails>;
		if (details.kind === DETAILS_KIND && typeof details.headText === "string") {
			return {
				kind: DETAILS_KIND,
				version: DETAILS_VERSION,
				headText: details.headText,
				priorMiddleSummary:
					typeof details.priorMiddleSummary === "string" ? details.priorMiddleSummary : "",
			};
		}
	}
	return undefined;
}

function entryId(entry: SessionEntry | undefined): string {
	return (entry as { id?: string } | undefined)?.id ?? "";
}

function entryMessage(entry: SessionEntry): AgentMessage | undefined {
	return entry.type === "message" ? entry.message : undefined;
}

function messagesBetween(entries: SessionEntry[], from: number, to: number): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = from; i < to && i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) break;
		const message = entryMessage(entry);
		if (message) out.push(message);
	}
	return out;
}

function countMessageEntries(entries: SessionEntry[], from: number, to: number): number {
	let count = 0;
	for (let i = from; i < to && i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) break;
		if (entryMessage(entry)) count++;
	}
	return count;
}

function buildSummaryPrompt(
	middleText: string,
	priorMiddleSummary: string,
	foreignPreviousSummary: string | undefined,
	fileOps: FileOpsLike,
): string {
	const priorState = priorMiddleSummary
		? `An earlier compaction already produced the summary below. Merge it with the new conversation span: keep everything still relevant from it, and update it with the new span.\n\n<earlier-summary>\n${priorMiddleSummary}\n</earlier-summary>\n\n`
		: foreignPreviousSummary
			? `A previous compaction summary of the session follows. Merge it with the new conversation span below.\n\n<previous-summary>\n${foreignPreviousSummary}\n</previous-summary>\n\n`
			: "";
	const modified = [...new Set([...(fileOps.edited ?? []), ...(fileOps.written ?? [])])].sort();
	const readFiles = [...new Set(fileOps.read ?? [])].sort();
	const files =
		readFiles.length + modified.length > 0
			? `\nFiles read during this span:\n${readFiles.join("\n")}\n\nFiles modified during this span:\n${modified.join("\n")}\n`
			: "";
	return `You are a conversation summarizer for a coding agent. Summarize the middle span of a long session. The beginning and end of the session are preserved verbatim elsewhere, so focus ONLY on the span below.

Capture:
1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Format the summary as structured markdown with sections: Goal, Constraints & Preferences, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical Context.${files}
${priorState}<conversation-span>
${middleText}
</conversation-span>`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, signal } = event;
		const role = detectSessionRole();
		const config = resolveRoleConfig(loadConfig(ctx.cwd), role);

		// Window-aware head/tail budgets; scaled down proportionally when both
		// cannot fit alongside the response reserve.
		const { headTokens, tailTokens } = scaleBudgets(
			config.headTokens,
			config.tailTokens,
			ctx.model?.contextWindow ?? 0,
			preparation.settings.reserveTokens,
		);

		// Documented opt-out: a zero head budget keeps no head, so hand back to
		// pi's default compaction instead of summarizing a headless span.
		if (headTokens <= 0) return undefined;

		// tailTokens overrides pi's compaction.keepRecentTokens: re-cut the tail
		// with pi's own cut-point logic and adjust the summarized span accordingly.
		let prep = preparation;
		if (tailTokens !== preparation.settings.keepRecentTokens && !preparation.isSplitTurn) {
			const piCutIndex = branchEntries.findIndex((e) => e.id === preparation.firstKeptEntryId);
			if (piCutIndex >= 0) {
				const cut = findCutPoint(branchEntries, 0, branchEntries.length, tailTokens);
				if (cut.firstKeptEntryIndex > piCutIndex) {
					// Smaller tail than pi's: extend the summarized span with the
					// messages pi would have kept.
					prep = {
						...preparation,
						messagesToSummarize: [
							...preparation.messagesToSummarize,
							...messagesBetween(branchEntries, piCutIndex, cut.firstKeptEntryIndex),
						],
						firstKeptEntryId: entryId(branchEntries[cut.firstKeptEntryIndex]),
					};
				} else if (cut.firstKeptEntryIndex < piCutIndex) {
					// Bigger tail than pi's: keep more, drop the trailing span messages.
					const drop = countMessageEntries(
						branchEntries,
						cut.firstKeptEntryIndex,
						piCutIndex,
					);
					prep = {
						...preparation,
						messagesToSummarize: preparation.messagesToSummarize.slice(
							0,
							Math.max(0, preparation.messagesToSummarize.length - drop),
						),
						firstKeptEntryId: entryId(branchEntries[cut.firstKeptEntryIndex]),
					};
				}
			}
		}

		const prior = findPriorMarker(branchEntries);
		const { head, middle } = prior
			? { head: [], middle: [...prep.messagesToSummarize] }
			: splitHead(prep.messagesToSummarize, headTokens);

		// Split-span prefix messages belong to the summarized middle.
		const middleAll = [...middle, ...prep.turnPrefixMessages];
		if (head.length === 0 && middleAll.length === 0) return undefined;
		if (head.length === 0 && prior === undefined) return undefined; // nothing worth keeping verbatim
		if (
			prior === undefined &&
			middleAll.reduce((sum, m) => sum + estimateTokens(m), 0) < config.minMiddleTokens
		) {
			return undefined; // too little middle to compress; default compaction is a better fit
		}

		const headText = prior ? prior.headText : serializeConversation(convertToLlm(head));
		const middleText = serializeConversation(convertToLlm(middleAll));
		if (!middleText.trim() && prior === undefined) return undefined;

		// Summarizer: config.model override ("provider/model-id") or the session's current model.
		let model = ctx.model;
		if (config.model) {
			const slash = config.model.indexOf("/");
			model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
			if (!model) {
				ctx.ui.notify(
					`keep-head-compaction: model "${config.model}" not found, using session model`,
					"warning",
				);
				model = ctx.model;
			}
		}
		if (!model) {
			ctx.ui.notify("keep-head-compaction: no active model, using default compaction", "warning");
			return undefined;
		}

		ctx.ui.notify(
			formatCompactionNotice({
				role,
				headTokens,
				tailTokens,
				headMessages: head.length,
				...(prior ? { retainedHeadChars: headText.length } : {}),
				middleCount: middleAll.length,
			}),
			"info",
		);

		try {
			const prompt = buildSummaryPrompt(
				middleText || "(no new messages in this span)",
				prior?.priorMiddleSummary ?? "",
				prior === undefined ? prep.previousSummary : undefined,
				prep.fileOps,
			);
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: config.maxTokens, signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			const middleSummary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (!middleSummary.trim()) {
				if (!signal.aborted) {
					ctx.ui.notify("keep-head-compaction: empty summary, using default compaction", "warning");
				}
				return undefined;
			}

			const summary = [
				"<verbatim-conversation-start>",
				"The following is the beginning of this session, preserved exactly as it happened:",
				headText,
				"</verbatim-conversation-start>",
				"",
				"## Compacted middle history",
				middleSummary,
			].join("\n");

			return {
				compaction: {
					summary,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
					usage: response.usage,
					details: {
						kind: DETAILS_KIND,
						version: DETAILS_VERSION,
						headText,
						priorMiddleSummary: middleSummary,
					} satisfies MarkerDetails,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`keep-head-compaction failed: ${message} — using default compaction`, "error");
			return undefined;
		}
	});
}
