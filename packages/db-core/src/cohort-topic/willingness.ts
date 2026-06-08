/**
 * Cohort-topic substrate — per-member willingness / admission control.
 *
 * Transcribed from `docs/cohort-topic.md` §Willingness and §Tier ladder, folded back from the
 * simulator-validated `packages/substrate-simulator/src/{willingness,backoff}.ts`. When FRET's
 * `RouteAndMaybeAct` lands a `RegisterV1` on a member, that member runs this check and returns one
 * of three outcomes:
 *
 * - **{@link AcceptedOutcome}** — the routed member is willing; it becomes `primary`.
 * - **{@link UnwillingMemberOutcome}** — the routed member is personally unwilling, but the gossiped
 *   willingness vector says siblings will serve this tier; the caller retries a named sibling at the
 *   *same* coord (spatial move within the cohort).
 * - **{@link UnwillingCohortOutcome}** — fewer than a quorum of members are willing to serve the
 *   tier, so the cohort declines the tier entirely; the caller backs off in *time* (no spatial
 *   move — see §Why the caller doesn't walk on UnwillingCohort). The `retryAfterMs` follows the
 *   capped-doubling curve in {@link backoffRetryMs}.
 *
 * A member's *live* willingness for a tier is: its profile serves the tier, the tier's load bucket
 * is below `overloadBucket`, **and** it is under its per-tier primary-topic budget. The coarse 1-bit
 * gossiped willingness vector ({@link selfWillingnessBits}) carries only profile-∧-load — the budget
 * is a per-registration gate applied live at the routed member. (Resolved open question: willingness
 * stays at **1 bit per tier** — no finer T3 gradations; the load bucket already supplies coarse load.)
 */

import { createLoadBarometer, DEFAULT_OVERLOAD_BUCKET, type LoadBarometerState } from "./load/barometer.js";
import type { CohortView } from "./gossip/view.js";
import { b64urlToBytes } from "./wire/codec.js";
import type { RegisterV1 } from "./wire/types.js";
import { ALL_TIERS, type NodeProfile, type Tier } from "./tiers.js";

/** The routed member is willing and will serve as `primary`. */
export interface AcceptedOutcome {
	readonly kind: "accepted";
}

/** Routed member unwilling; these siblings (raw peer-id bytes) will serve — retry one at the same coord. */
export interface UnwillingMemberOutcome {
	readonly kind: "unwilling_member";
	readonly candidateMembers: Uint8Array[];
}

/** No quorum of willing members; back off `retryAfterMs` in time and retry from `d_max`. */
export interface UnwillingCohortOutcome {
	readonly kind: "unwilling_cohort";
	readonly retryAfterMs: number;
}

export type WillingnessOutcome = AcceptedOutcome | UnwillingMemberOutcome | UnwillingCohortOutcome;

/** Per-member willingness / admission check. */
export interface WillingnessCheck {
	/** Classify `reg` routed onto this member, given the member's static profile and the clock. */
	evaluate(reg: RegisterV1, self: NodeProfile, now: number): WillingnessOutcome;
}

// --- willingness-vector bit packing (folded back from simulator `willingnessBits`) ---

/** Test bit `tier` (T0 = bit 0 … T3 = bit 3) of a packed 4-bit willingness vector. */
export function tierBit(bits: number, tier: Tier): boolean {
	return (bits & (1 << tier)) !== 0;
}

/** Pack a per-tier predicate into a 4-bit willingness vector (bit `t` set iff `willing(t)`). */
export function packWillingnessBits(willing: (tier: Tier) => boolean): number {
	let bits = 0;
	for (const t of ALL_TIERS) {
		if (willing(t)) bits |= 1 << t;
	}
	return bits;
}

/** The packed vector as a single hex nibble — the `CohortGossipV1.willingnessBits` wire form. */
export function willingnessBitsHex(bits: number): string {
	return (bits & 0xf).toString(16);
}

/**
 * This member's gossiped (coarse) willingness vector: bit `t` set iff the profile serves `t` and the
 * tier is not shed under load. The per-tier primary-topic budget is deliberately **not** folded in
 * — it is a live per-registration gate, not a gossiped signal (§Willingness: the gossiped vector is
 * "one bit per tier per member… refreshed every gossip round").
 */
export function selfWillingnessBits(self: NodeProfile, barometer: LoadBarometerState): number {
	return packWillingnessBits((t) => self.willingTiers.has(t) && barometer.loadWilling(t));
}

// --- exponential UnwillingCohort back-off (settled params, docs §Willingness L260-263) ---

export interface BackoffConfig {
	/** First-rejection delay (ms). Default 1000. */
	readonly baseMs: number;
	/** Geometric growth per rejection. Default 2 (doubling). */
	readonly factor: number;
	/** Hard ceiling on a single delay (ms). Default 60000. */
	readonly capMs: number;
}

/** Settled back-off curve (`docs/cohort-topic.md` §Willingness): `base = 1 s`, `factor = 2`, `cap = 60 s`. */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
	baseMs: 1000,
	factor: 2,
	capMs: 60_000,
};

/**
 * `retryAfter` for the `attempt`-th rejection (0-based): `⌊base · factor^attempt⌋` capped at `capMs`.
 * The capped doubling bounds the rejections a participant suffers across an overload window at
 * `O(log(window/base))` (≤ ~6 to span 60 s) rather than the `window/base` a fixed interval incurs.
 * As survivors of a burst back off geometrically, offered load sheds and accepted/sec holds at the
 * willing-quorum capacity without a cascade.
 */
export function backoffRetryMs(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF_CONFIG): number {
	if (!Number.isInteger(attempt) || attempt < 0) {
		throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
	}
	const raw = config.baseMs * Math.pow(config.factor, attempt);
	return Math.min(Math.floor(raw), config.capMs);
}

