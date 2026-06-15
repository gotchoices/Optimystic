import type { VTime, PeerRef } from './types.js';
import { createSimWorld } from './world.js';
import { DEFAULT_HOP_MS } from './latency.js';
import { bytesToHex } from './hex.js';
import {
	TopicTree,
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig
} from './topic-tree.js';
import { expectedDepth, uniformLadder } from './promotion-convergence.js';

/**
 * Reactivity replay-buffer + checkpoint coverage model, checked against `docs/reactivity.md`
 * (§Replay window, §Resume, §Parent checkpoint summaries, §Tail rotation). It answers the
 * GROUNDING reactivity-timing questions: how long a sleeping subscriber can stay recoverable in
 * one round trip (`W`), how far the parent checkpoint extends that (`W_checkpoint`), how those
 * windows translate to wall-clock recovery at a given commit rate (so the `W` vs `W_checkpoint`
 * ratio — and whether `W` should be adaptive per measured cps — can be argued from numbers), and
 * that a tail-rotation re-registration burst stays inside the cohort-topic fast-promote bound.
 *
 * Everything except the rotation burst is synchronous and clock-free: the ring buffer, rolling
 * checkpoint, and sliding dedupe window are pure state machines, and resume classification is a
 * pure function of `(lag, tailId)`. The rotation burst reuses the modeled `TopicTree`
 * (a reactivity forwarder cohort *is* a promoted topic cohort; rotation re-registration drives the
 * same promotion machinery) on the virtual clock.
 *
 * Modeling note — resume thresholds. The classifier follows the layered/stacked form from
 * `docs/reactivity.md`: `lag < W` → Backfill (ring covers it), `W ≤ lag < W + W_checkpoint` →
 * CheckpointWindow (parent checkpoint covers it), else OutOfWindow (chain read required). This
 * matches `RollingCheckpoint.covers`, whose deepest in-window lag at steady state is
 * `W + W_checkpoint − 1`.
 */

// --- configuration -----------------------------------------------------------

/** Reactivity defaults (reactivity.md §Configuration). */
export interface ReactivityConfig {
	/** Replay ring-buffer depth, revisions per cohort per collection. */
	readonly W: number;
	/** Parent-checkpoint span (revisions) layered immediately below the replay ring; the combined recoverable bound is `W + Wcheckpoint`. */
	readonly Wcheckpoint: number;
	/** Sliding `(revision, sigDigest)` dedupe-window size. */
	readonly dedupeWindow: number;
	/** Per-subscriber bounded queue depth at a forwarder. */
	readonly queueMax: number;
	/** Transactions per block — drives tail rotation. */
	readonly blockFillSize: number;
	/** Re-registration jitter span after a rotation hint. */
	readonly tRejoinJitterMs: VTime;
	/** Old-tail drain time after rotation. */
	readonly tDrainMs: VTime;
	/** Fast-promote subscriber cap under hot load (cohort-topic). */
	readonly capPromoteFast: number;
}

export const DEFAULT_REACTIVITY_CONFIG: ReactivityConfig = {
	W: 256,
	Wcheckpoint: 4096,
	dedupeWindow: 64,
	queueMax: 32,
	blockFillSize: 64,
	tRejoinJitterMs: 30_000,
	tDrainMs: 60_000,
	capPromoteFast: 32
};

// --- replay ring buffer ------------------------------------------------------

/** One replayable notification (reactivity.md §Replay window `RevisionEntry`). */
export interface RevisionEntry {
	readonly revision: number;
	readonly sigDigest: string;
	readonly receivedAt: VTime;
}

/**
 * The per-cohort replay ring buffer of the last `W` notifications (reactivity.md §Replay window).
 * Holds the contiguous head window `[lowestRevision, highestRevision]`; appending past capacity
 * retires the oldest entry, which the owning `CohortPushState` rolls into the parent checkpoint.
 * Gossip across the cohort is not modeled here — every member is assumed to converge on the same
 * window, which is what lets any member serve a backfill.
 */
export class ReplayRing {
	private readonly entries: RevisionEntry[] = [];

