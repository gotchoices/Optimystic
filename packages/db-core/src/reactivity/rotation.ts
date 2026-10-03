/**
 * Reactivity — tail rotation lifecycle (`docs/reactivity.md` §Anchor, §Tail rotation).
 *
 * A collection's topic is stable (`reactivityCollectionTopicId`, `topic-anchor.ts`); what rotates is its
 * **root**. When the tail block fills (`block_fill_size` entries, the log's `EntriesPerBlock`) a new tail
 * block is born and the root — the tail's storage group at `H(tailId)` — moves to the new tail's group. The
 * tiers below the root sit at `coord_d(P, topicId)` and never move, so a rotation is "same topic, the root
 * moved": a registration at the root re-registers under the new root key; one below the root keeps its place
 * and only updates the root key a later re-walk would use (`CohortTopicService.moveRoot`). This module owns
 * the subscriber- and root-side lifecycle around that move:
 *
 *  - **Pre-announce** — the block-filling commit's notification carries {@link RotationHintV1}; built here
 *    by {@link buildRotationHint} and detected subscriber-side by {@link detectRotation}.
 *  - **Block-fill tracking** — {@link BlockFillTracker} counts transactions in the current tail block and
 *    fires anticipatory **warm-up** at `block_fill_size − warm_threshold` and the **filling** signal at
 *    `block_fill_size` (the commit that carries the hint).
 *  - **Drain** — {@link TailDrainGate} keeps the outgoing root serving renewals/replays for `T_drain` while
 *    bouncing *new* subscriptions with a `Promoted`-shaped {@link RotationRedirectV1} naming the new tail.
 *  - **Jittered re-registration** — {@link planReRegistration} / {@link planReRegistrationWave} schedule a
 *    subscriber's follow of the new tail over `T_rejoin_jitter` (the cohort-topic {@link RejoinJitter}),
 *    carrying its existing `lastRevision` (revisions are continuous across rotations).
 *  - **Buffer-to-checkpoint handoff** — {@link buildRotationHandoffCheckpoint} folds the outgoing root's
 *    replay buffer into a final {@link CheckpointSummary} covering `[lastCheckpoint.toRevision + 1,
 *    rotationRevision]`, the **only** state migrated across a rotation; {@link applyRotationHandoff} lands it
 *    at the new root so a `ResumeV1` spanning the rotation is recoverable.
 *
 * Tiers below the root do not drain on a rotation: only the old root stops receiving commits and releases its
 * state after `T_drain`. It needs no code here.
 *
 * Coordination with [reactivity-backfill-resume-checkpoints]: that ticket owns the `ResumeReplyV1.TailRotated`
 * variant and the `latestKnownTailId`-staleness classification; this module produces the handoff checkpoint
 * and the rotation *condition*. The new root's {@link PushState.inheritedCheckpoint} (set by
 * {@link applyRotationHandoff}) is the seam the resume classifier consults to answer a checkpoint-window
 * resume whose span crosses the rotation: `classifyResume`/`serveResume` read it (after the rolling
 * `checkpoint` misses) and serve the inherited summary, so a cross-rotation resume no longer falls to
 * `out_of_window` (`docs/reactivity.md` §Resume, §Tail rotation step 5). The drain-window redirect a new
 * subscription receives, {@link RotationRedirectV1}, is serialized by {@link validateRotationRedirectV1} and
 * rides the recover reply envelope as `kind: "rotated"` ({@link import("./recover.js").RecoverReplyV1}).
 */

import { b64urlToBytes } from "../cohort-topic/wire/codec.js";
import type { RejoinJitter } from "../cohort-topic/antiflood/jitter.js";
import { BLOCK_FILL_SIZE_DEFAULT, T_DRAIN_MS, WARM_THRESHOLD_DEFAULT } from "./config.js";
import { buildCheckpointSummary, type CheckpointSummary } from "./checkpoint.js";
import type { PushState } from "./push-state.js";
import type { NotificationV1, RotationHintV1 } from "./wire.js";
import { asObject, b64urlField, failWire, reqIntInRange, reqString, requireV1 } from "./wire-validate.js";

// --- pre-announce + subscriber-side detection --------------------------------

/**
 * Build the rotation pre-announce embedded in the block-filling commit's notification. The new tail block
 * id is known at the filling commit; the rotation becomes effective at the next revision, so
 * `effectiveAtRevision = fillingRevision + 1` (`docs/reactivity.md` §Tail rotation, worked scenario:
 * revision 5400 carries `{ newTailId: T_6, effectiveAtRevision: 5401 }`).
 */
