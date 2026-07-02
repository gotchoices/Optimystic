/**
 * Cohort-topic substrate — promotion / demotion lifecycle.
 *
 * Transcribed from `docs/cohort-topic.md` §Promotion and demotion lifecycle and folded back from the
 * simulator-validated `packages/substrate-simulator/src/topic-tree.ts`. A forwarder cohort grows
 * (promotes) and shrinks (demotes) for a topic `T` based on its per-topic direct-participant count
 * and the per-tier load barometer; both transitions are **threshold-signed** (via the gossip ticket's
 * {@link CohortSigner}) so participants can verify them.
 *
 * **Promote** when, for a quorum (the quorum is enforced by the threshold signature — `minSigs`
 * signers must agree to the notice):
 * - `directParticipants(T) ≥ cap_promote` (64), OR
 * - `loadBucket[tier(T)] ≥ bucket_overload` (6) AND `directParticipants(T) ≥ cap_promote_fast` (32)
 *   — the hot-load fast path from the capacity-barometer ticket, OR
 * - the growth **slope** predicts crossing `cap_promote` within `T_promote_lookahead` (30s) — fires
 *   early to avoid the gossip-lag overshoot (`§Promotion`: pre-promotion on slope).
 *
 * Once promoted, the state is **sticky** for ≥ `T_promote_sticky` (60s) before it can be reconsidered
 * for demotion, so transient count drops don't flap a cohort back to accepting.
 *
 * **Demote** when, for a quorum: `directParticipants(T) ≤ cap_demote` (16) AND that has held for
 * ≥ `T_demote` (5min) AND the cohort has no live child cohorts AND it has a parent (the root, tree
 * tier 0, never demotes — it has nowhere to hand off). The `4×` gap between `cap_promote` and
 * `cap_demote` plus `T_demote` is the hysteresis that prevents thrash.
 *
 * **Deviation from the doc's interface sketch (documented).** `docs/cohort-topic.md` sketches
 * `onParticipantCountChange` as returning `void` and "may emit `PromotionNoticeV1`". Because
 * threshold signing is asynchronous ({@link CohortSigner.thresholdSign} resolves a Promise), the
 * methods here are `async` and **return** the signed notice (or `undefined`) instead of emitting it
 * through a side channel — the caller broadcasts whatever it gets back. This keeps the module pure
 * and unit-testable and avoids an awkward async callback. The op-tier `tier(T)` the barometer is
 * indexed by is supplied through the injected {@link PromotionDeps.loadBucket} resolver, so this
 * module never needs to know a topic's tier.
 *
 * **Remote apply path.** `promote()` / `demote()` set this cohort's per-topic state as a side effect of
 * the **local** signing path — only the member that originates a notice adopts the new state that way. A
 * member that *learns* of a promotion/demotion via gossip or a broadcast notice adopts it through
 * {@link PromotionLifecycle.applyPromotionNotice} / {@link PromotionLifecycle.applyDemotionNotice},
 * which set the same {@link PromotionState} **without re-signing** (the notice is already a verified
 * quorum decision). **Precondition: the caller has already verified the notice's threshold signature**
 * (db-p2p's `MembershipVerifier`); this module is crypto-free and trusts that gate. The apply path is
 * idempotent and `effectiveAt`-ordered via the monotonic {@link PromotionState.lastEffectiveAt}
 * high-water mark, so re-applying a notice (including this member's own echoed broadcast) or a replayed
 * older notice is a no-op — a stale promotion can never un-demote a cohort that has since demoted.
 */

import { b64urlToBytes, bytesToB64url } from "./wire/codec.js";
import type { CohortSigner } from "./sig/threshold.js";
import { demotionNoticeSigningPayload, promotionNoticeSigningPayload } from "./sig/payloads.js";
import type { DemotionNoticeV1, PromotionNoticeV1 } from "./wire/types.js";
import type { RegistrationStore } from "./registration/types.js";
import { bytesKey } from "./registration/bytes.js";

// --- defaults (docs/cohort-topic.md §Configuration; simulator-confirmed) ---