	constructor(readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity <= 0) {
			throw new RangeError(`replay capacity must be a positive integer, got ${capacity}`);
		}
	}

	get size(): number {
		return this.entries.length;
	}

	/** Append a new head entry; returns the retired entry if capacity was exceeded, else undefined. */
	append(entry: RevisionEntry): RevisionEntry | undefined {
		this.entries.push(entry);
		if (this.entries.length > this.capacity) {
			return this.entries.shift();
		}
		return undefined;
	}

	lowestRevision(): number | undefined {
		return this.entries.length > 0 ? this.entries[0]!.revision : undefined;
	}

	highestRevision(): number | undefined {
		return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.revision : undefined;
	}

	/** Does the buffer hold `revision`? */
	covers(revision: number): boolean {
		const low = this.lowestRevision();
		const high = this.highestRevision();
		return low !== undefined && high !== undefined && revision >= low && revision <= high;
	}

	/** Entries in `[from, to]` (inclusive) — the backfill payload for a resume in-window. */
	range(from: number, to: number): RevisionEntry[] {
		return this.entries.filter((e) => e.revision >= from && e.revision <= to);
	}
}

// --- rolling parent checkpoint -----------------------------------------------

/** The parent checkpoint summary window (reactivity.md §Parent checkpoint summaries). */
export interface CheckpointWindow {
	readonly fromRevision: number;
	readonly toRevision: number;
}

/**
 * The rolling `W_checkpoint`-span parent checkpoint. It always sits *immediately below* the replay
 * ring: as revisions retire from the ring (`advanceTo(newRingLow)`), its `toRevision` rolls forward
 * to `ringLow − 1` and its `fromRevision` trails by at most `Wcheckpoint`. Empty until the first
 * revision retires from the ring.
 */
export class RollingCheckpoint {
	private from = 0;
	private to = 0;
	private populated = false;

	constructor(readonly span: number) {
		if (!Number.isInteger(span) || span <= 0) {
			throw new RangeError(`checkpoint span must be a positive integer, got ${span}`);
		}
	}

	/** Roll the checkpoint so it covers the `span` revisions just below `ringLow`. */
	advanceTo(ringLow: number): void {
		const top = ringLow - 1;
		if (top < 1) {
			return;
		}
		this.to = top;
		this.from = Math.max(1, top - this.span + 1);
		this.populated = true;
	}

	window(): CheckpointWindow | undefined {
		return this.populated ? { fromRevision: this.from, toRevision: this.to } : undefined;
	}

	covers(revision: number): boolean {
		return this.populated && revision >= this.from && revision <= this.to;
	}
}

// --- sliding dedupe window ---------------------------------------------------

/**
 * The sliding `(revision, sigDigest)` dedupe set over the last `dedupe_window` revisions
 * (reactivity.md §Per-revision dedupe). A new notification is forwarded if it is for the highest
 * revision seen, or if it is an earlier revision whose `(revision, sigDigest)` is not already in the
 * set (a retransmit closing a gap). Anything already in the set is dropped. Eviction is by revision
 * age, not insertion order, so a late retransmit of a still-in-window revision is correctly caught.
 */
export class DedupeWindow {
	private readonly seen = new Set<string>();
	private highest = -1;

	constructor(readonly windowSize: number) {
		if (!Number.isInteger(windowSize) || windowSize <= 0) {
			throw new RangeError(`dedupe window must be a positive integer, got ${windowSize}`);
		}
	}

	private static key(revision: number, sigDigest: string): string {
		return `${revision}:${sigDigest}`;
	}

	/**
	 * Admit `(revision, sigDigest)`. Returns `true` if it should be forwarded (newly seen), `false`
	 * if it is a duplicate already in the window. Forwarding records it and slides the window.
	 */
	admit(revision: number, sigDigest: string): boolean {
		const key = DedupeWindow.key(revision, sigDigest);
		if (this.seen.has(key)) {
			return false;
		}
		this.seen.add(key);
		if (revision > this.highest) {
			this.highest = revision;
		}
		this.evictBelow(this.highest - this.windowSize + 1);
		return true;
	}

