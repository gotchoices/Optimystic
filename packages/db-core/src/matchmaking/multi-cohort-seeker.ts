/**
 * Matchmaking — multi-cohort sweep (db-core, pure orchestration of the hot-topic representative sample).
 *
 * Per `docs/matchmaking.md` §Multi-cohort sweep. When a topic is hot enough that its providers live
 * across many tier-`d >= 1` cohorts, a seeker that wants a *representative* cross-ring sample (rather
 * than the prefix-biased single-cohort slice) does:
 *
 *  1. Registers at its natural tier as usual (the single-cohort {@link import("./seeker-walk.js").decide}
 *     walk — not this module).
 *  2. Queries the **root** cohort, which returns an {@link AggregateCountV1}: log-bucketed provider counts
 *     per tier-1 prefix shard, **threshold-signed**. A cold root that fell through to `NoState` produces
 *     no aggregate (the producer gates on tree depth — see `db-p2p/matchmaking/aggregate-counts.ts`).
 *  3. Selects the high-population tier-1 shards ({@link selectShards}) and queries them directly, unioning
 *     the returned providers into a deduped, re-validated set.
 *
 * This module is **pure**: the root-aggregate fetch, the per-shard query, and the optional threshold-sig
 * verification are injected as a {@link MultiCohortSweepPorts} port (db-p2p binds them to the matchmaking
 * query RPCs), exactly like the single-cohort walk splits pure `decide` (here) from the db-p2p walk
 * client. The advisory trust model is preserved end-to-end: every shard entry is re-validated with
 * {@link verifyProviderEntry} before it counts, so a lying shard primary buys nothing.
 *
 * The sweep costs more RPCs than the single-cohort sample and is reserved for representativeness-over-
 * latency use cases (voting quorums, capability fairness audits); db-p2p binds it to the voting
 * `QuorumDiscovery.sweep` port.
 */

import { matchesFilter } from "./capability-filter.js";
import { verifyProviderEntry, type AggregateCountV1, type CapabilityFilter, type EntrySigVerifier, type ProviderEntryV1 } from "./wire.js";

/** The tier whose prefix shards the sweep ranges over (`docs/matchmaking.md` §Wire formats — typically 1). */
export const DEFAULT_SWEEP_TARGET_TIER = 1;
/** Fan-out ceiling: never query more than this many shards in one sweep (bounds RPC cost). */
export const DEFAULT_SWEEP_MAX_SHARDS = 16;
/**
 * Multiplier on `wantCount` when accumulating bucketed shard populations. `1` because {@link logBucketCount}
 * already rounds counts *down* — the true population is `>=` the reported sum, so the selection already
 * over-provisions without an extra factor.
 */
export const DEFAULT_SWEEP_OVERPROVISION = 1;

/** One tier-1 prefix shard the sweep elected to query, with its (bucketed) reported population. */
export interface ShardSelection {
	/** Prefix slot `0..F-1` identifying the tier-1 cohort. */
	readonly prefixSlot: number;
	/** The tier whose shard this is (typically 1). */
	readonly targetTier: number;
	/** The shard's log-bucketed reported provider count (rounds down — see {@link logBucketCount}). */
	readonly bucketedCount: number;
}

/** Inputs to {@link selectShards}. */
export interface SelectShardsOptions {
	/** Providers the seeker needs (drives how many shards are unioned). */
	readonly wantCount: number;
	/** Which `targetTier` buckets to consider. Default {@link DEFAULT_SWEEP_TARGET_TIER}. */
	readonly targetTier?: number;
	/** Fan-out ceiling. Default {@link DEFAULT_SWEEP_MAX_SHARDS}. */
	readonly maxShards?: number;
	/** Multiplier on `wantCount`. Default {@link DEFAULT_SWEEP_OVERPROVISION}. */
	readonly overprovision?: number;
}

/**
 * Choose which tier-1 shards to query from an {@link AggregateCountV1}: the highest-population shards
 * first (ties broken by ascending `prefixSlot` for determinism), accumulating bucketed counts until they
 * cover `wantCount * overprovision`, capped at `maxShards`. Empty shards (`count === 0`) are skipped.
 * Pure and deterministic.
 */
export function selectShards(aggregate: AggregateCountV1, opts: SelectShardsOptions): ShardSelection[] {
	const targetTier = opts.targetTier ?? DEFAULT_SWEEP_TARGET_TIER;
	const maxShards = opts.maxShards ?? DEFAULT_SWEEP_MAX_SHARDS;
	const overprovision = opts.overprovision ?? DEFAULT_SWEEP_OVERPROVISION;
	const need = Math.max(1, Math.ceil(opts.wantCount * overprovision));

	const ranked = aggregate.bucketCounts
		.filter((b) => b.targetTier === targetTier && b.count > 0)
		.sort((a, b) => b.count - a.count || a.prefixSlot - b.prefixSlot);

	const selected: ShardSelection[] = [];
	let cumulative = 0;
	for (const bucket of ranked) {
		if (selected.length >= maxShards) {
			break;
		}
		selected.push({ prefixSlot: bucket.prefixSlot, targetTier: bucket.targetTier, bucketedCount: bucket.count });
		cumulative += bucket.count;
		if (cumulative >= need) {
			break;
		}
	}
	return selected;
}

/** Identifies one tier shard to query directly (db-p2p resolves it to `coord_d` and dials the cohort). */
export interface SweepShardQuery {
	readonly prefixSlot: number;
	readonly targetTier: number;
}