/** Direct-participant cap before promotion. */
export const DEFAULT_CAP_PROMOTE = 64;
/** Direct-participant cap when the load barometer is hot (fast path). */
export const DEFAULT_CAP_PROMOTE_FAST = 32;
/** Load-barometer bucket at/above which the fast promote path is armed. */
export const DEFAULT_BUCKET_OVERLOAD = 6;
/** Direct-participant floor for demotion (= `cap_promote / 4`). */
export const DEFAULT_CAP_DEMOTE = 16;
/** Hysteresis window the low-load condition must hold before demotion (ms). */
export const DEFAULT_T_DEMOTE_MS = 300_000;
/** Pre-promotion slope lookahead (ms). */
export const DEFAULT_T_PROMOTE_LOOKAHEAD_MS = 30_000;
/** Minimum time a cohort stays promoted before it can be reconsidered for demotion (ms). */
export const DEFAULT_T_PROMOTE_STICKY_MS = 60_000;
/**
 * Slope window over which the growth rate is measured for pre-promotion. **Not pinned by
 * `docs/cohort-topic.md`** — the simulator (`topic-tree.ts` `DEFAULT_LIFECYCLE_CONFIG`) uses 10s and
 * this matches it.
 */
export const DEFAULT_GROWTH_WINDOW_MS = 10_000;

export interface PromotionConfig {
	capPromote?: number;
	capPromoteFast?: number;
	bucketOverload?: number;
	capDemote?: number;
	tDemoteMs?: number;
	tPromoteLookaheadMs?: number;
	tPromoteStickyMs?: number;
	growthWindowMs?: number;
}

/** A sampled `(time, count)` growth point, for slope-based pre-promotion. */
interface GrowthSample {
	readonly t: number;
	readonly count: number;
}

/** Per-topic promotion bookkeeping held by this cohort. */
interface PromotionState {
	promoted: boolean;
	/** When the cohort last entered promoted mode (sticky-window anchor). */
	promotedAt?: number;
	/** When `directParticipants` last dropped to ≤ `cap_demote` (demotion hysteresis anchor). */
	lowLoadSince?: number;
	/** Recent growth samples within `growthWindowMs`, for slope extrapolation. */
	samples: GrowthSample[];
	/**
	 * `effectiveAt` of the most recent promotion/demotion this cohort has adopted — locally originated
	 * (`promote()` / `demote()`) or remotely applied (`applyPromotionNotice` / `applyDemotionNotice`).
	 * Monotonic and **never cleared** (a demotion clears `promoted`/`promotedAt` but keeps this), so it
	 * is the high-water mark the remote-apply path orders against: a notice whose `effectiveAt` is not
	 * strictly newer is a no-op — re-applied (incl. this member's own echoed broadcast) or stale-replayed.
	 */
	lastEffectiveAt?: number;
}

export interface PromotionDeps {
	/** Replicated registration store — supplies the per-topic `directParticipants` stock count. */
	store: Pick<RegistrationStore, "directParticipants">;
	/**
	 * Current load-barometer bucket (0..7) for the topic's op tier `tier(T)`. The caller resolves the
	 * topic→tier mapping and the barometer lookup, keeping this module tier-agnostic and FRET-free.
	 */
	loadBucket: (topicId: Uint8Array) => number;
	/** Live child-cohort count for the topic (0 if none); `> 0` blocks demotion. */
	childCohortCount: (topicId: Uint8Array) => number;
	/** Tree tier `d` this cohort serves the topic at — `fromTier` on a notice; `toTier = d + 1`. */
	treeTier: (topicId: Uint8Array) => number;
	/** The tier-`(d − 1)` parent cohort coord, target of a {@link DemotionNoticeV1}. */
	parentCoord: (topicId: Uint8Array) => Uint8Array;
	/**
	 * The served coord `coord_d(participantCoord, topicId)` this cohort sits at (raw bytes) — stamped on
	 * every notice as `cohortCoord` and covered by its threshold signature, so a receiver routes the notice
	 * to exactly this cohort's engine and verifies it against exactly this cohort's cert. Constant for the
	 * engine's lifetime (the engine is instantiated at one served coord).
	 */
	cohortCoord: () => Uint8Array;
	/** Cohort epoch (raw bytes) the notices are signed under. */
	cohortEpoch: () => Uint8Array;
	/** Threshold signer (the gossip ticket's `k − x` cohort signer). */
	signer: CohortSigner;
	config?: PromotionConfig;
}