	has(revision: number, sigDigest: string): boolean {
		return this.seen.has(DedupeWindow.key(revision, sigDigest));
	}

	private evictBelow(cutoff: number): void {
		if (cutoff <= 0) {
			return;
		}
		for (const key of this.seen) {
			const rev = Number(key.slice(0, key.indexOf(':')));
			if (rev < cutoff) {
				this.seen.delete(key);
			}
		}
	}
}

// --- cohort push state -------------------------------------------------------

/** Outcome of ingesting a notification at a forwarder cohort. */
export type IngestVerdict = 'forwarded' | 'duplicate';

/**
 * Per-collection forwarder-cohort notification state (reactivity.md `PushState`): the replay ring,
 * the rolling parent checkpoint, and the sliding dedupe window, wired together. `ingest` runs the
 * dedupe check, appends to the ring on a new head, and rolls retired revisions into the checkpoint —
 * the steady-state pipeline the coverage and no-thrash measurements drive.
 */
export class CohortPushState {
	readonly replay: ReplayRing;
	readonly checkpoint: RollingCheckpoint;
	readonly dedupe: DedupeWindow;
	private last = 0;

	constructor(readonly config: ReactivityConfig = DEFAULT_REACTIVITY_CONFIG) {
		this.replay = new ReplayRing(config.W);
		this.checkpoint = new RollingCheckpoint(config.Wcheckpoint);
		this.dedupe = new DedupeWindow(config.dedupeWindow);
	}

	get lastRevision(): number {
		return this.last;
	}

	/**
	 * Ingest a notification. Forwards (and buffers) a new highest revision or a gap-closing
	 * retransmit; drops a duplicate. Only a new head extends the ring and advances the checkpoint —
	 * a recovery retransmit of an older revision is forwarded but does not move the window.
	 */
	ingest(revision: number, sigDigest: string, now: VTime): IngestVerdict {
		if (!this.dedupe.admit(revision, sigDigest)) {
			return 'duplicate';
		}
		if (revision > this.last) {
			const retired = this.replay.append({ revision, sigDigest, receivedAt: now });
			if (retired !== undefined) {
				this.checkpoint.advanceTo(this.replay.lowestRevision()!);
			}
			this.last = revision;
		}
		return 'forwarded';
	}
}

// --- resume classification ---------------------------------------------------

/** Resume outcome by subscriber wake-lag / tail staleness (ticket `ResumeKind`). */
export type ResumeKind = 'Backfill' | 'CheckpointWindow' | 'OutOfWindow' | 'TailRotated';

/** One classified resume, with the RPC count and modeled latency to become current again. */
export interface ResumeTrace {
	readonly subscriber: PeerRef;
	readonly lagRevisions: number;
	readonly kind: ResumeKind;
	readonly rpcCount: number;
	readonly latency: VTime;
}

/** Per-round-trip cost model for resume latency. */
export interface ResumeCost {
	/** One cohort round trip (resume / backfill / checkpoint RPC). */
	readonly roundTripMs: VTime;
	/** Chain-read fallback cost added on `OutOfWindow`. */
	readonly chainReadMs: VTime;
	/** Round trips to re-resolve the new tree on `TailRotated` (re-register walk + replay). */
	readonly reResolveRoundTrips: number;
}

export const DEFAULT_RESUME_COST: ResumeCost = {
	roundTripMs: 2 * DEFAULT_HOP_MS,
	chainReadMs: 8 * DEFAULT_HOP_MS,
	reResolveRoundTrips: 2
};

export interface ResumeInput {
	readonly subscriber: PeerRef;
	/** Subscriber's `fromRevision` (its `lastRevision + 1`). */
	readonly fromRevision: number;
	/** Cohort's current revision. */
	readonly currentRevision: number;
	/** Tail ID the cohort is serving now. */
	readonly currentTailId: string;
	/** Tail ID the subscriber last knew (`latestKnownTailId`). */
	readonly latestKnownTailId: string;
}

