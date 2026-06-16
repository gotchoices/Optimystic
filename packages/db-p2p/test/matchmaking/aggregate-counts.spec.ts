import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	aggregateCountSigningPayload,
	logBucketCount,
	bytesToB64url,
	matchTopicId,
	AGGREGATE_COUNT_MINIMUM_TIER,
	type AggregateCountV1,
} from '@optimystic/db-core';
import { buildAggregateCount, type AggregateCountContext } from '../../src/matchmaking/aggregate-counts.js';

/**
 * Root-cohort aggregate-count producer (`docs/matchmaking.md` §Multi-cohort sweep / §Aggregated provider
 * counts). Crypto-free at the unit level: the threshold signer is a deterministic
 * `sha256(payload) → blob`, returning a fixed 2-member signer set. The per-shard accounting, depth, and
 * epoch are injected, so this exercises the depth gate, log-bucketing, and the threshold envelope without
 * a live promoted tree.
 */
const TOPIC_ID = matchTopicId('capability', 'pdf-render');
const EPOCH = new Uint8Array(32).fill(7);
const MEMBER_A = new TextEncoder().encode('member-a');
const MEMBER_B = new TextEncoder().encode('member-b');

const fakeThresholdSign = async (payload: Uint8Array): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> => ({
	thresholdSig: sha256(payload),
	signers: [MEMBER_A, MEMBER_B],
});

function ctx(partial: Partial<AggregateCountContext> = {}): AggregateCountContext {
	return {
		topicId: TOPIC_ID,
		cohortEpoch: EPOCH,
		treeDepth: 1,
		shardCounts: new Map<number, number>([[0, 49], [3, 100]]),
		thresholdSign: fakeThresholdSign,
		...partial,
	};
}

describe('matchmaking / aggregate-count producer — depth gate', () => {
	it('produces no aggregate when treeDepth < aggregate_count_minimum_tier (cold / unpromoted root)', async () => {
		expect(AGGREGATE_COUNT_MINIMUM_TIER).to.equal(1);
		const result = await buildAggregateCount(ctx({ treeDepth: 0 }));
		expect(result).to.equal(undefined);
	});

	it('produces an aggregate at exactly the minimum tier', async () => {
		const result = await buildAggregateCount(ctx({ treeDepth: 1 }));
		expect(result).to.not.equal(undefined);
	});

	it('honours a custom minimumTier', async () => {
		expect(await buildAggregateCount(ctx({ treeDepth: 1, minimumTier: 2 }))).to.equal(undefined);
		expect(await buildAggregateCount(ctx({ treeDepth: 2, minimumTier: 2 }))).to.not.equal(undefined);
	});
});

describe('matchmaking / aggregate-count producer — log-bucketed per-shard counts', () => {
	it('log-buckets each shard count and labels it targetTier=1 by prefixSlot', async () => {
		const result = (await buildAggregateCount(ctx())) as AggregateCountV1;
		// 49 → 32, 100 → 64 (largest power of two <= n).
		expect(result.bucketCounts).to.deep.equal([
			{ targetTier: 1, prefixSlot: 0, count: logBucketCount(49) }, // 32
			{ targetTier: 1, prefixSlot: 3, count: logBucketCount(100) }, // 64
		]);
		expect(result.bucketCounts.map((b) => b.count)).to.deep.equal([32, 64]);
	});

	it('omits empty shards by default and includes them when includeEmptyShards is set', async () => {
		const counts = new Map<number, number>([[2, 8]]);
		const omitted = (await buildAggregateCount(ctx({ shardCounts: counts, fanout: 4 }))) as AggregateCountV1;
		expect(omitted.bucketCounts.map((b) => b.prefixSlot)).to.deep.equal([2]);

		const included = (await buildAggregateCount(ctx({ shardCounts: counts, fanout: 4, includeEmptyShards: true }))) as AggregateCountV1;
		expect(included.bucketCounts.map((b) => b.prefixSlot)).to.deep.equal([0, 1, 2, 3]);
		expect(included.bucketCounts.filter((b) => b.count === 0)).to.have.length(3);
	});

	it('ranges over exactly `fanout` prefix slots', async () => {
		const counts = new Map<number, number>(Array.from({ length: 16 }, (_v, i) => [i, 1] as [number, number]));
		const result = (await buildAggregateCount(ctx({ shardCounts: counts, fanout: 16 }))) as AggregateCountV1;
		expect(result.bucketCounts).to.have.length(16);
		expect(result.bucketCounts.every((b) => b.count === 1)).to.equal(true);
	});
});

describe('matchmaking / aggregate-count producer — threshold envelope', () => {
	it('threshold-signs the canonical image and carries the signer set + epoch + topicId', async () => {
		const result = (await buildAggregateCount(ctx())) as AggregateCountV1;
		expect(result.topicId).to.equal(bytesToB64url(TOPIC_ID));
		expect(result.cohortEpoch).to.equal(bytesToB64url(EPOCH));
		expect(result.signers).to.deep.equal([bytesToB64url(MEMBER_A), bytesToB64url(MEMBER_B)]);

		// The signature blob is the threshold-sign over the canonical aggregate image (sans envelope).
		const unsigned = { v: 1 as const, topicId: result.topicId, bucketCounts: result.bucketCounts, cohortEpoch: result.cohortEpoch };
		expect(result.signature).to.equal(bytesToB64url(sha256(aggregateCountSigningPayload(unsigned))));
	});

	it('signs an order-independent image (bucket emission order does not change the signature)', async () => {
		const a = (await buildAggregateCount(ctx({ shardCounts: new Map([[0, 4], [3, 8]]) }))) as AggregateCountV1;
		const b = (await buildAggregateCount(ctx({ shardCounts: new Map([[3, 8], [0, 4]]) }))) as AggregateCountV1;
		expect(a.signature).to.equal(b.signature);
	});
});