/**
 * Promotion / demotion lifecycle for one cohort across all the topics it serves. Keyed by `topicId`;
 * each topic carries its own promoted/low-load/sticky state.
 */
export interface PromotionLifecycle {
	/**
	 * React to a change in `topicId`'s direct-participant count (call after every arrival/eviction).
	 * Refreshes the growth + hysteresis clocks and, if a promote trigger fires and the cohort is not
	 * already promoted, threshold-signs and returns a {@link PromotionNoticeV1}. Returns `undefined`
	 * when no promotion fires.
	 */
	onParticipantCountChange(topicId: Uint8Array, now: number): Promise<PromotionNoticeV1 | undefined>;
	/**
	 * Time-driven demotion check (call on the gossip tick). Returns a threshold-signed
	 * {@link DemotionNoticeV1} for the parent when every demotion condition holds, else `undefined`.
	 */
	maybeDemote(topicId: Uint8Array, now: number): Promise<DemotionNoticeV1 | undefined>;
	/** Whether `topicId` is currently in promoted mode (new registrations get `Promoted(d+1)`). */
	isPromoted(topicId: Uint8Array): boolean;
	/**
	 * Adopt a promotion this member did **not** originate (learned via a verified broadcast notice).
	 * Sets `promoted = true` for `n.topicId` without re-signing. **Precondition: the caller has verified
	 * `n`'s threshold signature** — this module performs no crypto. Idempotent and `effectiveAt`-ordered
	 * (see {@link PromotionState.lastEffectiveAt}): a notice not strictly newer than the last adopted
	 * transition is a no-op, so this member's own echoed broadcast and stale replays are absorbed.
	 */
	applyPromotionNotice(n: PromotionNoticeV1, now: number): void;
	/**
	 * Adopt a demotion this member did **not** originate (learned via a verified broadcast notice).
	 * Clears `promoted` state for `n.topicId` without re-signing. Same precondition, idempotency, and
	 * `effectiveAt` ordering as {@link applyPromotionNotice} — a stale promotion can never un-demote.
	 */
	applyDemotionNotice(n: DemotionNoticeV1, now: number): void;
}

class CohortPromotionLifecycle implements PromotionLifecycle {
	private readonly states = new Map<string, PromotionState>();
	private readonly capPromote: number;
	private readonly capPromoteFast: number;
	private readonly bucketOverload: number;
	private readonly capDemote: number;
	private readonly tDemoteMs: number;
	private readonly tPromoteLookaheadMs: number;
	private readonly tPromoteStickyMs: number;
	private readonly growthWindowMs: number;

	constructor(private readonly deps: PromotionDeps) {
		const cfg = deps.config ?? {};
		this.capPromote = cfg.capPromote ?? DEFAULT_CAP_PROMOTE;
		this.capPromoteFast = cfg.capPromoteFast ?? DEFAULT_CAP_PROMOTE_FAST;
		this.bucketOverload = cfg.bucketOverload ?? DEFAULT_BUCKET_OVERLOAD;
		this.capDemote = cfg.capDemote ?? DEFAULT_CAP_DEMOTE;
		this.tDemoteMs = cfg.tDemoteMs ?? DEFAULT_T_DEMOTE_MS;
		this.tPromoteLookaheadMs = cfg.tPromoteLookaheadMs ?? DEFAULT_T_PROMOTE_LOOKAHEAD_MS;
		this.tPromoteStickyMs = cfg.tPromoteStickyMs ?? DEFAULT_T_PROMOTE_STICKY_MS;
		this.growthWindowMs = cfg.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS;
	}