export function buildRotationHint(newTailId: string, fillingRevision: number): RotationHintV1 {
	return { newTailId, effectiveAtRevision: fillingRevision + 1 };
}

/** The subscriber-side rotation verdict for one delivered notification. */
export interface RotationDetection {
	/** True iff the subscriber's root has moved (delivered tail differs, at a newer revision) or a rotation is pre-announced. */
	readonly rotated: boolean;
	/** The tail id to re-register under, base64url — present iff `rotated`. */
	readonly newTailId?: string;
	/**
	 * True iff this is a **pre-announce**: the delivered `tailId` still matches the tail the subscriber follows,
	 * but the notification's `rotationHint.newTailId` names a different successor. (False when the delivered
	 * tail already differs — the root has *already* moved.)
	 */
	readonly preAnnounced: boolean;
}

/** What a subscriber knows of the collection's log when a notification arrives, for {@link detectRotation}. */
export interface FollowedTail {
	/** The latest tail the subscriber has followed, base64url. */
	readonly tailId: string;
	/**
	 * The newest revision the subscriber has seen: delivered or verified from a notification, replayed by a
	 * backfill or resume, or read from the log by its host. Revisions are allocated in order and the tail only
	 * moves forward, so no revision at or below it was announced at a tail newer than the newest tail the
	 * subscriber has seen a notification for.
	 */
	readonly newestRevision: number;
}

/**
 * Detect tail rotation for a subscriber following `followed.tailId` from a delivered notification. Rotation
 * is signaled when the delivered `tailId` **or** the `rotationHint.newTailId` differs from it
 * (`docs/reactivity.md` §Tail rotation). An already-rotated delivery (different `tailId`) takes precedence
 * over a pre-announce.
 *
 * A differing `tailId` at a revision at or below `followed.newestRevision` is **not** a rotation: the
 * notification was announced at a tail the subscriber has already moved past. The old and the new root are
 * different machines delivering independently, so the last notification announced at the old tail can arrive
 * after the subscriber followed the new one; without the revision check it would read as a rotation back to
 * the old tail and cost a registration at a root that announces nothing further.
 */
export function detectRotation(followed: FollowedTail, n: Pick<NotificationV1, "tailId" | "rotationHint" | "revision">): RotationDetection {
	if (n.tailId !== followed.tailId) {
		if (n.revision <= followed.newestRevision) {
			return { rotated: false, preAnnounced: false };
		}
		// The delivered notification was announced at the *new* root already — a hard rotation, not a pre-announce.
		return { rotated: true, newTailId: n.tailId, preAnnounced: false };
	}
	if (n.rotationHint !== undefined && n.rotationHint.newTailId !== followed.tailId) {
		return { rotated: true, newTailId: n.rotationHint.newTailId, preAnnounced: true };
	}
	return { rotated: false, preAnnounced: false };
}

// --- block-fill tracking (warm-up + filling signal) --------------------------

/** The fill signal for one committed transaction in the current tail block. */
export type BlockFillSignal =
	/** Below the warm-up threshold — nothing to do. */
	| { readonly kind: "none"; readonly count: number }
	/**
	 * Anticipatory warm-up: the block has reached `block_fill_size − warm_threshold` transactions with
	 * `remaining` to go. The outgoing tail opportunistically biases FRET pre-dialing toward likely-successor
	 * coords (best-effort; the next `tailId` is not yet knowable). No state migrates.
	 */
	| { readonly kind: "warmup"; readonly count: number; readonly remaining: number }
	/**
	 * The **block-filling** transaction: this commit's notification carries the {@link RotationHintV1} and
	 * triggers the rotation. The tracker resets for the next block after emitting this.
	 */
	| { readonly kind: "filling"; readonly count: number };

/** Construction inputs for a {@link BlockFillTracker}. */
export interface BlockFillTrackerInit {
	/** Entries per log block before the tail rotates (default {@link BLOCK_FILL_SIZE_DEFAULT}, the log's `EntriesPerBlock`). */
	readonly blockFillSize?: number;
	/** Transactions remaining in the tail when anticipatory warm-up fires (default {@link WARM_THRESHOLD_DEFAULT}). */
	readonly warmThreshold?: number;
}

/**
 * Counts transactions committed into the current tail block and emits the {@link BlockFillSignal} that
 * drives anticipatory warm-up and the block-filling rotation trigger (`docs/reactivity.md` §Tail rotation,
 * §Anticipatory warm-up). One tracker per collection on the tail-cohort primary.
 */
