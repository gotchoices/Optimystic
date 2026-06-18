/**
 * Reactivity — Resume RPC: classification, serving, and subscriber-side apply
 * (`docs/reactivity.md` §Resume, §Parent checkpoint summaries, §Wire formats Resume).
 *
 * A subscriber waking from sleep sends one {@link ResumeV1} to its cached primary (or any cohort member).
 * The serving cohort classifies the request against its **stacked** recovery windows — the `W`-deep replay
 * ring sits on top of the `W_checkpoint`-span parent checkpoint immediately below it, so a single round
 * trip recovers `W + W_checkpoint` revisions — and answers with one of four {@link ResumeReplyV1} variants
 * (`docs/reactivity.md` §Replay window, the authoritative stacked semantics):
 *
 *  - **Backfill** — `fromRevision` is within the replay ring (`fromRevision ≥ ringLow`). Returns the
 *    `[fromRevision, currentRevision]` slice + `currentRevision`. One RT.
 *  - **CheckpointWindow** — `fromRevision` is below the ring but within the parent checkpoint span
 *    (`chain low ≤ fromRevision < ringLow`). Returns an ordered, contiguous **chain** of
 *    {@link CheckpointSummary}s (`checkpoints`, low→high) + the ring's `recentEntries`. The subscriber
 *    verifies every link's endpoints, applies each link's merged digest, advances its contiguity head past
 *    the whole chain, then replays the recent entries deduped against `lastRevision`. One RT. The chain is a
 *    single link in steady state; a new tail that took over across a rotation serves a **two-link**
 *    `[inherited, rolling]` chain when a `fromRevision` below both the ring and the rolling checkpoint falls
 *    inside the inherited handoff window — so the full stacked range recovers in one reply regardless of
 *    where the new tail's own rolling checkpoint has formed (`docs/reactivity.md` §Tail rotation step 5 —
 *    "the new tail holds the old checkpoint").
 *  - **OutOfWindow** — older than even the checkpoint. Returns `currentTailId` + `currentRevision`; the
 *    subscriber falls back to a chain read, then a fresh subscribe.
 *  - **TailRotated** — the request's `latestKnownTailId` does not match the cohort's current tail (the
 *    subscriber slept across a rotation). Returns `newTailId` + `newRevisionAtRotation`; the subscriber
 *    re-registers under the new tail. This is checked **first**: a stale tail means the whole tree moved,
 *    so the lag-against-windows classification is moot. The rotation *lifecycle* is owned by
 *    [reactivity-rotation-backpressure-policy]; this module only **detects** the stale tail and emits the
 *    reply so resume composes with rotation.
 *
 * Wire conventions match the rest of reactivity: JSON, byte fields base64url, unix-ms timestamps, `v: 1`,
 * per-message structural validation on decode. `ResumeV1` is signed by the subscriber's peer key
 * (`signature`); replay protection rides the request envelope as elsewhere in the substrate.
 */

import {
	decodeCohortMessage,
	encodeCohortMessage,
	DEFAULT_MAX_MESSAGE_BYTES,
} from "../cohort-topic/wire/codec.js";
import {
	asObject,
	b64urlField,
	failWire,
	reqFiniteNumber,
	reqIntInRange,
	reqString,
	requireV1,
} from "./wire-validate.js";
import { validateCheckpointSummary, verifyCheckpointEndpoints, type CheckpointSummary, type RollingCheckpoint } from "./checkpoint.js";
import { checkpointCovers } from "./rotation.js";
import type { ReplayBuffer } from "./replay-buffer.js";
import type { ReactivitySubscriber } from "./subscriber.js";
import type { NotificationVerifier } from "./verify.js";
import { validateNotificationArray, type NotificationV1 } from "./wire.js";

/** The four resume classifications (`docs/reactivity.md` §Resume). */
export type ResumeResult = "backfill" | "checkpoint_window" | "out_of_window" | "tail_rotated";

