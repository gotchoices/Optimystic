/**
 * Cohort-topic substrate — tier ladder (T0–T3) and node profiles (Edge / Core).
 *
 * Transcribed from `docs/cohort-topic.md` §Tier ladder. This module encodes only the **static**
 * tier classes, the Edge/Core profiles, and the per-node override surface. The decline-policy
 * *behavior* (T0 never declined while serving, T3 declined freely) and the Edge runtime overrides
 * (`ttl = 60s`, `ping_interval = 20s`, sticky-cached backups) are willingness/TTL concerns owned by
 * later tickets — only the profile *flags* (which tiers a node is willing to forward) live here.
 */

/**
 * System-wide capacity tier, in priority order (T0 essential … T3 luxury).
 *
 * Modeled as a frozen const-object + value-union type rather than a TS `enum`: db-core's test
 * runner uses Node's native type-stripping, which rejects `enum` (non-erasable syntax). The object
 * carries the named members (`Tier.T0`), the type alias carries the value union (`0 | 1 | 2 | 3`).
 *
 * - **T0 — essential**: transaction commit, block production, threshold-sig contribution.
 * - **T1 — correctness-supporting**: chain serving, replay-window storage, partition heal.
 * - **T2 — functional**: matchmaking/voting directories, capability discovery, capacity gossip.
 * - **T3 — luxury**: reactivity push forwarding, anticipatory warm-up, optional delta payloads.
 */
export const Tier = { T0: 0, T1: 1, T2: 2, T3: 3 } as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

/** All four tiers, ascending — useful for iteration and override validation. */
export const ALL_TIERS: readonly Tier[] = [Tier.T0, Tier.T1, Tier.T2, Tier.T3];

/**
 * A node's static tier classification. `willingTiers` is the set of tiers this node will take on
 * *forwarder* roles for; cohort assembly under FRET is tier-blind, so this is the per-node gate the
 * willingness check consults. Edge: `{T0, T1}`; Core: `{T0, T1, T2, T3}` (operator-narrowable).
 */
export interface NodeProfile {
	readonly kind: "edge" | "core";
	readonly willingTiers: ReadonlySet<Tier>;
}

/** Per-node operator override surface. Currently the willing-tier set; widened by later tickets. */
export interface NodeProfileOverrides {
	/**
	 * Restrict the willing-tier set. Tiers outside the profile's base set are ignored (Edge can never
	 * be widened to T2/T3 via override — that is a hardware/policy class, not a knob).
	 */
	willingTiers?: Iterable<Tier>;
}

const EDGE_BASE_TIERS: readonly Tier[] = [Tier.T0, Tier.T1];
const CORE_BASE_TIERS: readonly Tier[] = ALL_TIERS;

/** Intersect a requested override set with the profile's base tiers (override can only narrow). */
function resolveWillingTiers(base: readonly Tier[], overrides?: NodeProfileOverrides): ReadonlySet<Tier> {
	if (!overrides?.willingTiers) {
		return new Set(base);
	}
	const requested = new Set(overrides.willingTiers);
	return new Set(base.filter((t) => requested.has(t)));
}

/**
 * Edge profile (mobile / browser / IoT): forwards T0 + T1 only. T2/T3 willingness is permanently
 * off and an operator override cannot turn it on. An override may further narrow (e.g. to `{T0}`).
 */
export function edgeProfile(overrides?: NodeProfileOverrides): NodeProfile {
	return { kind: "edge", willingTiers: resolveWillingTiers(EDGE_BASE_TIERS, overrides) };
}

/**
 * Core profile (servers / fixed infrastructure): forwards T0–T3 by default. An operator override may
 * restrict it to a subset (e.g. `{T0, T1, T2}` to shed reactivity-push duty).
 */
export function coreProfile(overrides?: NodeProfileOverrides): NodeProfile {
	return { kind: "core", willingTiers: resolveWillingTiers(CORE_BASE_TIERS, overrides) };
}