export class BlockFillTracker {
	readonly blockFillSize: number;
	readonly warmThreshold: number;
	private count = 0;

	constructor(init: BlockFillTrackerInit = {}) {
		const blockFillSize = init.blockFillSize ?? BLOCK_FILL_SIZE_DEFAULT;
		const warmThreshold = init.warmThreshold ?? WARM_THRESHOLD_DEFAULT;
		if (!Number.isInteger(blockFillSize) || blockFillSize < 1) {
			throw new RangeError(`reactivity rotation: blockFillSize must be an integer >= 1, got ${blockFillSize}`);
		}
		if (!Number.isInteger(warmThreshold) || warmThreshold < 0 || warmThreshold >= blockFillSize) {
			throw new RangeError(`reactivity rotation: warmThreshold must be an integer in 0..${blockFillSize - 1}, got ${warmThreshold}`);
		}
		this.blockFillSize = blockFillSize;
		this.warmThreshold = warmThreshold;
	}

	/** Transactions committed into the current (not-yet-rotated) block. */
	get transactionsInBlock(): number {
		return this.count;
	}

	/** The fill count at which anticipatory warm-up fires (`block_fill_size − warm_threshold`). */
	get warmAt(): number {
		return this.blockFillSize - this.warmThreshold;
	}

	/**
	 * Record one committed transaction and return its fill signal. Emits `warmup` exactly when the block
	 * reaches `block_fill_size − warm_threshold`, and `filling` when it reaches `block_fill_size` — after
	 * which the counter resets for the next block.
	 */
	onCommit(): BlockFillSignal {
		this.count += 1;
		if (this.count >= this.blockFillSize) {
			const count = this.count;
			this.count = 0; // a new tail block is born; start counting it
			return { kind: "filling", count };
		}
		if (this.count === this.warmAt && this.warmThreshold > 0) {
			return { kind: "warmup", count: this.count, remaining: this.blockFillSize - this.count };
		}
		return { kind: "none", count: this.count };
	}

	/** Reset the block counter (e.g. an externally-observed rotation the tracker did not drive). */
	reset(): void {
		this.count = 0;
	}
}

// --- drain gate (old tail serves renewals/replays, bounces new subscriptions) -

/** The kind of request arriving at the outgoing tail during its drain window. */
export type DrainOp =
	/** A *fresh* subscription (`lastKnownRev == 0` or a never-seen subscriber) — bounced to the new tree. */
	| "new_subscribe"
	/** A renewal of an existing registration — served through the drain. */
	| "renew"
	/** A replay/backfill/resume request — served through the drain. */
	| "replay";

/**
 * A `Promoted`-shaped redirect to the moved root (`docs/reactivity.md` §Tail rotation step 2). Unlike the
 * cohort-topic tier-based `Promoted`, this redirects to the same topic's **new root** — the new tail's storage
 * group at `H(newTailId)` — so a receiver acts on `newTailId`. `newTopicId` stays on the wire and carries the
 * collection's unchanged topic (the field predates the stable topic; it is not a redirect target).
 */
export interface RotationRedirectV1 {
	readonly v: 1;
	readonly result: "rotated";
	/** New tail block id the root moved to, base64url — the new root key. */
	readonly newTailId: string;
	/** The collection's topic id, base64url — unchanged by a rotation. */
	readonly newTopicId: string;
	/** Revision at which the rotation took effect. */
	readonly effectiveAtRevision: number;
}

/**
 * Narrow an already-parsed value to a {@link RotationRedirectV1}, throwing {@link CohortWireError} on any
 * defect. The redirect rides the recover reply envelope as `kind: "rotated"`
 * ({@link import("./recover.js").RecoverReplyV1}); it carries no signature — like the other recover reply
 * variants it is an unauthenticated routing hint (the subscriber re-walks and verifies the new tree on
 * arrival), so its trust comes from the new tree, not the redirect.
 */
export function validateRotationRedirectV1(value: unknown): RotationRedirectV1 {
	const what = "RotationRedirectV1";
	const obj = asObject(value, what);
	requireV1(obj, what);
	if (obj["result"] !== "rotated") {
		failWire(`${what}: field "result" must be "rotated"`);
	}
	return {
		v: 1,
		result: "rotated",
		newTailId: b64urlField(reqString(obj, "newTailId", what), "newTailId", what),
		newTopicId: b64urlField(reqString(obj, "newTopicId", what), "newTopicId", what),
		effectiveAtRevision: reqIntInRange(obj, "effectiveAtRevision", what, 0),
	};
}