/** A subscriber's resume request after waking from sleep. */
export interface ResumeV1 {
	v: 1;
	/** Collection id, base64url. */
	collectionId: string;
	/** First revision the subscriber still needs (`lastRevision + 1`). */
	fromRevision: number;
	/** Tail block id the subscriber believes is current, base64url (the stale-tail detector). */
	latestKnownTailId: string;
	/** The subscriber's ring coordinate, base64url (for the cohort to route the reply). */
	subscriberCoord: string;
	/** Unix ms. */
	timestamp: number;
	/** Subscriber peer-key signature over the request. */
	signature: string;
}

/** The cohort's classified reply. Fields are populated per the `result` discriminant. */
export interface ResumeReplyV1 {
	v: 1;
	result: ResumeResult;
	// --- backfill ---
	/** The `[fromRevision, currentRevision]` slice held in the replay ring (backfill). */
	entries?: NotificationV1[];
	/** Highest committed revision the serving cohort knows (backfill / checkpoint_window / out_of_window). */
	currentRevision?: number;
	// --- checkpoint_window ---
	/**
	 * The parent-checkpoint chain spanning `[chain[0].fromRevision, ringLow − 1]` (checkpoint_window), ordered
	 * low→high and **contiguous**: each `checkpoints[i].fromRevision === checkpoints[i-1].toRevision + 1`. A
	 * single link in steady state; a cross-rotation resume carries the two-link `[inherited, rolling]` bridge.
	 * The subscriber verifies and applies every link in sequence (see {@link applyResumeReply}).
	 */
	checkpoints?: CheckpointSummary[];
	/** The replay ring's entries, replayed deduped against `lastRevision` after the digests apply. */
	recentEntries?: NotificationV1[];
	// --- out_of_window ---
	/** Current tail block id, base64url — the subscriber re-subscribes after a chain read (out_of_window). */
	currentTailId?: string;
	// --- tail_rotated ---
	/** New tail block id the topic rotated to, base64url (tail_rotated). */
	newTailId?: string;
	/** Revision at which the rotation took effect (tail_rotated). */
	newRevisionAtRotation?: number;
}

// --- validation ---

/** Narrow an already-parsed value to {@link ResumeV1}, throwing on any defect. */
export function validateResumeV1(value: unknown): ResumeV1 {
	const what = "ResumeV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	return {
		v: 1,
		collectionId: b64urlField(reqString(obj, "collectionId", what), "collectionId", what),
		fromRevision: reqIntInRange(obj, "fromRevision", what, 0),
		latestKnownTailId: b64urlField(reqString(obj, "latestKnownTailId", what), "latestKnownTailId", what),
		subscriberCoord: b64urlField(reqString(obj, "subscriberCoord", what), "subscriberCoord", what),
		timestamp: reqFiniteNumber(obj, "timestamp", what),
		signature: b64urlField(reqString(obj, "signature", what), "signature", what),
	};
}

/** Narrow an already-parsed value to {@link ResumeReplyV1}, throwing on any defect. */
export function validateResumeReplyV1(value: unknown): ResumeReplyV1 {
	const what = "ResumeReplyV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	const result = obj["result"];
	if (result !== "backfill" && result !== "checkpoint_window" && result !== "out_of_window" && result !== "tail_rotated") {
		failWire(`${what}: field "result" must be one of backfill|checkpoint_window|out_of_window|tail_rotated`);
	}
	const out: ResumeReplyV1 = { v: 1, result };
	switch (result) {
		case "backfill": {
			out.entries = validateNotificationArray(obj["entries"], what);
			out.currentRevision = reqIntInRange(obj, "currentRevision", what, 0);
			break;
		}
		case "checkpoint_window": {
			out.checkpoints = validateCheckpointChain(obj["checkpoints"], `${what}.checkpoints`);
			out.recentEntries = validateNotificationArray(obj["recentEntries"], what);
			if (obj["currentRevision"] !== undefined) {
				out.currentRevision = reqIntInRange(obj, "currentRevision", what, 0);
			}
			break;
		}
		case "out_of_window": {
			out.currentTailId = b64urlField(reqString(obj, "currentTailId", what), "currentTailId", what);
			out.currentRevision = reqIntInRange(obj, "currentRevision", what, 0);
			break;
		}
		case "tail_rotated": {
			out.newTailId = b64urlField(reqString(obj, "newTailId", what), "newTailId", what);
			out.newRevisionAtRotation = reqIntInRange(obj, "newRevisionAtRotation", what, 0);
			break;
		}
	}
	return out;
}

