/**
 * Matchmaking — root-cohort aggregate-count producer (db-p2p, wires the substrate to the sweep summary).
 *
 * `docs/matchmaking.md` §Multi-cohort sweep / §Aggregated provider counts. A *promoted* topic's root
 * cohort answers a sweeping seeker with an {@link AggregateCountV1}: log-bucketed provider counts per
 * tier-1 prefix shard, **threshold-signed** (an attested *registered*-provider count — unlike the
 * advisory, single-member-signed `QueryReplyV1`). This module is the thin db-p2p binding that builds
 * that message from the root's per-shard accounting and the cohort threshold signer.
 *
 * Two invariants the doc mandates, enforced here:
 *
 *  - **Depth gate.** The aggregate is produced **only** when the tree depth at this cohort is
 *    `>= aggregate_count_minimum_tier` (default 1). A cold cohort that fell through to `NoState` has no
 *    tier-1 children to summarize, so {@link buildAggregateCount} returns `undefined` and the seeker
 *    falls back to the single-cohort sample.
 *  - **Log-bucketing.** Raw per-shard counts are quantized through the db-core {@link logBucketCount}
 *    (largest power of two `<= n`), never forwarded exactly.
 *
 * Like the cohort query handler, the inputs are injected (records/accounting, epoch, depth, the threshold
 * signer), so this unit-tests without a live FRET/libp2p stack — the mock-tier e2e that drives it from a
 * real promoted root is a documented follow-on. In the FRET host the root `CoordEngine` supplies
 * `shardCounts` from its child-cohort accounting (the per-tier-1 `childCohortCount` / gossip-derived
 * summaries), `treeDepth` from its tier state, `cohortEpoch` from the membership, and `thresholdSign`
 * bound to the cohort signer's `/sign` assembly.
 */

import {
	bytesToB64url,
	logBucketCount,
	aggregateCountSigningPayload,
	AGGREGATE_COUNT_MINIMUM_TIER,
	DEFAULT_FANOUT,
	DEFAULT_SWEEP_TARGET_TIER,
	type AggregateBucketV1,
	type AggregateCountV1,
} from "@optimystic/db-core";

/** Everything {@link buildAggregateCount} needs from the root cohort, all injected. */
export interface AggregateCountContext {
	/** The topic id being summarized, 32 bytes. */
	readonly topicId: Uint8Array;
	/** The current cohort epoch, 32 bytes. */
	readonly cohortEpoch: Uint8Array;
	/**
	 * Tree depth at this cohort. The aggregate is produced only when `treeDepth >= minimumTier`; a cold
	 * cohort (depth 0) summarizes nothing.
	 */
	readonly treeDepth: number;
	/**
	 * Raw per-tier-1-shard provider counts, keyed by `prefixSlot` (`0..fanout-1`). Slots absent from the
	 * map count as `0`. The root derives these from its child-cohort accounting; this binding log-buckets
	 * them and never trusts the caller to pre-bucket.
	 */
	readonly shardCounts: ReadonlyMap<number, number>;
	/**
	 * Assemble a cohort threshold signature over the canonical aggregate image (db-p2p binds the cohort
	 * signer). Returns the multisig blob plus the `>= minSigs` signer subset that produced it.
	 */
	readonly thresholdSign: (payload: Uint8Array) => Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }>;
	/** The tier whose shards are summarized. Default {@link DEFAULT_SWEEP_TARGET_TIER} (1). */
	readonly targetTier?: number;
	/** Number of prefix slots `F`. Default {@link DEFAULT_FANOUT} (16). */
	readonly fanout?: number;
	/** Depth gate. Default {@link AGGREGATE_COUNT_MINIMUM_TIER} (1). */
	readonly minimumTier?: number;
	/** Emit zero-count shards too (default `false` — empty shards are omitted to keep the summary compact). */
	readonly includeEmptyShards?: boolean;
}

/**
 * Build the threshold-signed {@link AggregateCountV1} for the root's per-shard accounting, or `undefined`
 * when the depth gate is not met (`treeDepth < minimumTier`). Counts are log-bucketed; the canonical
 * image is order-independent (the signing payload sorts buckets), so signer and verifier agree.
 */
export async function buildAggregateCount(ctx: AggregateCountContext): Promise<AggregateCountV1 | undefined> {
	const minimumTier = ctx.minimumTier ?? AGGREGATE_COUNT_MINIMUM_TIER;
	if (ctx.treeDepth < minimumTier) {
		// Cold / unpromoted root: no tier-1 children to summarize (matches the seeker's NoState fallback).
		return undefined;
	}

	const targetTier = ctx.targetTier ?? DEFAULT_SWEEP_TARGET_TIER;
	const fanout = ctx.fanout ?? DEFAULT_FANOUT;
	const bucketCounts: AggregateBucketV1[] = [];
	for (let prefixSlot = 0; prefixSlot < fanout; prefixSlot++) {
		const count = logBucketCount(ctx.shardCounts.get(prefixSlot) ?? 0);
		if (count > 0 || ctx.includeEmptyShards === true) {
			bucketCounts.push({ targetTier, prefixSlot, count });
		}
	}

	const unsigned: Omit<AggregateCountV1, "signature" | "signers"> = {
		v: 1,
		topicId: bytesToB64url(ctx.topicId),
		bucketCounts,
		cohortEpoch: bytesToB64url(ctx.cohortEpoch),
	};
	const { thresholdSig, signers } = await ctx.thresholdSign(aggregateCountSigningPayload(unsigned));
	return {
		...unsigned,
		signature: bytesToB64url(thresholdSig),
		signers: signers.map(bytesToB64url),
	};
}