/** Classify a resume by lag and tail staleness — the pure `ResumeKind` decision. */
export function classifyResume(input: ResumeInput, config: ReactivityConfig = DEFAULT_REACTIVITY_CONFIG): ResumeKind {
	if (input.latestKnownTailId !== input.currentTailId) {
		return 'TailRotated';
	}
	const lag = Math.max(0, input.currentRevision - input.fromRevision);
	if (lag < config.W) {
		return 'Backfill';
	}
	if (lag < config.W + config.Wcheckpoint) {
		return 'CheckpointWindow';
	}
	return 'OutOfWindow';
}

/** RPC count to resolve a resume of the given kind (cohort round trips + fallbacks). */
export function resumeRpcCount(kind: ResumeKind, cost: ResumeCost = DEFAULT_RESUME_COST): number {
	switch (kind) {
		case 'Backfill': return 1;
		case 'CheckpointWindow': return 1;
		case 'OutOfWindow': return 2; // resume RPC + chain read
		case 'TailRotated': return 1 + cost.reResolveRoundTrips; // stale resume redirect + re-resolve
	}
}

/** Modeled latency to become current for a resume of the given kind. */
export function resumeLatency(kind: ResumeKind, cost: ResumeCost = DEFAULT_RESUME_COST): VTime {
	switch (kind) {
		case 'Backfill': return cost.roundTripMs;
		case 'CheckpointWindow': return cost.roundTripMs;
		case 'OutOfWindow': return cost.roundTripMs + cost.chainReadMs;
		case 'TailRotated': return cost.roundTripMs + cost.reResolveRoundTrips * cost.roundTripMs;
	}
}

/** Full resume trace: classify, then attach RPC count + latency. */
export function traceResume(
	input: ResumeInput,
	config: ReactivityConfig = DEFAULT_REACTIVITY_CONFIG,
	cost: ResumeCost = DEFAULT_RESUME_COST
): ResumeTrace {
	const kind = classifyResume(input, config);
	return {
		subscriber: input.subscriber,
		lagRevisions: Math.max(0, input.currentRevision - input.fromRevision),
		kind,
		rpcCount: resumeRpcCount(kind, cost),
		latency: resumeLatency(kind, cost)
	};
}

// --- coverage-window math ----------------------------------------------------

/** Wall-clock seconds a `revisions`-deep window covers at a steady commit rate `cps`. */
export function coverageSeconds(revisions: number, cps: number): number {
	if (cps <= 0) {
		throw new RangeError(`cps must be positive, got ${cps}`);
	}
	return revisions / cps;
}

/** The two recovery windows measured at one commit rate (reactivity.md §Resume / §Parent checkpoint). */
export interface CoverageReadout {
	readonly cps: number;
	/** Backfill (`W`) coverage in seconds. */
	readonly replaySeconds: number;
	/** Checkpoint (`W_checkpoint`) coverage in seconds. */
	readonly checkpointSeconds: number;
}

export function measureCoverage(cps: number, config: ReactivityConfig = DEFAULT_REACTIVITY_CONFIG): CoverageReadout {
	return {
		cps,
		replaySeconds: coverageSeconds(config.W, cps),
		checkpointSeconds: coverageSeconds(config.Wcheckpoint, cps)
	};
}

/**
 * The adaptive-`W` finding (ticket §Coverage-window math). At a measured `cps`, does the fixed `W`
 * still cover at least `minCoverageSeconds` of recovery? If not, the buffer is too shallow for the
 * commit rate and `W` should scale up — `recommendedW` is the depth that restores the floor. This is
 * the number recorded for fold-back: at 1 cps the default `W` is comfortable; at 100 cps it covers
 * only ≈ 2.5 s, flagging adaptive `W` as warranted for hot collections.
 */
export interface AdaptiveWFinding {
	readonly cps: number;
	readonly coverageSeconds: number;
	readonly minCoverageSeconds: number;
	readonly belowFloor: boolean;
	readonly recommendedW: number;
}