/**
 * Validate a `checkpoint_window` reply's checkpoint chain: a **non-empty**, **ascending**, internally
 * **contiguous** list of {@link CheckpointSummary}s sharing one `collectionId`. Each link is validated via
 * {@link validateCheckpointSummary}, and for `i ≥ 1` the chain must satisfy
 * `checkpoints[i].fromRevision === checkpoints[i-1].toRevision + 1` (a gapped, overlapping, or misordered
 * chain is rejected). Runs on decode, so a malformed chain never reaches {@link applyResumeReply} over the
 * wire.
 */
function validateCheckpointChain(value: unknown, what: string): CheckpointSummary[] {
	if (!Array.isArray(value) || value.length === 0) {
		failWire(`${what}: must be a non-empty array of checkpoint summaries`);
	}
	const chain = value.map((el, i) => validateCheckpointSummary(el, `${what}[${i}]`));
	for (let i = 0; i < chain.length; i++) {
		if (chain[i]!.collectionId !== chain[0]!.collectionId) {
			failWire(`${what}: all checkpoints must share one collectionId`);
		}
		if (i >= 1 && chain[i]!.fromRevision !== chain[i - 1]!.toRevision + 1) {
			failWire(`${what}: chain must be ascending and contiguous (checkpoints[${i}].fromRevision must equal checkpoints[${i - 1}].toRevision + 1)`);
		}
	}
	return chain;
}

// --- canonical signing payload ---

const utf8 = new TextEncoder();

/** A {@link ResumeV1} minus its `signature` — the canonical bytes the subscriber peer-key-signs. */
export type ResumeSignable = Omit<ResumeV1, "signature">;

/**
 * Canonical signed byte image of a {@link ResumeV1} (every field except `signature`). Mirrors
 * {@link import("./backfill.js").backfillSigningPayload}: an explicitly-ordered, type-tagged JSON array
 * encoded as UTF-8. The `"ResumeV1"` tag means a resume image can never collide with the `"BackfillV1"`
 * image. `subscriberCoord` is part of the image, so a verifier recomputes over whatever coordinate the
 * request carries — the field order is the byte-for-byte contract between signer and verifier.
 */
export function resumeSigningPayload(body: ResumeSignable): Uint8Array {
	return utf8.encode(JSON.stringify([
		"ResumeV1",
		body.v,
		body.collectionId,
		body.fromRevision,
		body.latestKnownTailId,
		body.subscriberCoord,
		body.timestamp,
	]));
}

// --- codecs (length-framed JSON, mirroring the rest of reactivity) ---

/** Encode a {@link ResumeV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeResumeV1(msg: ResumeV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateResumeV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link ResumeV1} frame. */
export function decodeResumeV1(bytes: Uint8Array, maxMessageBytes?: number): ResumeV1 {
	return validateResumeV1(decodeCohortMessage(bytes, maxMessageBytes));
}

/** Encode a {@link ResumeReplyV1} as a length-prefixed UTF-8 JSON frame. */
export function encodeResumeReplyV1(msg: ResumeReplyV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validateResumeReplyV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link ResumeReplyV1} frame. */
export function decodeResumeReplyV1(bytes: Uint8Array, maxMessageBytes?: number): ResumeReplyV1 {
	return validateResumeReplyV1(decodeCohortMessage(bytes, maxMessageBytes));
}

// --- serving-cohort classification ---