// --- willingness check ---

export interface WillingnessConfig {
	/** Cohort size `k` (drives the default quorum). Default 16. */
	cohortSize?: number;
	/**
	 * Members that must be willing to serve a tier for the cohort to take it on. Default: strict
	 * majority of `cohortSize` (`⌊k/2⌋ + 1`). Not pinned by `docs/cohort-topic.md` — §Tier ladder
	 * only requires "a quorum"; configurable here, revisitable by the Edge/Core policy ticket.
	 */
	quorum?: number;
	/** Load bucket at/above which a tier is shed. Default {@link DEFAULT_OVERLOAD_BUCKET} (6). */
	overloadBucket?: number;
	/**
	 * Max topics this member may be `primary` for at a single tier. Default 2048 (`topics_max`).
	 * The doc names the per-member per-tier budget but pins no number; configurable here.
	 */
	maxPrimaryTopicsPerTier?: number;
	/** Back-off curve for `unwilling_cohort` retries. Default {@link DEFAULT_BACKOFF_CONFIG}. */
	backoff?: BackoffConfig;
}

export interface WillingnessDeps {
	/** This member's own per-tier load barometer (live willingness uses its buckets). */
	barometer: LoadBarometerState;
	/** Merged per-member gossip view — the sibling willingness vectors. */
	view: CohortView;
	/** This member's own id, base64url (the `fromMember` key) — excluded from the sibling scan. */
	selfMember: string;
	/** Count of topics this member is already `primary` for at `tier` (the budget gate input). */
	primaryTopicCount: (tier: Tier) => number;
	/**
	 * Rejection-attempt count for `reg`, driving the `retryAfter` curve. The anti-DoS rate limiter
	 * owns the counter; the *curve* lives here. Default `() => 0` (first-rejection delay).
	 */
	attempts?: (reg: RegisterV1) => number;
	config?: WillingnessConfig;
}

/** Default quorum: strict majority of the cohort. */
export function defaultQuorum(cohortSize: number): number {
	return Math.floor(cohortSize / 2) + 1;
}

class GossipWillingnessCheck implements WillingnessCheck {
	private readonly quorum: number;
	private readonly overloadBucket: number;
	private readonly maxPrimaryTopicsPerTier: number;
	private readonly backoff: BackoffConfig;
	private readonly attempts: (reg: RegisterV1) => number;

	constructor(private readonly deps: WillingnessDeps) {
		const cfg = deps.config ?? {};
		const cohortSize = cfg.cohortSize ?? 16;
		this.quorum = cfg.quorum ?? defaultQuorum(cohortSize);
		this.overloadBucket = cfg.overloadBucket ?? DEFAULT_OVERLOAD_BUCKET;
		this.maxPrimaryTopicsPerTier = cfg.maxPrimaryTopicsPerTier ?? 2048;
		this.backoff = cfg.backoff ?? DEFAULT_BACKOFF_CONFIG;
		this.attempts = deps.attempts ?? ((): number => 0);
	}

	evaluate(reg: RegisterV1, self: NodeProfile, now: number): WillingnessOutcome {
		const tier = reg.tier as Tier;
		if (!ALL_TIERS.includes(tier)) {
			// An op tier outside T0..T3 is not serviceable; treat as a cohort-level decline.
			return { kind: "unwilling_cohort", retryAfterMs: backoffRetryMs(this.attempts(reg), this.backoff) };
		}

		const selfWilling = this.selfLiveWilling(self, tier);
		const siblings = this.willingSiblings(tier);
		const willingCount = siblings.length + (selfWilling ? 1 : 0);

		// Quorum gate (§Tier ladder): the cohort takes on tier-T duties only if a quorum of members
		// is willing; otherwise registrations get UnwillingCohort and the caller backs off in time.
		if (willingCount < this.quorum) {
			return { kind: "unwilling_cohort", retryAfterMs: backoffRetryMs(this.attempts(reg), this.backoff) };
		}
		if (selfWilling) {
			return { kind: "accepted" };
		}
		// Quorum holds and self is unwilling → some sibling will serve.
		return { kind: "unwilling_member", candidateMembers: siblings.map((m) => b64urlToBytes(m)) };
	}

	/** Live willingness of *this* member for `tier`: profile ∧ load-under-threshold ∧ under budget. */
	private selfLiveWilling(self: NodeProfile, tier: Tier): boolean {
		return (
			self.willingTiers.has(tier) &&
			this.deps.barometer.bucket(tier) < this.overloadBucket &&
			this.deps.primaryTopicCount(tier) < this.maxPrimaryTopicsPerTier
		);
	}

	/** Sibling member keys (base64url) whose *gossiped* willingness vector serves `tier`. */
	private willingSiblings(tier: Tier): string[] {
		const out: string[] = [];
		for (const [member, contribution] of this.deps.view.all()) {
			if (member === this.deps.selfMember) continue; // self counted via live willingness
			if (tierBit(contribution.willingness, tier)) {
				out.push(member);
			}
		}
		return out;
	}
}

/** Build a {@link WillingnessCheck} over the injected barometer + gossip view + budget source. */
export function createWillingnessCheck(deps: WillingnessDeps): WillingnessCheck {
	return new GossipWillingnessCheck(deps);
}

/** Convenience: a willingness check with a fresh idle barometer (tests / single-tier callers). */
export function createWillingnessCheckWithIdleBarometer(
	deps: Omit<WillingnessDeps, "barometer">,
): { check: WillingnessCheck; barometer: LoadBarometerState } {
	const barometer = createLoadBarometer({ overloadBucket: deps.config?.overloadBucket });
	return { check: createWillingnessCheck({ ...deps, barometer }), barometer };
}