/** The drain gate's decision for one inbound request. */
export type DrainDecision =
	/** Serve normally (renewals / replays during the drain window). */
	| { readonly kind: "serve" }
	/** Bounce to the new tree (a new subscription during the drain window). */
	| { readonly kind: "redirect"; readonly redirect: RotationRedirectV1 }
	/** The drain window has elapsed — the outgoing tail holds nothing; the caller re-registers from `d_max`. */
	| { readonly kind: "drained" };

/** Construction inputs for a {@link TailDrainGate}. */
export interface TailDrainGateInit {
	/** Unix ms the rotation took effect (drain starts here). */
	readonly rotatedAt: number;
	/** New tail block id the root moved to, base64url. */
	readonly newTailId: string;
	/** The collection's topic id, base64url — carried unchanged on the redirect. */
	readonly topicId: string;
	/** Revision at which the rotation took effect. */
	readonly effectiveAtRevision: number;
	/** Drain duration `T_drain` (ms, default {@link T_DRAIN_MS}). */
	readonly tDrainMs?: number;
}

/**
 * The outgoing root's drain state machine. For `T_drain` after a rotation it accepts **renewals** and
 * serves **replays**, but bounces **new subscriptions** with a {@link RotationRedirectV1} to the new root;
 * after `T_drain` it reports `drained` for everything (the subscriber re-registers from `d_max`).
 */
export class TailDrainGate {
	readonly rotatedAt: number;
	readonly tDrainMs: number;
	private readonly redirect: RotationRedirectV1;

	constructor(init: TailDrainGateInit) {
		const tDrainMs = init.tDrainMs ?? T_DRAIN_MS;
		if (!(tDrainMs > 0)) {
			throw new RangeError(`reactivity rotation: tDrainMs must be > 0, got ${tDrainMs}`);
		}
		this.rotatedAt = init.rotatedAt;
		this.tDrainMs = tDrainMs;
		this.redirect = {
			v: 1,
			result: "rotated",
			newTailId: init.newTailId,
			newTopicId: init.topicId,
			effectiveAtRevision: init.effectiveAtRevision,
		};
	}

	/** Unix ms the drain window closes. */
	get drainEndsAt(): number {
		return this.rotatedAt + this.tDrainMs;
	}

	/** True while the outgoing tail is still draining (within `T_drain` of the rotation). */
	isDraining(now: number): boolean {
		return now < this.drainEndsAt;
	}

	/** The redirect this gate hands a new subscription (exposed for the redirect transport / tests). */
	get rotationRedirect(): RotationRedirectV1 {
		return this.redirect;
	}

	/**
	 * Classify an inbound request. Within the drain window: `new_subscribe` → redirect, `renew`/`replay` →
	 * serve. After the window: `drained` (the old root has released its forwarder state).
	 */
	classify(op: DrainOp, now: number): DrainDecision {
		if (!this.isDraining(now)) {
			return { kind: "drained" };
		}
		return op === "new_subscribe" ? { kind: "redirect", redirect: this.redirect } : { kind: "serve" };
	}
}

// --- jittered re-registration (a subscriber follows the new root) -------------

/** A subscriber's planned follow of the moved root. */
export interface ReRegistrationPlan {
	/** New tail block id (raw bytes) — the new root key to follow. */
	readonly newTailId: Uint8Array;
	/** The subscriber's existing `lastRevision`, carried so revisions stay continuous across the rotation. */
	readonly lastRevision: number;
	/** Unix ms at which to fire the follow (jittered over `T_rejoin_jitter`). */
	readonly fireAt: number;
}

/** Inputs shared by the single and wave re-registration planners. */
interface ReRegistrationTarget {
	/** The rotation hint (or any object carrying the successor `newTailId`), base64url. */
	readonly hint: Pick<RotationHintV1, "newTailId">;
}

/**
 * Plan **one** subscriber's follow of the moved root: carry the hint's `newTailId` and the subscriber's
 * `lastRevision`, and draw a jittered `fireAt` over `T_rejoin_jitter` via the cohort-topic
 * {@link RejoinJitter} (`scheduleRejoin` — a uniform offset, decorrelating this subscriber's re-join from
 * its peers). Only a registration at the root sends anything when the plan fires; one below the root
 * updates its root key locally.
 */
export function planReRegistration(opts: ReRegistrationTarget & { lastRevision: number; now: number; jitter: RejoinJitter }): ReRegistrationPlan {
	return { newTailId: b64urlToBytes(opts.hint.newTailId), lastRevision: opts.lastRevision, fireAt: opts.jitter.scheduleRejoin(opts.now) };
}