/** The rolling checkpoint's summary; non-undefined because the caller already proved it abuts the ring (so non-empty). */
function requireRollingSummary(rolling: RollingCheckpoint): CheckpointSummary {
	const summary = rolling.summary();
	if (summary === undefined) {
		throw new Error("resumeCheckpointChain: rolling checkpoint abuts the ring yet produced no summary (invariant violation)");
	}
	return summary;
}

/**
 * Build the served checkpoint chain for a `checkpoint_window` resume: the **shortest** contiguous low→high
 * chain of {@link CheckpointSummary}s that both covers `fromRevision` and **abuts the ring's low edge**
 * (`top.toRevision === ringLow − 1`), or `undefined` when no gap-free chain exists. Shared by
 * {@link classifyResume} and {@link serveResume} so they cannot disagree about the served shape.
 *
 * Cases are evaluated in precedence order (this ordering preserves every existing classification test):
 *
 *  - **A — rolling wins.** The rolling checkpoint abuts the ring (it is fed by ring eviction, so it always
 *    does) and covers `fromRevision`: the fresher, narrower single link `[rolling]`.
 *  - **B1 — inherited abuts the ring directly.** No new-tail rolling checkpoint has formed between the
 *    inherited handoff and the ring yet (the `12.51` abut case): the single link `[inherited]`.
 *  - **B2 — the bridge.** The inherited handoff abuts the new tail's rolling checkpoint, which abuts the
 *    ring: the two-link `[inherited, rolling]` chain spans inherited → rolling → ring with no gap.
 *
 * Any other shape (a gap below `fromRevision`, or a gap between the windows) returns `undefined` → the
 * request falls to `out_of_window` (an honest chain read). `ringLow === undefined` (no live ring to abut /
 * no `recentEntries`) also returns `undefined`.
 */
function resumeCheckpointChain(
	fromRevision: number,
	ringLow: number | undefined,
	rolling: RollingCheckpoint | undefined,
	inherited: CheckpointSummary | undefined,
): CheckpointSummary[] | undefined {
	if (ringLow === undefined) {
		return undefined;
	}
	const ringAbut = ringLow - 1;

	// Case A — the rolling checkpoint wins (fresher, narrower). `toRevision === ringAbut` implies it is
	// non-empty, so the summary is defined (asserted in requireRollingSummary).
	if (rolling !== undefined && rolling.toRevision === ringAbut && rolling.covers(fromRevision)) {
		return [requireRollingSummary(rolling)];
	}
	// Case B1 — the inherited handoff abuts the ring directly (the 12.51 abut case): a single link.
	if (inherited !== undefined && inherited.toRevision === ringAbut && checkpointCovers(inherited, fromRevision)) {
		return [inherited];
	}
	// Case B2 — the bridge: inherited abuts the rolling checkpoint, which abuts the ring. The two-link chain
	// carries inherited → rolling → ring with no gap, and each link keeps its own already-correct merged
	// digest (nothing is re-folded, so a per-collection override fold composes trivially).
	if (
		inherited !== undefined &&
		rolling !== undefined &&
		rolling.toRevision === ringAbut &&
		inherited.toRevision + 1 === rolling.fromRevision &&
		checkpointCovers(inherited, fromRevision)
	) {
		return [inherited, requireRollingSummary(rolling)];
	}
	return undefined;
}

/**
 * Classify a resume request against the serving cohort's stacked windows. The decision order is:
 *
 *  1. **tail_rotated** — `req.latestKnownTailId !== currentTailId`. A stale tail means the tree migrated,
 *     so the lag classification below is moot.
 *  2. **backfill** — `fromRevision` is at/above the replay ring's low edge (within, or already current).
 *  3. **checkpoint_window** — below the ring but a gap-free {@link resumeCheckpointChain} covers it: the
 *     rolling checkpoint (steady state), the inherited cross-rotation handoff (`docs/reactivity.md` §Tail
 *     rotation step 5 — "the new tail holds the old checkpoint"), or the two-link `[inherited, rolling]`
 *     bridge spanning both when the new tail's own rolling checkpoint has formed between the handoff and the
 *     ring.
 *  4. **out_of_window** — older than even the deepest window, or a gap leaves no contiguous chain to the
 *     ring (a chain read), or every window is empty/absent.
 */
