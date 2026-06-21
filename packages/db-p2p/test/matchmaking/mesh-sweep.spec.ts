/**
 * Matchmaking **mock-tier e2e — multi-cohort sweep** (`docs/matchmaking.md` §Multi-cohort sweep /
 * §Aggregated provider counts).
 *
 * Binds the db-core sweep ports ({@link runMultiCohortSweep}) to the real substrate over the matchmaking
 * mesh: the root aggregate is produced by the real {@link buildAggregateCount} (depth-gated +
 * log-bucketed + threshold-signed) from the real tier-0 provider population, shard queries are served by
 * the real cohort `QueryV1` handler over real records, and every swept entry is re-validated with the
 * real `verifyProviderEntry`. This is exactly the "binds these ports" gap the
 * `matchmaking-sweep-adversarial-module` review deferred to this ticket.
 *
 * **Single-cohort modeling (honest).** The substrate serves one tier-0 cohort, so the sweep ranges over a
 * single modeled tier-1 shard (prefix slot 0) backed by that cohort's real records, and the
 * `thresholdSign` is a deterministic stand-in (real `k − x` threshold assembly over a promoted root is
 * the cohort-topic follow-on). The *consumer↔producer↔real-records* integration is real; the multi-shard
 * topology and threshold crypto are modeled — the same posture as `aggregate-counts.spec.ts`.
 */

import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	buildAggregateCount,
} from '../../src/matchmaking/aggregate-counts.js';
import {
	runMultiCohortSweep,
	logBucketCount,
	type MultiCohortSweepPorts,
	type ProviderEntryV1,
	type SweepShardQuery,
} from '@optimystic/db-core';
import { buildMatchmakingMesh, type MatchmakingMesh } from '../../src/testing/matchmaking-mesh-harness.js';

const KIND = 'quorum';
const LABEL = 'proposal-0xabc';

/** A deterministic threshold-sign stand-in (real cohort `k − x` assembly is the cohort-topic follow-on). */
function fakeThresholdSign(mm: MatchmakingMesh): (payload: Uint8Array) => Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> {
	return async (payload: Uint8Array) => ({ thresholdSig: sha256(payload), signers: [mm.members[0]!.bytes, mm.members[1]!.bytes] });
}

/** Build sweep ports backed by the topic's real tier-0 records (modeled as a single tier-1 shard). */
function realRecordSweepPorts(mm: MatchmakingMesh, requesterIndex: number, opts: { treeDepth?: number; extraEntries?: ProviderEntryV1[] } = {}): MultiCohortSweepPorts {
	const topicId = mm.topicId(KIND, LABEL);
	return {
		async fetchAggregate() {
			const providerCount = mm.cohortRecords(KIND, LABEL).filter((r) => r.appState !== undefined).length;
			return buildAggregateCount({
				topicId,
				cohortEpoch: mm.cohortEpochFor(KIND, LABEL),
				treeDepth: opts.treeDepth ?? 1,
				shardCounts: new Map<number, number>([[0, providerCount]]),
				thresholdSign: fakeThresholdSign(mm),
			});
		},
		async queryShard(_shard: SweepShardQuery) {
			const real = await mm.providerEntries(requesterIndex, KIND, LABEL);
			return [...real, ...(opts.extraEntries ?? [])];
		},
	};
}

describe('matchmaking / mesh — multi-cohort sweep over real records', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound and run several seconds; give
	// generous headroom over the 10s default so machine load doesn't tip a passing test into a timeout.
	this.timeout(30_000);
	let mm: MatchmakingMesh;
	afterEach(async () => {
		await mm?.stop();
	});

	it('unions the real swept provider set, re-validating every entry against its real peer key', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 12 });
		await mm.registerTopic(KIND, LABEL);
		for (let i = 0; i < 8; i++) {
			await mm.provide(i, KIND, LABEL, ['eligible'], 4);
		}
		const result = await runMultiCohortSweep(realRecordSweepPorts(mm, 10), { topicId: mm.topicId(KIND, LABEL), wantCount: 8, verifyEntry: mm.verifyEntry });

		expect(result.aggregateAvailable, 'the promoted root produced an aggregate').to.equal(true);
		expect(result.shardsQueried, 'queried the elected high-population shard').to.equal(1);
		expect(result.providers.length, 'all 8 real providers unioned').to.equal(8);
		expect(result.providers.every((e) => mm.verifyEntryFor(mm.topicId(KIND, LABEL), e)), 'every swept entry re-validated for real').to.equal(true);
	});

	it('a cold/unpromoted root (treeDepth < aggregate_count_minimum_tier) produces no aggregate — the sweep falls back to empty', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 8 });
		await mm.registerTopic(KIND, LABEL);
		for (let i = 0; i < 3; i++) {
			await mm.provide(i, KIND, LABEL, ['eligible'], 4);
		}
		const result = await runMultiCohortSweep(realRecordSweepPorts(mm, 6, { treeDepth: 0 }), { topicId: mm.topicId(KIND, LABEL), wantCount: 3, verifyEntry: mm.verifyEntry });
		expect(result.aggregateAvailable).to.equal(false);
		expect(result.providers).to.deep.equal([]);
	});

	it('the aggregate log-buckets the real population (the producer rounds down, so selection over-provisions)', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 14 });
		await mm.registerTopic(KIND, LABEL);
		for (let i = 0; i < 5; i++) {
			await mm.provide(i, KIND, LABEL, ['eligible'], 4);
		}
		const ports = realRecordSweepPorts(mm, 12);
		const aggregate = await ports.fetchAggregate();
		// 5 real providers → log-bucketed to 4 (largest power of two ≤ 5) — never the exact count.
		expect(aggregate!.bucketCounts).to.deep.equal([{ targetTier: 1, prefixSlot: 0, count: logBucketCount(5) }]);
		expect(aggregate!.bucketCounts[0]!.count).to.equal(4);
		// The sweep still unions the full real shard (over-provision: real population ≥ the bucketed sum).
		const result = await runMultiCohortSweep(ports, { topicId: mm.topicId(KIND, LABEL), wantCount: 5, verifyEntry: mm.verifyEntry });
		expect(result.providers.length).to.equal(5);
	});

	it('a forged entry injected into a shard reply is dropped by the sweep re-validation (lying primary buys nothing)', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 10 });
		await mm.registerTopic(KIND, LABEL);
		for (let i = 0; i < 3; i++) {
			await mm.provide(i, KIND, LABEL, ['eligible'], 4);
		}
		// A real provider entry tampered after signing (budget bumped) — its registrationSig no longer
		// matches the reconstructed signing image, so the sweep must discard it.
		const real = await mm.providerEntries(8, KIND, LABEL);
		const forged: ProviderEntryV1 = { ...real[0]!, capacityBudget: 999 };
		const ports = realRecordSweepPorts(mm, 8, { extraEntries: [forged] });
		const result = await runMultiCohortSweep(ports, { topicId: mm.topicId(KIND, LABEL), wantCount: 8, verifyEntry: mm.verifyEntry });
		expect(result.providers.some((e) => e.capacityBudget === 999), 'the forged entry was rejected').to.equal(false);
		expect(result.providers.length, 'only the 3 authentic providers survive (forgery deduped+rejected)').to.equal(3);
	});
});