	async onParticipantCountChange(topicId: Uint8Array, now: number): Promise<PromotionNoticeV1 | undefined> {
		const state = this.stateFor(topicId);
		const count = this.deps.store.directParticipants(topicId);
		this.pushGrowthSample(state, count, now);
		this.refreshLowLoadClock(state, count, now);
		if (state.promoted) {
			return undefined; // already promoted — sticky until a demotion clears it
		}
		if (!this.promotionTriggered(topicId, state, count, now)) {
			return undefined;
		}
		return this.promote(topicId, state, now);
	}

	async maybeDemote(topicId: Uint8Array, now: number): Promise<DemotionNoticeV1 | undefined> {
		const state = this.states.get(bytesKey(topicId));
		if (state === undefined) {
			return undefined;
		}
		if (!this.demotionTriggered(topicId, state, now)) {
			return undefined;
		}
		return this.demote(topicId, state, now);
	}

	isPromoted(topicId: Uint8Array): boolean {
		return this.states.get(bytesKey(topicId))?.promoted ?? false;
	}

	// --- remote apply (verified notices this member did not originate) ---

	applyPromotionNotice(n: PromotionNoticeV1, now: number): void {
		const state = this.stateFor(b64urlToBytes(n.topicId));
		if (!this.isNewerTransition(state, n.effectiveAt)) {
			return; // already adopted, our own echoed broadcast, or a stale replay
		}
		state.promoted = true;
		state.promotedAt = now;
		state.lastEffectiveAt = n.effectiveAt;
	}

	applyDemotionNotice(n: DemotionNoticeV1, _now: number): void {
		const state = this.stateFor(b64urlToBytes(n.topicId));
		if (!this.isNewerTransition(state, n.effectiveAt)) {
			return;
		}
		// Mirror the local demote() release so a later re-growth re-evaluates cleanly.
		state.promoted = false;
		state.promotedAt = undefined;
		state.lowLoadSince = undefined;
		state.lastEffectiveAt = n.effectiveAt;
	}

	/** A notice is adopted only if strictly newer than the last transition we adopted (the high-water mark). */
	private isNewerTransition(state: PromotionState, effectiveAt: number): boolean {
		return state.lastEffectiveAt === undefined || effectiveAt > state.lastEffectiveAt;
	}

	// --- promotion ---

	private promotionTriggered(topicId: Uint8Array, state: PromotionState, count: number, now: number): boolean {
		if (count >= this.capPromote) {
			return true;
		}
		if (this.deps.loadBucket(topicId) >= this.bucketOverload && count >= this.capPromoteFast) {
			return true;
		}
		return this.slopePredictsCrossing(state, count, now);
	}

	/** Linear extrapolation over the growth window: will `directParticipants` cross `cap_promote` within lookahead? */
	private slopePredictsCrossing(state: PromotionState, count: number, now: number): boolean {
		const samples = state.samples;
		if (samples.length < 2) {
			return false;
		}
		const first = samples[0]!;
		const last = samples[samples.length - 1]!;
		const span = last.t - first.t;
		if (span <= 0) {
			return false;
		}
		const slope = (last.count - first.count) / span; // participants per ms
		if (slope <= 0) {
			return false;
		}
		const predicted = count + slope * this.tPromoteLookaheadMs;
		return predicted >= this.capPromote;
	}

	private async promote(topicId: Uint8Array, state: PromotionState, now: number): Promise<PromotionNoticeV1> {
		const fromTier = this.deps.treeTier(topicId);
		const topicB64 = bytesToB64url(topicId);
		const epochB64 = bytesToB64url(this.deps.cohortEpoch());
		const cohortB64 = bytesToB64url(this.deps.cohortCoord());
		const signable = { topicId: topicB64, fromTier, toTier: fromTier + 1, effectiveAt: now, cohortEpoch: epochB64, cohortCoord: cohortB64 };
		const { thresholdSig, signers } = await this.deps.signer.thresholdSign(promotionNoticeSigningPayload(signable));
		state.promoted = true;
		state.promotedAt = now;
		state.lastEffectiveAt = now; // local effectiveAt — so our own echoed broadcast applies as a no-op
		return {
			v: 1,
			topicId: topicB64,
			fromTier,
			toTier: fromTier + 1,
			cohortCoord: cohortB64,
			effectiveAt: now,
			thresholdSig: bytesToB64url(thresholdSig),
			signers: signers.map(bytesToB64url),
			cohortEpoch: epochB64,
		};
	}