export function classifyResume(
	req: ResumeV1,
	buffer: ReplayBuffer,
	checkpoint: RollingCheckpoint | undefined,
	currentTailId: string,
	inherited?: CheckpointSummary,
): ResumeResult {
	if (req.latestKnownTailId !== currentTailId) {
		return "tail_rotated";
	}
	const low = buffer.lowRevision;
	if (low !== undefined && req.fromRevision >= low) {
		return "backfill";
	}
	return resumeCheckpointChain(req.fromRevision, low, checkpoint, inherited) !== undefined
		? "checkpoint_window"
		: "out_of_window";
}

/** Construction inputs for {@link serveResume}. */
export interface ResumeServingDeps {
	/** The cohort's replay ring (the live `PushState.replayBuffer`). */
	readonly buffer: ReplayBuffer;
	/** The cohort's rolling parent checkpoint (the live `PushState.checkpoint`). */
	readonly checkpoint?: RollingCheckpoint;
	/**
	 * The checkpoint migrated from the **outgoing** tail when this cohort became the new tail across a
	 * rotation (the live `PushState.inheritedCheckpoint`). Consulted when the rolling {@link checkpoint} does
	 * not cover `fromRevision`: a resume whose span crosses the rotation is answered from the inherited window
	 * — either alone (it abuts the ring directly) or as the lower link of the two-link `[inherited, rolling]`
	 * bridge when the new tail's own rolling checkpoint has formed between the handoff and the ring (see
	 * {@link resumeCheckpointChain}) — instead of falling to `out_of_window` (`docs/reactivity.md` §Tail
	 * rotation step 5).
	 */
	readonly inheritedCheckpoint?: CheckpointSummary;
	/** The cohort's current tail block id, base64url. */
	readonly currentTailId: string;
	/** Highest committed revision the cohort knows (the live `PushState.lastRevision`). */
	readonly currentRevision: number;
	/** Revision the current tail became effective (for a tail_rotated reply); defaults to `currentRevision`. */
	readonly rotationRevision?: number;
	/** Collection this cohort serves, base64url — a foreign-collection request is rejected. */
	readonly expectedCollectionId: string;
}

/**
 * Serve a {@link ResumeV1} from a cohort's stacked windows, producing the classified {@link ResumeReplyV1}.
 * Pure over the supplied snapshot — no I/O, no clock. A request whose `collectionId` does not match
 * `expectedCollectionId` is rejected (a resume is collection-scoped).
 */
export function serveResume(req: ResumeV1, deps: ResumeServingDeps): ResumeReplyV1 {
	if (req.collectionId !== deps.expectedCollectionId) {
		failWire(`serveResume: request collectionId does not match this cohort's collection`);
	}
	const result = classifyResume(req, deps.buffer, deps.checkpoint, deps.currentTailId, deps.inheritedCheckpoint);
	switch (result) {
		case "backfill": {
			const high = deps.buffer.highRevision ?? deps.currentRevision;
			const entries = deps.buffer.range(req.fromRevision, high).map((e) => e.payload);
			return { v: 1, result, entries, currentRevision: deps.currentRevision };
		}
		case "checkpoint_window": {
			// The contiguous chain the helper built — rolling alone, inherited alone, or the two-link bridge.
			// classifyResume returned checkpoint_window iff this chain is present, so it is non-undefined here
			// (the two calls share inputs, so they cannot disagree).
			const chain = resumeCheckpointChain(req.fromRevision, deps.buffer.lowRevision, deps.checkpoint, deps.inheritedCheckpoint);
			if (chain === undefined) {
				throw new Error("serveResume: checkpoint_window classification produced no checkpoint chain (invariant violation)");
			}
			const recentEntries = deps.buffer.entries().map((e) => e.payload);
			return { v: 1, result, checkpoints: chain, recentEntries, currentRevision: deps.currentRevision };
		}
		case "out_of_window":
			return { v: 1, result, currentTailId: deps.currentTailId, currentRevision: deps.currentRevision };
		case "tail_rotated":
			return {
				v: 1,
				result,
				newTailId: deps.currentTailId,
				newRevisionAtRotation: deps.rotationRevision ?? deps.currentRevision,
			};
	}
}