/**
 * The transport seam the sweep drives, injected by db-p2p. `fetchAggregate` queries the root cohort
 * (resolving `undefined` when the root is cold / unpromoted and returns no {@link AggregateCountV1});
 * `queryShard` queries one elected tier-1 cohort; `verifyAggregate` (optional) threshold-verifies the
 * aggregate before its counts are trusted.
 */
export interface MultiCohortSweepPorts {
	/** Query the root cohort for the aggregate; `undefined` when the root produced none (cold / unpromoted). */
	fetchAggregate(): Promise<AggregateCountV1 | undefined>;
	/** Threshold-verify the aggregate (db-p2p binds the cohort crypto). Omitted → trusted unconditionally. */
	verifyAggregate?(aggregate: AggregateCountV1): boolean;
	/** Query one elected shard; returns its advisory provider entries (the sweep re-validates each). */
	queryShard(shard: SweepShardQuery): Promise<readonly ProviderEntryV1[]>;
}

/** Inputs to {@link runMultiCohortSweep}. */
export interface MultiCohortSweepOptions {
	/** The matchmaking topic id (used to re-validate each forwarded entry's `registrationSig`). */
	readonly topicId: Uint8Array;
	/** Providers the seeker needs (drives shard selection). */
	readonly wantCount: number;
	/** Per-entry signature verifier (db-p2p binds `verifyPeerSig`). */
	readonly verifyEntry: EntrySigVerifier;
	/** Optional capability filter, re-applied over every shard's returned set. */
	readonly filter?: CapabilityFilter;
	/** Which `targetTier` shards to range over. Default {@link DEFAULT_SWEEP_TARGET_TIER}. */
	readonly targetTier?: number;
	/** Fan-out ceiling. Default {@link DEFAULT_SWEEP_MAX_SHARDS}. */
	readonly maxShards?: number;
	/** Multiplier on `wantCount`. Default {@link DEFAULT_SWEEP_OVERPROVISION}. */
	readonly overprovision?: number;
}

/** The assembled result of a multi-cohort sweep. */
export interface MultiCohortSweepResult {
	/** The unioned, filtered, `registrationSig`-re-validated providers, deduped by `participantId`. */
	readonly providers: ProviderEntryV1[];
	/** The shards selected from the aggregate (empty when no aggregate / untrusted). */
	readonly selectedShards: ShardSelection[];
	/** How many shards were actually queried (== `selectedShards.length` on success). */
	readonly shardsQueried: number;
	/** Whether the root produced an aggregate at all (`false` for a cold / unpromoted root). */
	readonly aggregateAvailable: boolean;
	/** Whether the aggregate's threshold signature verified (`false` when absent or invalid). */
	readonly aggregateTrusted: boolean;
}

/** An empty result (no aggregate, or an aggregate that failed verification). */
function emptyResult(aggregateAvailable: boolean, aggregateTrusted: boolean): MultiCohortSweepResult {
	return { providers: [], selectedShards: [], shardsQueried: 0, aggregateAvailable, aggregateTrusted };
}

/**
 * Run the multi-cohort sweep (`docs/matchmaking.md` §Multi-cohort sweep): fetch the root aggregate,
 * threshold-verify it, select high-population shards, query each, and union the deduped + re-validated
 * providers. A cold root (no aggregate) or an aggregate that fails verification yields an empty set so
 * the caller falls back to the single-cohort sample. Each shard entry is filtered and
 * `registrationSig`-re-validated before it counts — the cohort vouches only for "the set I held".
 */
export async function runMultiCohortSweep(ports: MultiCohortSweepPorts, opts: MultiCohortSweepOptions): Promise<MultiCohortSweepResult> {
	const aggregate = await ports.fetchAggregate();
	if (aggregate === undefined) {
		return emptyResult(false, false);
	}
	// `aggregateTrusted` is asserted only when a verifier actually ran and passed. With no verifier injected
	// the sweep still proceeds — every shard entry is `registrationSig`-re-validated below, so a forged
	// aggregate can at worst mis-steer shard selection (wasted RPCs / a thinner sample), never inject
	// providers — but the flag stays honest rather than claiming a trust that was never established.
	const aggregateTrusted = ports.verifyAggregate !== undefined;
	if (ports.verifyAggregate !== undefined && !ports.verifyAggregate(aggregate)) {
		return emptyResult(true, false);
	}

	const selectShardOpts: SelectShardsOptions = { wantCount: opts.wantCount };
	if (opts.targetTier !== undefined) {
		(selectShardOpts as { targetTier: number }).targetTier = opts.targetTier;
	}
	if (opts.maxShards !== undefined) {
		(selectShardOpts as { maxShards: number }).maxShards = opts.maxShards;
	}
	if (opts.overprovision !== undefined) {
		(selectShardOpts as { overprovision: number }).overprovision = opts.overprovision;
	}
	const selected = selectShards(aggregate, selectShardOpts);

	const matched = new Map<string, ProviderEntryV1>();
	let shardsQueried = 0;
	for (const shard of selected) {
		const entries = await ports.queryShard({ prefixSlot: shard.prefixSlot, targetTier: shard.targetTier });
		shardsQueried++;
		for (const entry of entries) {
			if (!matchesFilter(entry, opts.filter)) {
				continue;
			}
			if (!verifyProviderEntry(opts.topicId, entry, opts.verifyEntry)) {
				continue;
			}
			matched.set(entry.participantId, entry);
		}
	}

	return {
		providers: [...matched.values()],
		selectedShards: selected,
		shardsQueried,
		aggregateAvailable: true,
		aggregateTrusted,
	};
}