export function assessAdaptiveW(
	cps: number,
	minCoverageSeconds: number,
	config: ReactivityConfig = DEFAULT_REACTIVITY_CONFIG
): AdaptiveWFinding {
	const cov = coverageSeconds(config.W, cps);
	const belowFloor = cov < minCoverageSeconds;
	return {
		cps,
		coverageSeconds: cov,
		minCoverageSeconds,
		belowFloor,
		recommendedW: belowFloor ? Math.ceil(minCoverageSeconds * cps) : config.W
	};
}

// --- no-thrash repeated-wake model -------------------------------------------

/** A repeated lag-≈-`W` wake sequence and whether it thrashed between resume kinds. */
export interface ThrashReadout {
	readonly kinds: ResumeKind[];
	/** Transitions between distinct resume kinds across the wake sequence (0 = stable). */
	readonly transitions: number;
	/** Every wake resolved in a single cohort RPC. */
	readonly allSingleRpc: boolean;
}

/**
 * Drive a subscriber that repeatedly wakes with the same lag against a continuously committing
 * cohort (reactivity.md §Failure modes: bursty commit / lag-≈-`W`). With lag held below `W`, every
 * wake must classify `Backfill` in one RPC — no flapping into `CheckpointWindow` and back (checkpoint
 * thrashing) as the head advances. Each wake's `fromRevision` tracks the head minus `lag`, exactly
 * the steady backlog a subscriber on a flaky link sees. Returns the kind sequence and a transition
 * count (0 ⇒ no thrash).
 */
export function measureRepeatedWakeThrash(opts: {
	subscriber: PeerRef;
	lag: number;
	wakes: number;
	commitsPerWake: number;
	startRevision?: number;
	config?: ReactivityConfig;
	cost?: ResumeCost;
}): ThrashReadout {
	const config = opts.config ?? DEFAULT_REACTIVITY_CONFIG;
	const cost = opts.cost ?? DEFAULT_RESUME_COST;
	const state = new CohortPushState(config);
	const tailId = 'tail-steady';
	const kinds: ResumeKind[] = [];
	let allSingleRpc = true;

	let rev = opts.startRevision ?? 1;
	// Prime the buffer so the head is well past `lag`.
	const prime = Math.max(opts.lag + 1, config.W);
	for (let i = 0; i < prime; i++, rev++) {
		state.ingest(rev, `d${rev}`, rev);
	}

	for (let w = 0; w < opts.wakes; w++) {
		for (let i = 0; i < opts.commitsPerWake; i++, rev++) {
			state.ingest(rev, `d${rev}`, rev);
		}
		const current = state.lastRevision;
		const trace = traceResume(
			{
				subscriber: opts.subscriber,
				fromRevision: current - opts.lag,
				currentRevision: current,
				currentTailId: tailId,
				latestKnownTailId: tailId
			},
			config,
			cost
		);
		kinds.push(trace.kind);
		if (trace.rpcCount !== 1) {
			allSingleRpc = false;
		}
	}

	let transitions = 0;
	for (let i = 1; i < kinds.length; i++) {
		if (kinds[i] !== kinds[i - 1]) {
			transitions++;
		}
	}
	return { kinds, transitions, allSingleRpc };
}

// --- tail-rotation re-registration burst -------------------------------------

/** The measured re-registration wave at the new tail after a rotation. */
export interface RotationBurstResult {
	readonly subscriberCount: number;
	readonly capPromoteFast: number;
	/** Peak direct subscribers ever held at the new tail's tier-0 cohort. */
	readonly peakRootDirect: number;
	/** `peakRootDirect ≤ cap_promote_fast` — the wave never piled past the fast-promote bound. */
	readonly withinCapPromoteFast: boolean;
	/** Last re-registration landed at or before `T_drain`. */
	readonly completedWithinDrain: boolean;
	/** Virtual time of the last re-registration arrival. */
	readonly lastArrivalAt: VTime;
	/** Deepest tier the new tree reached absorbing the wave. */
	readonly finalDepth: number;
}

const ROTATION_TOPIC = 'reactivity-rotation';