// --- subscriber-side apply ---

/** The outcome of applying a {@link ResumeReplyV1} subscriber-side. */
export type ResumeApplyOutcome =
	/** Backfill entries were replayed through the delivery path; the subscriber is current. */
	| "backfilled"
	/** Checkpoint endpoints verified, digest applied, recent entries replayed; the subscriber is current. */
	| "checkpoint_applied"
	/** Checkpoint bracketing endpoints failed to verify (forged/tampered) — the subscriber must chain-read. */
	| "checkpoint_untrusted"
	/** Out of every window — the subscriber must chain-read then re-subscribe. */
	| "out_of_window"
	/** Tail rotated — the subscriber must re-register under the new tail. */
	| "tail_rotated";

/** Sinks for {@link applyResumeReply} — each non-backfill variant escalates to the application. */
export interface ResumeApplyDeps {
	/** Feeds replayed entries through the verify → contiguity → deliver path (closing the gap, deduping). */
	readonly subscriber: ReactivitySubscriber;
	/** Verifies a checkpoint's bracketing endpoints are real committed revisions. */
	readonly verifier: NotificationVerifier;
	/** Apply a verified checkpoint's merged digest (e.g. invalidate the changed keys). */
	readonly onCheckpointDigest?: (summary: CheckpointSummary) => void;
	/** Fall back to a chain read + fresh subscribe (out_of_window, or an untrusted checkpoint). */
	readonly onChainRead?: (currentTailId: string | undefined, currentRevision: number | undefined) => void;
	/** Re-register under the rotated tail (tail_rotated). */
	readonly onTailRotated?: (newTailId: string, newRevisionAtRotation: number) => void;
}

/**
 * Apply a {@link ResumeReplyV1} on the subscriber side, returning the {@link ResumeApplyOutcome}. Backfill
 * and checkpoint-window entries re-enter through {@link ReactivitySubscriber.onNotification} (so they are
 * verified, contiguity-checked, and deduped exactly like live notifications); the other variants escalate
 * to the application via the supplied sinks. A checkpoint whose bracketing endpoints do not verify is
 * **not** applied — the subscriber chain-reads instead (a forged checkpoint must never advance state).
 */