	// --- demotion ---

	private demotionTriggered(topicId: Uint8Array, state: PromotionState, now: number): boolean {
		// The root (tree tier 0) has no parent to hand off to — it never demotes.
		if (this.deps.treeTier(topicId) <= 0) {
			return false;
		}
		// Sticky: a freshly-promoted cohort holds promoted mode through transient drops.
		if (state.promoted && state.promotedAt !== undefined && now - state.promotedAt < this.tPromoteStickyMs) {
			return false;
		}
		// Never collapse a cohort that still has live children beneath it.
		if (this.deps.childCohortCount(topicId) > 0) {
			return false;
		}
		if (this.deps.store.directParticipants(topicId) > this.capDemote) {
			return false;
		}
		if (state.lowLoadSince === undefined) {
			return false;
		}
		return now - state.lowLoadSince >= this.tDemoteMs;
	}

	private async demote(topicId: Uint8Array, state: PromotionState, now: number): Promise<DemotionNoticeV1> {
		const tier = this.deps.treeTier(topicId);
		const topicB64 = bytesToB64url(topicId);
		const epochB64 = bytesToB64url(this.deps.cohortEpoch());
		const parentB64 = bytesToB64url(this.deps.parentCoord(topicId));
		const cohortB64 = bytesToB64url(this.deps.cohortCoord());
		const signable = { topicId: topicB64, tier, parentCohortCoord: parentB64, effectiveAt: now, cohortEpoch: epochB64, cohortCoord: cohortB64 };
		const { thresholdSig, signers } = await this.deps.signer.thresholdSign(demotionNoticeSigningPayload(signable));
		// Release forwarder state: a demoted cohort leaves promoted mode and resets its clocks so a
		// later re-growth re-evaluates cleanly.
		// NOTE: demotion currently resets only the promoted-bounce clocks; it does NOT stop the node serving
		// the topic — the cold-start forwarder, the direct-participant records, and the budget slot all stay,
		// and the cohort keeps serving at tier d. If demotion is ever made to actually collapse local tier
		// state, it must reassign or drain the topic's records FIRST, then `coldStart.remove` + release the
		// budget slot + `traffic.forget`, in that order — removing the forwarder while records remain re-creates
		// the off-budget-serving drift fixed in `cohort-topic-coldstart-forwarder-reconcile` (the budget stops
		// bounding the served-topic set). The eviction path already reconciles all three via `TopicBudget.onEvict`.
		state.promoted = false;
		state.promotedAt = undefined;
		state.lowLoadSince = undefined;
		state.lastEffectiveAt = now; // local effectiveAt — so our own echoed broadcast applies as a no-op
		return {
			v: 1,
			topicId: topicB64,
			tier,
			parentCohortCoord: parentB64,
			cohortCoord: cohortB64,
			effectiveAt: now,
			thresholdSig: bytesToB64url(thresholdSig),
			signers: signers.map(bytesToB64url),
			cohortEpoch: epochB64,
		};
	}

	// --- bookkeeping ---

	private stateFor(topicId: Uint8Array): PromotionState {
		const key = bytesKey(topicId);
		let state = this.states.get(key);
		if (state === undefined) {
			state = { promoted: false, samples: [] };
			this.states.set(key, state);
		}
		return state;
	}

	private pushGrowthSample(state: PromotionState, count: number, now: number): void {
		state.samples.push({ t: now, count });
		const cutoff = now - this.growthWindowMs;
		while (state.samples.length > 1 && state.samples[0]!.t < cutoff) {
			state.samples.shift();
		}
	}

	private refreshLowLoadClock(state: PromotionState, count: number, now: number): void {
		if (count <= this.capDemote) {
			state.lowLoadSince ??= now;
		} else {
			state.lowLoadSince = undefined;
		}
	}
}

/** Build a {@link PromotionLifecycle} over the injected store, barometer resolver, and signer. */
export function createPromotionLifecycle(deps: PromotionDeps): PromotionLifecycle {
	return new CohortPromotionLifecycle(deps);
}