/**
 * Model the tail-rotation re-registration burst (reactivity.md §Tail rotation). All `subscriberCount`
 * subscribers receive the rotation hint and re-register at the new tail's tree with random jitter over
 * `T_rejoin_jitter`. The new tail cohort is under hot load (the spike *is* the load), so it
 * fast-promotes at `cap_promote_fast`: once 32 subscribers attach at the root it serves
 * `Promoted(1)` and the wave spreads to tier 1 instead of piling at the root. This confirms the new
 * tree's root never holds more than `cap_promote_fast` direct subscribers, and that the whole wave
 * lands inside `T_drain`, across subscriber populations.
 *
 * Reuses the modeled `TopicTree` with eager promotion and slope lookahead disabled: re-registration
 * is exactly a cohort-topic registration, so the same promotion machinery bounds the burst. Jittered
 * arrival *times* are on the virtual clock; with lookahead off, the root promotes exactly when it hits
 * `cap_promote_fast`, so the peak root count is deterministically that cap regardless of arrival order
 * (a lagged-promotion variant à la `routeArrival` would instead expose overshoot past the cap — a
 * separate enhancement, see the burst test notes).
 */
export function simulateRotationBurst(opts: {
	subscriberCount: number;
	config?: ReactivityConfig;
	seed?: number;
	gossipRoundMs?: VTime;
}): RotationBurstResult {
	const config = opts.config ?? DEFAULT_REACTIVITY_CONFIG;
	if (!Number.isInteger(opts.subscriberCount) || opts.subscriberCount < 0) {
		throw new RangeError(`subscriberCount must be a non-negative integer, got ${opts.subscriberCount}`);
	}
	const gossipRoundMs = opts.gossipRoundMs ?? 1000;
	const F = DEFAULT_LIFECYCLE_CONFIG.F;
	// Slope-based pre-promotion (`T_promote_lookahead`) is disabled for this burst: under the steep
	// re-registration ramp it would fire after the second arrival and promote the root far below
	// `cap_promote_fast`, so the hot-bucket fast-promote at 32 — the mechanism this burst exists to
	// validate (reactivity.md §Failure modes: many subscribers, sudden interest spike) — would never be
	// the binding trigger. With lookahead off, the root fills to exactly `cap_promote_fast` and promotes
	// there, making the bound a real check rather than a vacuously-satisfied one.
	const lifecycle: LifecycleConfig = {
		...DEFAULT_LIFECYCLE_CONFIG,
		capPromoteFast: config.capPromoteFast,
		tPromoteLookaheadMs: 0
	};
	const world = createSimWorld({ seed: opts.seed ?? 1, gossipRoundMs });
	const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs, config: lifecycle });

	const expected = expectedDepth(opts.subscriberCount, F, lifecycle.capPromote);
	const dMax = expected + 2;
	const rootCoord = uniformLadder(0, dMax, F)[0]!;

	// The spike is hot load on the new tail's root: mark its tier-0 bucket overloaded so the
	// cohort-topic fast-promote (cap_promote_fast) engages instead of the slow cap_promote.
	const root = tree.ensure(ROTATION_TOPIC, bytesToHex(rootCoord), 0, 0);
	tree.setLoadBucket(root, 0, lifecycle.bucketOverload, 0);

	let peakRootDirect = 0;
	let lastArrivalAt = 0;
	const jitter = world.rng.fork('rejoin-jitter');

	for (let i = 0; i < opts.subscriberCount; i++) {
		const at = jitter.nextInt(config.tRejoinJitterMs);
		const index = i;
		world.scheduler.scheduleAt(at, () => {
			tree.register(ROTATION_TOPIC, uniformLadder(index, dMax, F), world.scheduler.now());
			if (root.directParticipants > peakRootDirect) {
				peakRootDirect = root.directParticipants;
			}
			lastArrivalAt = world.scheduler.now();
		});
	}

	world.scheduler.run(config.tDrainMs);

	return {
		subscriberCount: opts.subscriberCount,
		capPromoteFast: config.capPromoteFast,
		peakRootDirect,
		withinCapPromoteFast: peakRootDirect <= config.capPromoteFast,
		completedWithinDrain: lastArrivalAt <= config.tDrainMs,
		lastArrivalAt,
		finalDepth: tree.maxOccupiedTier(ROTATION_TOPIC)
	};
}