/**
 * Plan a **whole wave** of subscribers' follows of the moved root. Uses the
 * {@link RejoinJitter.scheduleWave} hard-bound staggering so any `T_rejoin_jitter`-long window holds at
 * most the injected jitter's `capPromote` arrivals — the new root never sees more than
 * `capPromote / T_rejoin_jitter` re-registrations per second.
 *
 * **Caller contract:** rotation is governed by the *fast-promote* bound, so the host MUST build this `jitter`
 * with `capPromote = cap_promote_fast` ({@link import("../cohort-topic/promotion.js").DEFAULT_CAP_PROMOTE_FAST}
 * = 32), **not** the default `createRejoinJitter()` cap (the cohort-failure `cap_promote = 64`). With the
 * default cap the wave bounds to 64/window and silently overruns the documented rotation burst ceiling
 * (`docs/reactivity.md` §Tail rotation rotation-cost). Returns one plan per subscriber, ascending by `fireAt`.
 */
export function planReRegistrationWave(
	opts: ReRegistrationTarget & { subscribers: readonly { readonly lastRevision: number }[]; now: number; jitter: RejoinJitter },
): ReRegistrationPlan[] {
	const newTailId = b64urlToBytes(opts.hint.newTailId);
	const fireAts = opts.jitter.scheduleWave(opts.subscribers.length, opts.now);
	return opts.subscribers.map((s, i) => ({ newTailId, lastRevision: s.lastRevision, fireAt: fireAts[i]! }));
}

// --- buffer-to-checkpoint handoff (the only state migrated across a rotation) -

/** The state migrated from the outgoing root to the new root on rotation. */
export interface RotationHandoff {
	/** The final checkpoint covering `[lastCheckpoint.toRevision + 1, rotationRevision]`. */
	readonly checkpoint: CheckpointSummary;
	/** The revision the rotation took effect at (the high edge the handoff checkpoint covers). */
	readonly rotationRevision: number;
}

/**
 * Fold the outgoing root's replay buffer into the final {@link CheckpointSummary} handed to the new root
 * (`docs/reactivity.md` §Tail rotation step 5 — the **only** state migration across a rotation). The
 * handoff covers `[lastCheckpoint.toRevision + 1, rotationRevision]`: the revisions still live in the
 * replay ring (above the rolling checkpoint's high edge) up to the rotation revision. Returns `undefined`
 * when the outgoing tail's ring is empty (nothing to migrate). Reuses the rolling checkpoint's own fold
 * options so the merged digest is byte-identical to a steady-state checkpoint.
 */
export function buildRotationHandoffCheckpoint(state: PushState, opts: { rotationRevision?: number } = {}): RotationHandoff | undefined {
	const ringLow = state.replayBuffer.lowRevision;
	const ringHigh = state.replayBuffer.highRevision;
	if (ringLow === undefined || ringHigh === undefined) {
		return undefined; // nothing live in the ring to migrate
	}
	const rotationRevision = opts.rotationRevision ?? ringHigh;
	// The handoff continues immediately above the rolling checkpoint's high edge; when no checkpoint has
	// formed yet, that is the ring's low edge. The two windows stack, so `from` abuts `lastCheckpoint`.
	const priorCheckpointTo = state.checkpoint.toRevision;
	const from = priorCheckpointTo !== undefined ? priorCheckpointTo + 1 : ringLow;
	const entries = state.replayBuffer.range(from, rotationRevision);
	const checkpoint = buildCheckpointSummary(entries, state.checkpoint.foldOptions);
	if (checkpoint === undefined) {
		return undefined;
	}
	return { checkpoint, rotationRevision };
}

/**
 * Land a {@link RotationHandoff} at the new root's {@link PushState}: record the inherited checkpoint so a
 * `ResumeV1` whose span crosses the rotation is recoverable from the new root (the new root "holds the old
 * checkpoint", `docs/reactivity.md` §Tail rotation step 5). The handoff is a one-time migration — it does
 * not feed the new root's rolling checkpoint (that rolls from the new root's own replay-ring eviction).
 */
export function applyRotationHandoff(newTailState: PushState, handoff: RotationHandoff): void {
	newTailState.adoptRotationCheckpoint(handoff.checkpoint);
}

/** True iff `summary` covers `revision` (its inclusive `[fromRevision, toRevision]` span). */
export function checkpointCovers(summary: CheckpointSummary, revision: number): boolean {
	return revision >= summary.fromRevision && revision <= summary.toRevision;
}