export async function applyResumeReply(reply: ResumeReplyV1, deps: ResumeApplyDeps): Promise<ResumeApplyOutcome> {
	switch (reply.result) {
		case "backfill": {
			for (const n of reply.entries ?? []) {
				await deps.subscriber.onNotification(n);
			}
			return "backfilled";
		}
		case "checkpoint_window": {
			const summaries = reply.checkpoints;
			if (summaries === undefined || summaries.length === 0) {
				failWire(`applyResumeReply: checkpoint_window reply is missing its checkpoint chain`);
			}
			// Low-edge guard on the **lowest** link: endpoint verification proves each link's bounds are *real*
			// committed revisions, but not that the chain connects to the subscriber's contiguity head. If the
			// lowest `fromRevision` sits above `lastRevision + 1` there is an un-summarized gap below the chain;
			// rebaselining would silently skip those revisions. The honest cohort never sends such a reply
			// (`classifyResume` only picks `checkpoint_window` when the chain covers `lastRevision + 1`), so a
			// non-abutting low edge is a forged/buggy reply — chain-read rather than advance past a gap.
			if (summaries[0]!.fromRevision > deps.subscriber.lastRevision + 1) {
				deps.onChainRead?.(reply.currentTailId, reply.currentRevision);
				return "checkpoint_untrusted";
			}
			// Intra-chain contiguity (defense in depth: the codec already checks every *decoded* reply, but an
			// in-process reply may bypass the codec). A gap/overlap between links would skip or double revisions.
			for (let i = 1; i < summaries.length; i++) {
				if (summaries[i]!.fromRevision !== summaries[i - 1]!.toRevision + 1) {
					deps.onChainRead?.(reply.currentTailId, reply.currentRevision);
					return "checkpoint_untrusted";
				}
			}
			// Verify EVERY link's bracketing endpoints **before applying anything** — a single forged link kills
			// the whole reply, so nothing is delivered and `lastRevision` is unchanged (no partial advance).
			for (const summary of summaries) {
				const verdict = await verifyCheckpointEndpoints(summary, deps.verifier);
				if (verdict !== "verified") {
					deps.onChainRead?.(reply.currentTailId, reply.currentRevision);
					return "checkpoint_untrusted";
				}
			}
			// Apply in order: the application sees each link's merged-digest hint, then the contiguity head
			// advances past that link. `rebaseline` is monotone, so the head lands at the top link's
			// `toRevision`; the recent entries (immediately above it) then replay gap-free — any recent entry
			// at/below the head dedupes (`docs/reactivity.md` §Parent checkpoint summaries).
			for (const summary of summaries) {
				deps.onCheckpointDigest?.(summary);
				deps.subscriber.rebaseline(summary.toRevision);
			}
			for (const n of reply.recentEntries ?? []) {
				await deps.subscriber.onNotification(n);
			}
			return "checkpoint_applied";
		}
		case "out_of_window": {
			deps.onChainRead?.(reply.currentTailId, reply.currentRevision);
			return "out_of_window";
		}
		case "tail_rotated": {
			deps.onTailRotated?.(reply.newTailId ?? "", reply.newRevisionAtRotation ?? 0);
			return "tail_rotated";
		}
	}
}

// --- Edge sticky cohort-hint cache (one-RT resume after a flap) ---

/**
 * A cached cohort hint for fast reactivity re-attach (`docs/reactivity.md` §Edge profile: "`cohortHint`
 * is sticky-cached across reconnects so brief network flaps don't trigger re-walk"). Distinct from the
 * cohort-topic `CohortHint` (the full resolved cohort) — this is the minimal sticky-cached slice the
 * subscriber dials a resume at directly. All ids base64url.
 */
export interface ReactivityCohortHint {
	/** The collection's tail-anchored topic id at cache time. */
	readonly topicId: string;
	/** The cached serving primary. */
	readonly primary: string;
	/** The cohort member set for fast re-attach. */
	readonly cohortHint: readonly string[];
}

/**
 * A sticky per-collection cache of the last-known serving cohort, keyed by collection id. **Sticky** means
 * it survives reconnects — a brief network flap reuses the cached primary so resume is one round trip
 * instead of a re-walk from `d_max`. It is invalidated only on an explicit signal (a `TailRotated` reply,
 * or a confirmed-stale primary), never merely on a transient failure.
 */
export interface StickyCohortHintCache {
	/** The cached hint for `collectionId`, or `undefined` if none. */
	get(collectionId: string): ReactivityCohortHint | undefined;
	/** Cache (or refresh) the hint for `collectionId`. */
	set(collectionId: string, hint: ReactivityCohortHint): void;
	/** Drop the cached hint for `collectionId` (on rotation / confirmed staleness). */
	invalidate(collectionId: string): void;
}

class MapStickyCohortHintCache implements StickyCohortHintCache {
	private readonly byCollection = new Map<string, ReactivityCohortHint>();

	get(collectionId: string): ReactivityCohortHint | undefined {
		return this.byCollection.get(collectionId);
	}

	set(collectionId: string, hint: ReactivityCohortHint): void {
		this.byCollection.set(collectionId, hint);
	}

	invalidate(collectionId: string): void {
		this.byCollection.delete(collectionId);
	}
}

/** Build a {@link StickyCohortHintCache} (a plain per-collection map; sticky across reconnects). */
export function createStickyCohortHintCache(): StickyCohortHintCache {
	return new MapStickyCohortHintCache();
}
